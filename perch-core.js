// perch-core.js — in-process Perchance editor controller.
//
// Lives inside the perch MCP server process (same model @playwright/mcp uses):
// no TCP daemon, no per-call spawn.
//
// Design notes:
//   * Preview-frame resolution. The running generator is the subframe
//     #outputIframeEl. Resolve it by iframe id, then by the perchance
//     subdomain URL, then by any live non-blank child frame. Never compare
//     an ElementHandle's `.id` — it is always undefined.
//   * Cloudflare: stealth launch args + init script, and a 4-step escalation
//     ladder (reuse ctx -> new ctx -> relaunch browser -> relaunch headed).
//     CF flagging is intermittent, so the ladder is what makes it reliable.
//   * Browser-free code access: `pull()` fetches modelText + outputTemplate
//     straight from the public API via curl (~1.2s, no CF risk) and writes
//     local mirror files, so reading/grepping code needs no browser at all.
//   * Diagnostics: console + pageerror buffers captured from every frame.
//   * UI testing by text: `snapshot()` lists interactive elements in the live
//     preview so an agent can drive the UI without screenshots.
//   * engine option: 'chromium' (playwright) | 'patchright' (stealth driver).
//     patchright runs with ITS OWN recommended config (no custom UA, no JS
//     fingerprint injection, no extra flags) and needs two adaptations:
//     - every evaluate that must see page-set globals passes
//       isolatedContext:false (patchright defaults to an isolated world);
//     - console/pageerror events never fire under patchright (Console API is
//       disabled there), so diagnostics come from an in-page hook instead.
//
// NOTE ON eval(): the `evaluate(...)` calls below are a browser JS-expression
// evaluator — that IS the feature (perch_eval / perch_type drive the live
// generator under test). The "eval_injection" lint hit is expected here.

const path = require('path');
const fs = require('fs');

// UA for the browser-free curl path only. The live browser path derives its
// UA from the actual binary version (see _launch) so the UA string can never
// contradict the client-hints headers the browser itself sends.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IDLE_MS = 20 * 60 * 1000;
const MIRROR_ROOT = path.join(__dirname, '.perch-mirror');
// Locale/timezone are fingerprint inputs for the CF risk score; keep them
// consistent with the UA above and overridable by the caller.
const LOCALE = 'en-US';
const TIMEZONE = 'UTC';

// Reduce the automation fingerprint. Cloudflare scores navigator.webdriver +
// CDP artifacts; the init script handles the JS side, these flags the process.
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-default-browser-check',
  '--no-first-run',
  '--disable-infobars',
  '--disable-features=IsolateOrigins,site-per-process',
];

const STEALTH_INIT = () => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
  } catch (e) {}
};

// patchright evaluates in an ISOLATED world by default (that is how it avoids
// Runtime.enable), where page-set globals are invisible. Its extended
// signature takes isolatedContext as the 4th parameter; plain playwright has
// exactly (fn, arg) and rejects extra args, so the call shape depends on the
// loaded driver (EVAL_EXTENDED, set by loadChromium). Use evalMain for EVERY
// evaluate that touches page globals or must behave like page-side JS.
function evalMain(target, fn, arg) {
  return EVAL_EXTENDED
    ? target.evaluate(fn, arg, undefined, false)
    : target.evaluate(fn, arg);
}

// Default UA template per host OS (no fingerprint injection — this only
// exists to strip the "Headless" marker in headless mode, keeping the REAL
// browser version so UA and client hints always agree).
function platformUaPrefix() {
  switch (process.platform) {
    case 'darwin': return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
    case 'linux': return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)';
    default: return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)';
  }
}

// In-page diagnostics hook, installed via addInitScript (main world) ONLY
// under patchright, where the driver-level Console API is disabled and
// page.on('console')/page.on('pageerror') never fire. Buffers console output
// and uncaught errors per frame; the Node side drains the buffers on a timer
// (see _drainPageDiag). Must stay self-contained and never throw.
const DIAG_HOOK = () => {
  try {
    if (window.__perchDiagInstalled) return;
    Object.defineProperty(window, '__perchDiagInstalled', { value: true });
    const buf = [];
    const MAX = 250;
    const push = (type, text) => {
      try {
        buf.push({ type, text: String(text).slice(0, 500) });
        if (buf.length > MAX) buf.splice(0, buf.length - MAX);
      } catch (e) {}
    };
    const fmt = (args) => {
      try {
        return Array.prototype.map.call(args, a => {
          if (a instanceof Error) return (a.stack || a.message || String(a));
          if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch (e) { return String(a); } }
          return String(a);
        }).join(' ');
      } catch (e) { return ''; }
    };
    ['log', 'info', 'warn', 'error'].forEach(level => {
      const orig = console[level] ? console[level].bind(console) : null;
      console[level] = function () {
        try { push(level === 'warn' ? 'warning' : level, fmt(arguments)); } catch (e) {}
        if (orig) orig.apply(null, arguments);
      };
    });
    window.addEventListener('error', e => { push('pageerror', (e && e.message) || String(e)); });
    window.addEventListener('unhandledrejection', e => {
      const r = e && e.reason;
      push('unhandledrejection', (r && (r.stack || r.message)) ? String(r.stack || r.message) : String(r));
    });
    window.__perchDiagDrain = () => { try { return buf.splice(0, buf.length); } catch (e) { return []; } };
  } catch (e) {}
};

