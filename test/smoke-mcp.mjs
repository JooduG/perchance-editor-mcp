// smoke-mcp.mjs — drive the MCP server over real stdio JSON-RPC and log every step.
//
// MODERN client (MCP 2026-07-28, stateless): there is no initialize handshake.
// Every request carries the required _meta envelope
// (io.modelcontextprotocol/protocolVersion [+ clientCapabilities, clientInfo]),
// and capabilities come from an up-front server/discover call. The script also
// sends one legacy `initialize` and asserts the modern-only server rejects it
// with -32022 (UnsupportedProtocolVersion) — the signal Hermes 'auto' mode
// falls back on.
//
// Usage:
//   node test/smoke-mcp.mjs [generatorName] [collabKey]
//
// Defaults to "minimal" / no key. Writes a transcript to test/out/mcp-int.log.
// Run with native node and a forward-slash path (MSYS does not translate paths
// for native binaries).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NAME = process.argv[2] || 'minimal';
const KEY = process.argv[3] || null;
const PROTOCOL = '2026-07-28';

const META = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'smoke-mcp', version: '2.0.0' },
};

const OUT = path.join(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'mcp-int.log');
fs.writeFileSync(LOG, '');
const log = (...a) => fs.appendFileSync(LOG, a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

const SERVER = path.join(import.meta.dirname, '..', 'perch-mcp.mjs');
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on('data', (d) => log('[server-stderr] ' + d.toString().trim().slice(0, 200)));

// raw: exactly what you pass — used for the legacy-handshake negative test.
const raw = (id, method, params) => new Promise((r) => { pending.set(id, r); send({ jsonrpc: '2.0', id, method, params }); });
// call: modern request — merges the required _meta envelope into params.
const call = (id, method, params) => raw(id, method, { ...(params || {}), _meta: META });

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL: ' + msg); };

// 1. server/discover — the modern replacement for the initialize handshake.
const disc = await call(1, 'server/discover', {});
if (disc.error) {
  fail('server/discover: ' + JSON.stringify(disc.error).slice(0, 300));
  child.kill();
  process.exit(1);
}
const dMeta = (disc.result && disc.result._meta) || {};
const dServerInfo = dMeta['io.modelcontextprotocol/serverInfo'] || null;
console.log('discover  : protocolVersion=' + (disc.result.protocolVersion || dMeta['io.modelcontextprotocol/protocolVersion'] || '?')
  + '  serverInfo=' + JSON.stringify(dServerInfo));
log('discover -> ' + JSON.stringify(disc.result).slice(0, 500));

// 2. negative test: a legacy 2024-11-05 initialize must be rejected with -32022.
const legacy = await raw(2, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-legacy', version: '1' } });
const legacyCode = legacy && legacy.error && legacy.error.code;
const legacyRejected = legacyCode === -32022
  || (legacy && legacy.error && /unsupported protocol version/i.test(legacy.error.message || ''));
if (legacyRejected) {
  console.log('legacy initialize -> rejected, code=' + legacyCode + ' (modern-only: OK)');
} else {
  fail('legacy initialize was NOT rejected: ' + JSON.stringify(legacy).slice(0, 300));
}
log('legacy initialize -> ' + JSON.stringify(legacy).slice(0, 300));

// 3. list the tools — stateless; this is what the host client caches at session start.
const listed = await call(3, 'tools/list', {});
const tools = (listed.result && listed.result.tools) || [];
if (!tools.length) fail('tools/list returned no tools: ' + JSON.stringify(listed).slice(0, 300));
else console.log('tools advertised: ' + tools.length);
log('tools: ' + tools.map(t => t.name).join(', '));

// 4. exercise the tools
const tool = async (name, args) => {
  log('--> CALL ' + name + ' ' + JSON.stringify(args || {}));
  const t = Date.now();
  const r = await call(++idc, 'tools/call', { name, arguments: args || {} });
  const wall = Date.now() - t;
  if (r.error) {
    fail(name + ' -> jsonrpc error: ' + JSON.stringify(r.error).slice(0, 300));
    log('<-- ' + name + ' ERROR ' + JSON.stringify(r.error).slice(0, 400));
    return { ok: false, error: r.error.message || 'error' };
  }
  const resultType = r.result && r.result.resultType;
  let body;
  try { body = JSON.parse(r.result.content[0].text); } catch { body = r.result.content[0].text; }
  log('<-- ' + name + ' wall=' + wall + 'ms resultType=' + resultType + ' ' + JSON.stringify(body).slice(0, 400));
  console.log(name.padEnd(20) + String(wall).padStart(7) + 'ms  rt=' + resultType + '  ' + JSON.stringify(body).slice(0, 150));
  return body;
};
let idc = 100;
const okOr = (name, body) => { if (!(body && body.ok)) fail(name + ' reported ok:false — see transcript'); };

okOr('perch_start', await tool('perch_start', KEY ? { name: NAME, collabKey: KEY } : { name: NAME }));
okOr('perch_status', await tool('perch_status'));
okOr('perch_pull', await tool('perch_pull', { name: NAME, dir: path.join(OUT, NAME) }));
okOr('perch_read', await tool('perch_read', { pane: 'model', offset: 1, limit: 20 }));
okOr('perch_outline', await tool('perch_outline', { pane: 'model', limit: 20 }));
okOr('perch_grep', await tool('perch_grep', { pattern: 'function\\s+\\w+', pane: 'model', limit: 5 }));
okOr('perch_eval', await tool('perch_eval', { js: 'document.querySelectorAll("button").length' }));
okOr('perch_snapshot', await tool('perch_snapshot', { limit: 20 }));
okOr('perch_wait', await tool('perch_wait', { selector: 'body', timeout: 5000 }));
okOr('perch_errors', await tool('perch_errors', { clear: true }));
okOr('perch_list_src', await tool('perch_list_src'));
okOr('perch_set_viewport', await tool('perch_set_viewport', { width: 1280, height: 800 }));
okOr('perch_shot', await tool('perch_shot', { what: 'preview', path: path.join(OUT, 'mcp-preview.png') }));
okOr('perch_stop', await tool('perch_stop'));

log('ALL STEPS DONE, failures=' + failures);
console.log(failures ? '\n' + failures + ' FAILURES — transcript: ' + LOG : '\nALL OK — transcript: ' + LOG);
child.kill();
process.exit(failures ? 1 : 0);
