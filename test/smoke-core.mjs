// smoke-core.mjs — exercise perch-core.js directly, no MCP transport.
//
// Usage:
//   node test/smoke-core.mjs [generatorName] [collabKey]
//
// Defaults to the public template generator "minimal" and no collab key, so it
// runs against a target you definitely own or that is public. Pass your own
// generator name and collab key to test a private one:
//
//   node test/smoke-core.mjs my-generator-name MYCOLLABKEY
//
// Output goes to test/out/ (gitignored).
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { PerchSession } = require('../perch-core.js');

const NAME = process.argv[2] || 'minimal';
const KEY = process.argv[3] || null;
const OUT = path.join(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const s = new PerchSession();
const log = (label, r, keys = null) => {
  const summary = keys
    ? Object.fromEntries(keys.filter(k => k in (r || {})).map(k => [k, r[k]]))
    : r;
  console.log(`\n### ${label}  (${r && r.ms != null ? r.ms + 'ms' : '?'})`);
  console.log(JSON.stringify(summary, null, 2).slice(0, 1800));
};

try {
  // 1. browser-free pull — works with no session, no collab key, no Cloudflare.
  log('pull()', s.pull({ name: NAME, dir: path.join(OUT, NAME) }));

  // 2. start (runs the Cloudflare escalation ladder if needed)
  log('start()', await s.start({ name: NAME, collabKey: KEY }),
    ['ok', 'docsReady', 'recoveryStep', 'attempts', 'engine', 'url', 'ms', 'cfBlocked', 'warning']);

  // 3. status
  log('status()', await s.status(),
    ['ok', 'generator', 'engine', 'collabSynced', 'hasModelView', 'hasOutputView',
     'modelLines', 'outputLines', 'cfBlocked', 'consoleBuffered', 'errorsBuffered']);

  // 4. eval in both frames
  log('eval(preview).title', await s.eval({ js: 'document.title' }), ['ok', 'frame', 'result', 'error']);
  log('eval(preview).buttons', await s.eval({ js: 'document.querySelectorAll("button").length' }), ['ok', 'result', 'error']);
  log('eval(editor).cm', await s.eval({ js: 'document.querySelectorAll(".cm-editor").length', frame: 'editor' }), ['ok', 'frame', 'result', 'error']);

  // 5. snapshot — text-first UI testing
  const snap = await s.snapshot({ limit: 40 });
  console.log('\n### snapshot()');
  console.log(JSON.stringify({ ok: snap.ok, count: snap.count, visibleCandidates: snap.visibleCandidates }, null, 2));
  console.log(JSON.stringify((snap.elements || []).slice(0, 20), null, 2));

  // 6. grep with context
  const g = await s.grep({ pattern: 'function\\s+\\w+', contextLines: 0, pane: 'output', limit: 10 });
  console.log('\n### grep()');
  console.log(JSON.stringify({ count: g.count, returned: g.returned }, null, 2));
  console.log(JSON.stringify((g.matches || []).slice(0, 5), null, 2).slice(0, 600));

  // 7. errors
  log('errors()', await s.errors(), ['ok', 'syntaxErrors', 'runtimeErrors', 'droppedConsole']);

  // 8. refresh + error reporting
  log('refresh()', await s.refresh(), ['ok', 'previewLoaded', 'syntaxErrors', 'runtimeErrors', 'newConsoleLines']);

  // 9. screenshot the preview
  log('shot(preview)', await s.shot({ what: 'preview', path: path.join(OUT, 'preview.png') }), ['ok', 'what', 'path']);

  await s.stop();
  console.log('\n=== ALL DONE ===');
} catch (e) {
  console.error('FATAL:', (e && e.stack) || e);
  process.exit(1);
}