const _engineCache = {};
// Whether the ACTIVE driver understands patchright's extended evaluate
// signature (4th param isolatedContext). Plain playwright's evaluate accepts
// exactly (fn, arg) and hard-rejects extra args, so every evaluate must go
// through evalMain, which picks the right call shape. Set by loadChromium on
// every launch — the active driver is always the one the page was created
// with (single PerchSession per server process, launched before any eval).
let EVAL_EXTENDED = false;
function loadChromium(engine) {
  const key = engine === 'patchright' ? 'patchright' : 'playwright';
  if (_engineCache[key]) { EVAL_EXTENDED = _engineCache[key].extended; return _engineCache[key]; }
  let mod, fallback = false;
  if (key === 'patchright') {
    try { mod = require('patchright'); } catch { mod = require('playwright'); fallback = true; }
  } else {
    mod = require('playwright');
  }
  if (fallback) {
    // Loud, not silent: a missing optional dependency must never leave the
    // session reporting an engine it is not actually running.
    try { console.error('perch-mcp: patchright is not installed — running plain playwright for engine "patchright".'); } catch (e) {}
  }
  const extended = key === 'patchright' && !fallback;
  EVAL_EXTENDED = extended;
  _engineCache[key] = { chromium: mod.chromium, fallback, extended };
  return _engineCache[key];
}

function buildEditorUrl(name, collabKey) {
  const base = `https://perchance.org/${name}`;
  return collabKey ? `${base}#edit:collab=${collabKey}` : `${base}#edit`;
}

// Detect a Cloudflare Turnstile / "Just a moment" interstitial.
// NOTE: do NOT match the bare word "cloudflare" in page text — perchance.org
// is behind Cloudflare and references it in its own HTML. Match the
// interstitial's structural signals instead.
async function isCfBlocked(page) {
  try {
    return await evalMain(page, () => {
      const t = (document.body && document.body.innerText || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      const hasTurnstile = document.querySelector(
        '#cf-turnstile, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]') !== null;
      return hasTurnstile ||
        title.includes('just a moment') ||
        t.includes('just a moment') ||
        t.includes('performing security verification') ||
        t.includes('verifying you are human') ||
        t.includes('checking your browser') ||
        t.includes('verify you are human');
    });
  } catch { return true; }
}

class PerchSession {
  constructor() {
    this.browser = null;
    this.ctx = null;
    this.page = null;
    this.generator = null;
    this.collabKey = null;
    this.headed = null;      // true = visible window
    this.engine = 'chromium';
    this.effectiveEngine = null; // what is actually running (channel / fallback)
    this._usingPatchright = false;
    this.ready = false;
    this.last = Date.now();
    this._idle = null;
    this._diagDrain = null;
    this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
  }

  _touch() { this.last = Date.now(); }

  _ensureIdle() {
    if (this._idle) return;
    this._idle = setInterval(() => {
      if (this.ctx && Date.now() - this.last > IDLE_MS) {
        this.stop().catch(() => {});
      }
    }, 30000);
    this._idle.unref();
  }

  // ---------------- diagnostics (console + runtime errors) ----------------
  _pushDiag(arr, droppedKey, entry, cap = 300) {
    arr.push(entry);
    if (arr.length > cap) { arr.shift(); this.diag[droppedKey]++; }
  }

  _attachDiagnostics(page) {
    this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    const push = (arr, droppedKey, entry, cap = 300) => this._pushDiag(arr, droppedKey, entry, cap);
    try {
      page.on('console', (msg) => {
        const type = msg.type();
        if (type === 'debug') return;
        const loc = msg.location() || {};
        push(this.diag.console, 'droppedConsole',
          `[${type}] ${msg.text()}${loc.url ? ' @ ' + String(loc.url).slice(-60) + ':' + loc.lineNumber : ''}`);
      });
      page.on('pageerror', (err) => {
        push(this.diag.errors, 'droppedErrors', (err && err.message) ? err.message : String(err));
      });
      page.on('requestfailed', (req) => {
        const url = req.url() || '';
        if (/\.(woff2?|png|jpe?g|svg|gif|ico)(\?|$)/i.test(url)) return;
        const f = req.failure();
        push(this.diag.console, 'droppedConsole', `[net-fail] ${url.slice(0, 120)} — ${f ? f.errorText : 'unknown'}`);
      });
    } catch (e) {}
    // Under patchright the two listeners above never fire (Console API is
    // disabled driver-side) — the in-page hook + timer below is the source.
    this._startDiagDrain();
  }

  _startDiagDrain() {
    this._stopDiagDrain();
    if (this.engine !== 'patchright' || !EVAL_EXTENDED) return;
    this._diagDrain = setInterval(() => { this._drainPageDiag().catch(() => {}); }, 700);
    this._diagDrain.unref();
  }

  _stopDiagDrain() {
    if (this._diagDrain) { clearInterval(this._diagDrain); this._diagDrain = null; }
  }

  // Pull buffered console/pageerror entries out of every frame's in-page hook
  // buffer (patchright only; the hook is not installed on other engines).
  async _drainPageDiag() {
    if (!EVAL_EXTENDED || !this.page) return;
    for (const f of this.page.frames()) {
      let entries = null;
      try {
        entries = await f.evaluate(() => (window.__perchDiagDrain ? window.__perchDiagDrain() : []), undefined, undefined, false);
      } catch { continue; }
      if (!entries || !entries.length) continue;
      for (const en of entries) {
        if (!en || !en.type) continue;
        if (en.type === 'pageerror' || en.type === 'unhandledrejection') {
          this._pushDiag(this.diag.errors, 'droppedErrors', `[${en.type}] ${en.text}`);
        } else {
          this._pushDiag(this.diag.console, 'droppedConsole', `[${en.type}] ${en.text}`);
        }
      }
    }
  }

  async errors({ clear = false } = {}) {
    await this._drainPageDiag().catch(() => {});
    const syntax = this.page
      ? await evalMain(this.page, () => {
          try { return window.getEditorSyntaxErrors ? window.getEditorSyntaxErrors() : null; } catch (e) { return 'err:' + e.message; }
        }).catch(() => null)
      : null;
    const out = {
      ok: true,
      syntaxErrors: syntax,
      runtimeErrors: this.diag.errors.slice(-50),
      consoleTail: this.diag.console.slice(-50),
      droppedConsole: this.diag.droppedConsole,
      droppedErrors: this.diag.droppedErrors,
    };
    if (clear) this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    return out;
  }

  // Poll until the Yjs provider has flushed the pending edit to the server.
  async settle(timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      this._touch();
      let s = null;
      try {
        s = await evalMain(this.page, () => ({
          synced: !!(window.yjsProvider && window.yjsProvider.synced),
          save: window.perchanceSaveState || null,
        }));
      } catch { break; }
      if (s && s.synced && s.save !== 'saving') return true;
      await this.page.waitForTimeout(300);
    }
    return false;
  }

  // Resolve a target frame.
  //   'editor'  -> the Perchance editor page itself (chrome: editors, buttons)
  //   'preview' -> the running generator (the outputIframeEl subframe)
  //
  // v2 bug: `f.frameElement()` returns an ElementHandle, whose `.id` is always
  // undefined, so the id test never matched and the code fell through to the
  // LAST child frame — normally a chrome-error or about:blank frame.
  async _frame(which) {
    if (which === 'editor') return this.page;
    const frames = this.page.frames();
    for (const f of frames) {
      if (f === this.page.mainFrame()) continue;
      let id = null;
      try {
        const el = await f.frameElement();
        if (el) id = await el.getAttribute('id');
      } catch {}
      if (id === 'outputIframeEl') return f;
    }
    // 2) the preview runs on a per-user perchance subdomain
    for (const f of frames) {
      let url = '';
      try { url = f.url(); } catch {}
      if (/^https:\/\/[0-9a-f]{16,}\.perchance\.org\//.test(url)) return f;
    }
    // 3) last resort: any live, non-blank, non-console child frame
    const kids = frames.filter(f => {
      try {
        const u = f.url();
        return f.parentFrame() && u && u !== 'about:blank' &&
          !u.startsWith('chrome-error') && f.name() !== 'console-output';
      } catch { return false; }
    });
    if (kids.length) return kids[kids.length - 1];
    throw new Error('preview iframe not found (preview not loaded?)');
  }

  async _newContext(width, height) {
    const opts = { viewport: { width, height } };
    if (this._usingPatchright) {
      // Patchright best practice: no custom UA/headers, no locale/timezone or
      // JS fingerprint injection — the driver's own patches are the stealth.
      // ONE exception: in headless the default UA advertises "Headless" —
      // override it with the real version string of the running binary so UA
      // and client-hint headers never contradict each other.
      if (this.browser && this.headed === false) {
        const real = String(this.browser.version() || '');
        if (real) opts.userAgent = platformUaPrefix() + ' Chrome/' + real + ' Safari/537.36';
      }
      const ctx = await this.browser.newContext(opts);
      await ctx.addInitScript(DIAG_HOOK);
      return ctx;
    }
    if (this.browser && this.headed === false) {
      // Headless default UA contains the "Headless" marker; replace it with
      // the real binary version (the old hardcoded version drifted from the
      // actual browser and contradicted the client-hint headers).
      const real = String(this.browser.version() || '');
      if (real) opts.userAgent = platformUaPrefix() + ' Chrome/' + real + ' Safari/537.36';
      else opts.userAgent = UA;
    }
    opts.locale = LOCALE;
    opts.timezoneId = TIMEZONE;
    const ctx = await this.browser.newContext(opts);
    await ctx.addInitScript(STEALTH_INIT);
    return ctx;
  }

  async _launch(headed, width, height) {
    const loaded = loadChromium(this.engine);
    const chromium = loaded.chromium;
    const usePatchright = this.engine === 'patchright' && !loaded.fallback;
    this._usingPatchright = usePatchright;
    let browser;
    if (loaded.fallback) {
      this.effectiveEngine = 'playwright (patchright module unavailable)';
      browser = await chromium.launch({ headless: !headed, args: STEALTH_ARGS });
    } else if (usePatchright) {
      // Prefer the real Chrome channel when present (patchright README best
      // practice); fall back to the bundled chromium build otherwise.
      this.effectiveEngine = 'patchright';
      try {
        browser = await chromium.launch({ headless: !headed, channel: 'chrome' });
        this.effectiveEngine = 'patchright + chrome channel';
      } catch (e) {
        browser = await chromium.launch({ headless: !headed });
      }
    } else {
      this.effectiveEngine = 'playwright';
      browser = await chromium.launch({ headless: !headed, args: STEALTH_ARGS });
    }
    this.browser = browser;
    this.ctx = await this._newContext(width, height);
    this._ensureIdle();
    return this.ctx;
  }

  // Load the editor and wait until both docs are populated.
  // Returns { docsReady, cfBlocked, cfWaitedMs }.
  async _loadEditor(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let cfWaitedMs = 0;
    if (await isCfBlocked(page)) {
      const cfStart = Date.now();
      while (await isCfBlocked(page)) {
        if (Date.now() - cfStart > 25000) break;
        await page.waitForTimeout(2000);
      }
      cfWaitedMs = Date.now() - cfStart;
      if (await isCfBlocked(page)) return { docsReady: false, cfBlocked: true, cfWaitedMs };
      await page.waitForTimeout(2000);
    }
    await page.waitForFunction(() => {
      const w = window;
      if (w.__collabRoomFailed === true) return true;
      if (w.yjsProvider && w.yjsProvider.synced === true) return true;
      return false;
    }, null, { timeout: 45000 }).catch(() => {});
    await page.waitForFunction(() => window.outputTemplateEditor && window.modelTextEditor,
      null, { timeout: 25000 }).catch(() => {});
    const docsReady = async (timeoutMs) => {
      await page.waitForFunction(() => {
        const o = window.outputTemplateEditor, m = window.modelTextEditor;
        if (!o || !m) return false;
        return o.state.doc.length > 10 && m.state.doc.length > 10;
      }, null, { timeout: timeoutMs });
    };
    let ready = false;
    try { await docsReady(75000); ready = true; } catch { ready = false; }
    if (!ready) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      try { await docsReady(75000); ready = true; } catch { ready = false; }
    }
    await page.waitForTimeout(250);
    return { docsReady: ready, cfBlocked: false, cfWaitedMs };
  }

  async _openWithLadder(url, { width, height }) {
    const ladder = [
      { mode: 'reuse', headed: this.headed },
      { mode: 'newctx', headed: this.headed },
      { mode: 'relaunch', headed: this.headed },
    ];
    if (!this.headed) ladder.push({ mode: 'relaunch', headed: true });

    const attempts = [];
    for (const step of ladder) {
      const label = step.mode + (step.headed ? '+headed' : '');
      const t0 = Date.now();
      try {
        if (step.mode === 'relaunch') {
          if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
          if (this.browser) { try { await this.browser.close(); } catch {} this.browser = null; }
          this.headed = step.headed;
          await this._launch(step.headed, width, height);
          this.page = await this.ctx.newPage();
        } else if (step.mode === 'newctx' || !this.ctx) {
          if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
          this.headed = step.headed;
          if (!this.browser) await this._launch(step.headed, width, height);
          else this.ctx = await this._newContext(width, height);
          this.page = await this.ctx.newPage();
        }
        this._attachDiagnostics(this.page);
        const r = await this._loadEditor(this.page, url);
        attempts.push({ step: label, docsReady: r.docsReady, cfBlocked: r.cfBlocked, ms: Date.now() - t0 });
        if (r.docsReady) return { ok: true, attempts, step: label };
      } catch (e) {
        attempts.push({ step: label, error: String((e && e.message) || e).slice(0, 180), ms: Date.now() - t0 });
      }
    }
    return { ok: false, attempts };
  }

  // One-shot entry: launch (if needed) + load generator + collab key.
  async start({ name, collabKey = null, headed = false, width = 1500, height = 950, force = false, engine = null } = {}) {
    this._touch();
    const t0 = Date.now();
    if (!name) throw new Error('missing generator name');
    if (engine) this.engine = engine; else this.engine = 'chromium';
    if (this.page && !force && this.ready && this.generator === name && this.collabKey === collabKey) {
      const s = await this.status();
      // Fall through to the ladder when the page is CF-blocked or the editor
      // views are gone — a plain re-call must actually escalate (fix: the old
      // fast path returned ok:true + cfBlocked:true forever, so the advertised
      // "call perch_start again" recovery never ran).
      if (!s.cfBlocked && s.hasOutputView && s.hasModelView) {
        return { ok: true, alreadyLoaded: true, ms: Date.now() - t0, ...s };
      }
    }
    this.headed = !!headed;
    const url = buildEditorUrl(name, collabKey);
    const r = await this._openWithLadder(url, { width, height });
    this.generator = name;
    this.collabKey = collabKey;
    if (!r.ok) {
      this.ready = false;
      return {
        ok: false, generator: name, collabKey, url, headed: this.headed, engine: this.engine,
        effectiveEngine: this.effectiveEngine || this.engine,
        ms: Date.now() - t0, cfBlocked: true, attempts: r.attempts,
        error: 'Cloudflare challenge not cleared after ' + r.attempts.length + ' attempt(s).',
        hint: 'CF flagging is intermittent — retry, or use engine:"patchright", or headed:true.',
      };
    }
    const st = await this.status();
    this.ready = !!(st.hasOutputView && st.hasModelView && !st.cfBlocked);
    return {
      ok: true, generator: name, collabKey, url, headed: this.headed, engine: this.engine,
      effectiveEngine: this.effectiveEngine || this.engine,
      docsReady: st.hasOutputView, recoveryStep: r.step, attempts: r.attempts, ms: Date.now() - t0,
      ...(this.ready ? {} : { warning: 'Editor docs not fully ready — try perch_start again.' }),
    };
  }

  async status() {
    if (!this.page) return { ok: true, running: false, engine: this.engine, hint: 'call perch_start first' };
    this._touch();
    const cfNow = await isCfBlocked(this.page);
    const pageState = await evalMain(this.page, () => {
      let syntaxErrors = null;
      try { syntaxErrors = window.getEditorSyntaxErrors ? window.getEditorSyntaxErrors() : null; } catch (e) {}
      return {
        saveState: window.perchanceSaveState || null,
        syntaxErrors,
        collabSynced: !!(window.yjsProvider && window.yjsProvider.synced),
        cmEditors: document.querySelectorAll('.cm-editor').length,
        hasModelView: !!window.modelTextEditor,
        hasOutputView: !!window.outputTemplateEditor,
        modelLines: window.modelTextEditor ? window.modelTextEditor.state.doc.toString().split('\n').length : null,
        outputLines: window.outputTemplateEditor ? window.outputTemplateEditor.state.doc.toString().split('\n').length : null,
      };
    }).catch(() => ({}));
    const result = {
      ok: true, running: true, generator: this.generator, collabKey: this.collabKey,
      headed: this.headed, engine: this.engine,
      effectiveEngine: this.effectiveEngine || this.engine,
      consoleBuffered: this.diag.console.length, errorsBuffered: this.diag.errors.length,
      ...pageState,
    };
    if (cfNow) {
      result.cfBlocked = true;
      result.warning = 'Cloudflare challenge is blocking the page. Call perch_start again (it escalates automatically).';
    }
    return result;
  }

  // ---------------- browser-free code access ----------------
  _curlJson(url, body) {
    const { execFileSync } = require('child_process');
    const out = execFileSync('curl', [
      '-s', '-X', 'POST', url,
      '-H', 'Content-Type: application/json',
      '-H', 'Origin: https://perchance.org',
      '-H', 'Referer: https://perchance.org/' + (this.generator || ''),
      '-A', UA, '-d', body,
    ], { timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
    return JSON.parse(out);
  }
  _curlText(url) {
    const { execFileSync } = require('child_process');
    return execFileSync('curl', ['-s', '-A', UA, url],
      { timeout: 60000, maxBuffer: 256 * 1024 * 1024 }).toString();
  }

  // Fetch the raw generator payload (modelText + outputTemplate + srcManifest)
  // via the public API. NO browser, NO Cloudflare risk, ~1-2s.
  apiData({ name = null } = {}) {
    const gen = name || this.generator;
    if (!gen) throw new Error('no generator — pass name or call perch_start first');
    const data = this._curlJson('https://perchance.org/api/getGeneratorPageData',
      JSON.stringify({ generatorName: gen }));
    return (data && data.generator) || {};
  }

  // Write the authoritative source to local files for instant ripgrep/reading.
  pull({ name = null, dir = null } = {}) {
    const t0 = Date.now();
    const g = this.apiData({ name });
    const gen = name || this.generator;
    const out = dir || path.join(MIRROR_ROOT, gen);
    fs.mkdirSync(out, { recursive: true });
    const model = g.modelText || '';
    const html = g.outputTemplate || '';
    const modelPath = path.join(out, 'main.pjs');
    const htmlPath = path.join(out, 'index.html');
    fs.writeFileSync(modelPath, model, 'utf8');
    fs.writeFileSync(htmlPath, html, 'utf8');
    return {
      ok: true, generator: gen, dir: out, ms: Date.now() - t0,
      model: { path: modelPath, bytes: Buffer.byteLength(model), lines: model.split('\n').length },
      html: { path: htmlPath, bytes: Buffer.byteLength(html), lines: html.split('\n').length },
      srcManifestKeys: Object.keys(g.srcManifest || {}).length,
      hint: 'Grep/read these local files directly — no browser round-trip needed.',
    };
  }

  // ---------------- pane access (live editor) ----------------
  async read({ pane = 'output', offset = 1, limit = 2000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    return await evalMain(this.page, ({ pane, offset, limit }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'editor view not ready' };
      const all = v.state.doc.toString().split('\n');
      const slice = all.slice(offset - 1, offset - 1 + limit);
      return { ok: true, pane, totalLines: all.length, lines: slice.map((l, i) => `${offset + i}|${l}`) };
    }, { pane, offset, limit });
  }

  async grep({ pattern, pane = null, contextLines = 0, limit = 200 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    return await evalMain(this.page, ({ pattern, pane, contextLines, limit }) => {
      let re;
      try { re = new RegExp(pattern, 'gi'); } catch (e) { return { ok: false, error: 'bad regex: ' + e.message }; }
      const readOne = p => {
        const v = p === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
        return v ? v.state.doc.toString() : null;
      };
      const panes = pane ? [pane] : ['model', 'output'];
      const matches = [];
      let total = 0;
      for (const p of panes) {
        const text = readOne(p);
        if (text == null) continue;
        const lines = text.split('\n');
        lines.forEach((l, i) => {
          re.lastIndex = 0;
          if (!re.test(l)) return;
          total++;
          if (matches.length >= limit) return;
          const entry = { pane: p, line: i + 1, text: l.length > 400 ? l.slice(0, 400) + '…' : l };
          if (contextLines > 0) entry.context = lines.slice(Math.max(0, i - contextLines), i + contextLines + 1);
          matches.push(entry);
        });
      }
      return { ok: true, count: total, returned: matches.length, matches };
    }, { pattern, pane, contextLines, limit });
  }

  async edit({ pane = 'output', oldString, newString, replaceAll = false, settle = true, nth = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const res = await evalMain(this.page, ({ pane, oldString, newString, replaceAll, nth }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      if (v.state.doc.length === 0)
        return { ok: false, error: 'docs not ready (empty doc) — call perch_start again' };
      const doc = v.state.doc.toString();
      if (oldString.length === 0) return { ok: false, error: 'empty oldString' };
      const changes = []; let from = 0, count = 0, seen = 0;
      while (true) {
        const idx = doc.indexOf(oldString, from);
        if (idx === -1) break;
        seen++;
        if (nth == null || seen === nth) {
          changes.push({ from: idx, to: idx + oldString.length, insert: newString });
          count++;
          if (!replaceAll && nth == null) break;
        }
        from = idx + oldString.length;
      }
      if (count === 0)
        return { ok: false, error: nth != null ? `occurrence #${nth} not found (${seen} total)` : 'oldString not found', occurrences: seen };
      v.dispatch({ changes, userEvent: 'input.delete' });
      return { ok: true, replacements: count, occurrences: seen };
    }, { pane, oldString, newString, replaceAll, nth });
    if (res && res.ok && settle !== false) await this.settle();
    return res;
  }

  async write({ pane = 'output', content, settle = true } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const res = await evalMain(this.page, ({ pane, content }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content }, userEvent: 'input' });
      return { ok: true, chars: content.length };
    }, { pane, content });
    if (res && res.ok && settle !== false) await this.settle();
    return res;
  }

  async patch({ changes = [], settle = true } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const results = [];
    for (const c of changes) results.push(await this.edit({ ...c, settle: false }));
    if (settle !== false) await this.settle();
    const failed = results.filter(r => !r.ok).length;
    return { ok: failed === 0, applied: results.length - failed, failed, results };
  }

  async outline({ pane = 'output', limit = 400 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    return await evalMain(this.page, ({ pane, limit }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'editor view not ready' };
      const re = /^\s*(?:export\s+)?(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
      const lines = v.state.doc.toString().split('\n');
      const entries = [];
      lines.forEach((l, i) => {
        const m = l.match(re);
        if (m) entries.push({ line: i + 1, kind: m[1], name: m[2] });
      });
      return { ok: true, pane, count: entries.length, entries: entries.slice(0, limit) };
    }, { pane, limit });
  }

  async copyLines({ fromPane = 'output', startLine, endLine, toPane = null, afterLine = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const dest = toPane || fromPane;
    const fromDoc = await evalMain(this.page, p => {
      const v = p === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      return v ? v.state.doc.toString() : null;
    }, fromPane);
    if (fromDoc == null) return { ok: false, error: 'source pane not ready' };
    const fromLines = fromDoc.split('\n');
    const end = endLine || startLine;
    if (!startLine || startLine < 1 || end > fromLines.length)
      return { ok: false, error: 'line range out of bounds', totalLines: fromLines.length };
    const copied = fromLines.slice(startLine - 1, end);
    const toDoc = await evalMain(this.page, p => {
      const v = p === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      return v ? v.state.doc.toString() : null;
    }, dest);
    if (toDoc == null) return { ok: false, error: 'dest pane not ready' };
    const toLines = toDoc.split('\n');
    const after = afterLine == null ? toLines.length : afterLine;
    if (after < 0 || after > toLines.length) return { ok: false, error: 'afterLine out of bounds' };
    const newDoc = toLines.slice(0, after).concat(copied, toLines.slice(after)).join('\n');
    const res = await evalMain(this.page, ({ pane, content }) => {
      const v = pane === 'model' ? window.modelTextEditor : window.outputTemplateEditor;
      if (!v) return { ok: false, error: 'view not ready' };
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content }, userEvent: 'input' });
      return { ok: true };
    }, { pane: dest, content: newDoc });
    if (res && res.ok) await this.settle();
    return { ok: true, copied: copied.length, after, result: res };
  }

  // ---------------- preview: eval / refresh / console ----------------
  async eval({ js, frame = 'preview' } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const fr = await this._frame(frame);
    try {
      const res = await evalMain(fr, js);
      return { ok: true, frame, result: res };
    } catch (e) {
      return { ok: false, frame, error: String((e && e.message) || e).slice(0, 300) };
    }
  }

  async refresh() {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    await this._drainPageDiag().catch(() => {});
    const before = this.diag.console.length;
    {
      const fr = await this._frame('preview').catch(() => null);
      if (fr) await evalMain(fr, () => { window.__perchReloadFlag = true; }).catch(() => {});
    }
    await evalMain(this.page, () => {
      try { if (window.hardReloadOutputIframe) window.hardReloadOutputIframe(); } catch (e) {}
    });
    const t0 = Date.now();
    let loaded = false;
    while (Date.now() - t0 < 25000) {
      const fr = await this._frame('preview').catch(() => null);
      if (fr) {
        const st = await evalMain(fr, () => ({ flag: !!window.__perchReloadFlag, rs: document.readyState }))
          .catch(() => null);
        if (st && !st.flag && st.rs === 'complete') { loaded = true; break; }
      }
      await this.page.waitForTimeout(400);
    }
    await this.page.waitForTimeout(700);
    const syntaxErrors = await evalMain(this.page, () => {
      try { return window.getEditorSyntaxErrors ? window.getEditorSyntaxErrors() : null; } catch (e) { return null; }
    }).catch(() => null);
    await this._drainPageDiag().catch(() => {});
    return {
      ok: true, previewLoaded: loaded, syntaxErrors,
      runtimeErrors: this.diag.errors.slice(-30),
      newConsoleLines: this.diag.console.slice(before).slice(-40),
      panel: await this._readConsole(),
    };
  }

  async console({ clear = false } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    await this._drainPageDiag().catch(() => {});
    const out = {
      ok: true,
      panel: (await this._readConsole()).slice(-6000),
      buffered: this.diag.console.slice(-80),
      runtimeErrors: this.diag.errors.slice(-40),
    };
    if (clear) this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    return out;
  }

  async _readConsole() {
    for (const f of this.page.frames()) {
      if (f === this.page.mainFrame()) continue;
      try {
        if (f.name() === 'console-output')
          return await evalMain(f, () => document.body ? (document.body.innerText || document.body.textContent || '') : '');
      } catch {}
    }
    try {
      return await this.page.$eval('#console-output', el =>
        (el.contentDocument && el.contentDocument.body) ? (el.contentDocument.body.innerText || '') : '');
    } catch { return ''; }
  }

  // ---------------- UI testing (text-first) ----------------
  // List interactive elements in the live preview so an agent can drive the UI
  // without a screenshot. Each entry carries a CSS selector for perch_click.
  async snapshot({ frame = 'preview', limit = 250, filter = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const fr = await this._frame(frame);
    // NOTE: the callback below is serialized and runs IN THE BROWSER — only
    // the argument object is in scope there, so nothing outer may be closed
    // over (v3 first cut returned the outer `frame` here and threw).
    const out = await evalMain(fr, ({ limit, filter }) => {
      const cssPath = (el) => {
        if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
        const parts = [];
        let cur = el;
        for (let d = 0; cur && cur.nodeType === 1 && d < 4; d++) {
          if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
          let sel = cur.tagName.toLowerCase();
          const cls = (cur.className || '').toString().trim().split(/\s+/)
            .filter(c => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
          if (cls.length) sel += '.' + cls.join('.');
          const sibs = cur.parentNode ? [...cur.parentNode.children].filter(s => s.tagName === cur.tagName) : [];
          if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
          parts.unshift(sel);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      };
      const sel = 'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="tab"], [role="menuitem"]';
      const all = [...document.querySelectorAll(sel)];
      const out = [];
      for (const el of all) {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' &&
          style.display !== 'none' && style.opacity !== '0';
        if (!visible) continue;
        const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value ||
          (el.innerText || el.textContent || '').trim() || el.getAttribute('title') || '')
          .replace(/\s+/g, ' ').slice(0, 80);
        if (filter && !(label + ' ' + el.tagName).toLowerCase().includes(filter.toLowerCase())) continue;
        out.push({
          tag: el.tagName.toLowerCase(), label,
          type: el.getAttribute('type') || undefined,
          id: el.id || undefined, disabled: el.disabled || undefined,
          selector: cssPath(el),
        });
        if (out.length >= limit) break;
      }
      return { ok: true, count: out.length, visibleCandidates: all.length, elements: out };
    }, { limit, filter });
    return { frame, ...out };
  }

  async wait({ selector = null, text = null, gone = false, frame = 'preview', timeout = 15000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const fr = await this._frame(frame);
    const t0 = Date.now();
    try {
      if (selector && selector.startsWith('text=')) { text = selector.slice(5); selector = null; }
      if (text != null) {
        const loc = fr.getByText(text, { exact: false }).first();
        await loc.waitFor({ state: gone ? 'detached' : 'visible', timeout });
      } else if (selector) {
        const loc = fr.locator(selector).first();
        await loc.waitFor({ state: gone ? 'detached' : 'visible', timeout });
      } else {
        await this.page.waitForTimeout(Math.min(timeout, 10000));
      }
      return { ok: true, waitedMs: Date.now() - t0, selector, text, gone };
    } catch (e) {
      return { ok: false, waitedMs: Date.now() - t0, error: String((e && e.message) || e).slice(0, 200), selector, text, gone };
    }
  }

  async click({ selector, frame = 'preview', timeout = 10000, nth = null } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!selector) throw new Error('missing selector');
    const fr = await this._frame(frame);
    const loc = selector.startsWith('text=')
      ? fr.getByText(selector.slice(5), { exact: false })
      : fr.locator(selector);
    const target = nth != null ? loc.nth(nth) : loc.first();
    try {
      await target.click({ timeout });
      return { ok: true, clicked: selector, frame, matches: await loc.count().catch(() => null) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200), matches: await loc.count().catch(() => 0) };
    }
  }

  async type({ selector, text, frame = 'preview', timeout = 10000, submit = false } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!selector) throw new Error('missing selector');
    const fr = await this._frame(frame);
    const loc = selector.startsWith('text=')
      ? fr.getByText(selector.slice(5), { exact: false }).first()
      : fr.locator(selector).first();
    try {
      await loc.fill(text, { timeout });
    } catch {
      await loc.click({ timeout });
      await loc.pressSequentially(text, { delay: 20 });
    }
    if (submit) await loc.press('Enter');
    return { ok: true, typed: text.length, frame, submitted: !!submit };
  }

  async press({ key, frame = 'editor' } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!key) throw new Error('missing key');
    // Keyboard lives on the page (frames have no .keyboard in this build).
    await this.page.keyboard.press(key);
    return { ok: true, pressed: key, frame };
  }

  async setViewport({ width = 1500, height = 950 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    await this.page.setViewportSize({ width, height });
    const rect = await evalMain(this.page, () => {
      const f = document.getElementById('outputIframeEl');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return { ok: true, viewport: { width, height }, iframe: rect };
  }

  async shot({ what = 'editor', path: p } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    const out = p || path.join(__dirname, 'perch_shot.png');
    if (what === 'preview') {
      const el = await this.page.$('#outputIframeEl');
      if (el) await el.screenshot({ path: out });
      else {
        const frame = await this._frame('preview');
        if (typeof frame.screenshot === 'function') await frame.screenshot({ path: out });
        else throw new Error('cannot screenshot preview');
      }
    } else {
      await this.page.screenshot({ path: out, fullPage: false });
    }
    return { ok: true, what, path: out };
  }

  // ---------------- src/ access (via curl, passes CF) ----------------
  async _getManifest() {
    const data = this._curlJson('https://perchance.org/api/getGeneratorPageData',
      JSON.stringify({ generatorName: this.generator }));
    return (data.generator && data.generator.srcManifest) || {};
  }
  async src(p) {
    const manifest = await this._getManifest();
    const key = manifest[p] && manifest[p].key;
    if (!key) return { ok: false, error: 'src path not in manifest: ' + p, available: Object.keys(manifest) };
    const text = this._curlText('https://user.uploads.dev/file/' + key);
    return { ok: true, path: p, size: text.length, text: text.slice(0, 120000) };
  }
  async listSrc() {
    const manifest = await this._getManifest();
    const entries = Object.entries(manifest).map(([p, v]) => ({ path: p, size: v.size }));
    return { ok: true, count: entries.length, entries };
  }
  async fetchGenerator({ name, path: p } = {}) {
    if (!name) throw new Error('missing generator name');
    return this.pull({ name, dir: p ? path.dirname(p) : null });
  }

  // ---------------- top-level navigation (CF / preview recovery) ----------------
  // Navigates the whole editor PAGE (not just the preview iframe). Two uses:
  //  - recovering a session whose editor page got CF-challenged;
  //  - the subdomain-clearance recipe: a CF interstitial can never render
  //    inside an iframe, so a blocked embed (e.g. text-generation.perchance.org
  //    inside the ai-text-plugin) is cleared by visiting that URL top-level
  //    once, waiting out the challenge, then perch_start(force:true).
  async navigate({ url, timeout = 30000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!/^https:\/\//.test(url || '')) return { ok: false, error: 'only https:// URLs are allowed' };
    const t0 = Date.now();
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 60000) })
      .catch(e => ({ gotoError: String((e && e.message) || e).slice(0, 200) }));
    // Wait out a possible Cloudflare interstitial (auto-clearing JS challenge).
    let cf = true;
    while (Date.now() - t0 < timeout) {
      cf = await isCfBlocked(this.page);
      if (!cf) break;
      await this.page.waitForTimeout(1500);
    }
    const info = await evalMain(this.page, () => ({ url: location.href, title: document.title }))
      .catch(() => ({ url: null, title: null }));
    this.ready = false; // editor views are gone after leaving the editor page
    return {
      ok: !cf, cfBlocked: cf, elapsedMs: Date.now() - t0, ...info,
      note: cf ? 'challenge did not clear — retry, or open the URL once in a real browser'
               : 'navigated; call perch_start(force:true) to return to the editor',
    };
  }

  // ---------------- src/ upload (proven against the live editor) ----------------
  // Uploads a file into the generator's src/ through the editor's file panel.
  // The src-tree uploader is <input data-ref="fileInput"> inside #aiAgentPanelEl;
  // #aiAgentFileInputEl is the AI-helper CHAT attachment input — do not confuse
  // them (attaching there does NOT create a src file).
  async uploadSrc({ name, content = '', timeout = 25000 } = {}) {
    if (!this.page) throw new Error('call perch_start first');
    this._touch();
    if (!name || /[\\\/]/.test(name))
      return { ok: false, error: 'name must be a bare file name, e.g. README.md (folders not supported)' };
    const ed = await this._frame('editor');
    // 1. make sure the files panel is open
    const panelOpen = await evalMain(ed, () => {
      const p = document.querySelector('#aiAgentPanelEl');
      return !!(p && p.innerText && (p.innerText.includes('upload') || p.innerText.includes('src')));
    }).catch(() => false);
    if (!panelOpen) {
      try {
        await ed.locator('text=🗂 files').first().click({ timeout: 5000 });
      } catch { return { ok: false, error: 'could not open the files panel' }; }
      await this.page.waitForTimeout(700);
    }
    // 2. inject the file via DataTransfer (callback runs IN THE BROWSER)
    const r = await evalMain(ed, ({ name, content }) => {
      const input = document.querySelector('#aiAgentPanelEl input[data-ref="fileInput"]');
      if (!input) return { ok: false, error: 'src file input not found — open the files panel first' };
      const ext = (name.split('.').pop() || '').toLowerCase();
      const mime = { md: 'text/markdown', txt: 'text/plain', js: 'text/javascript', mjs: 'text/javascript',
        json: 'application/json', html: 'text/html', css: 'text/css' }[ext] || 'text/plain';
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: mime }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }, { name, content });
    if (!r.ok) return r;
    // 3. wait for the tree to mark the file saved
    const t0 = Date.now();
    let saved = false;
    while (Date.now() - t0 < timeout) {
      const txt = await evalMain(ed, () => {
        const p = document.querySelector('#aiAgentPanelEl');
        return p ? (p.innerText || '') : '';
      }).catch(() => '');
      if (txt.includes(name) && /saved/i.test(txt)) { saved = true; break; }
      await this.page.waitForTimeout(800);
    }
    return {
      ok: saved, file: name, saved, ms: Date.now() - t0,
      hint: saved
        ? 'saved to the editor src store; visitors see it once the generator owner saves'
        : 'file was injected but the panel never reported "saved" — check perch_errors and retry',
    };
  }

  async stop() {
    this._stopDiagDrain();
    if (this._idle) { clearInterval(this._idle); this._idle = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
    if (this.browser) { try { await this.browser.close(); } catch {} this.browser = null; }
    this.page = null;
    this.ready = false;
    this.generator = null;
    this.collabKey = null;
    this.diag = { console: [], errors: [], droppedConsole: 0, droppedErrors: 0 };
    return { ok: true, stopped: true };
  }
}

module.exports = { PerchSession, buildEditorUrl, isCfBlocked, MIRROR_ROOT };
