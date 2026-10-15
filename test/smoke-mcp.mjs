// smoke-mcp.mjs — drive the MCP server over real stdio JSON-RPC and log every step.
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

const call = (id, method, params) => new Promise((r) => { pending.set(id, r); send({ jsonrpc: '2.0', id, method, params }); });
let idc = 100;
const tool = async (name, args) => {
  log('--> CALL ' + name + ' ' + JSON.stringify(args || {}));
  const t = Date.now();
  const r = await call(++idc, 'tools/call', { name, arguments: args || {} });
  const wall = Date.now() - t;
  let body;
  try { body = JSON.parse(r.result.content[0].text); } catch { body = r.result.content[0].text; }
  log('<-- ' + name + ' wall=' + wall + 'ms ' + JSON.stringify(body).slice(0, 400));
  console.log(name.padEnd(20) + String(wall).padStart(7) + 'ms  ' + JSON.stringify(body).slice(0, 160));
  return body;
};

// 1. list the tools — this is what the host client caches at session start.
const listed = await call(1, 'tools/list', {});
console.log('tools advertised: ' + (listed.result.tools || []).length);
log('tools: ' + (listed.result.tools || []).map(t => t.name).join(', '));

// 2. handshake
await call(2, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

// 3. exercise the tools
await tool('perch_start', KEY ? { name: NAME, collabKey: KEY } : { name: NAME });
await tool('perch_status');
await tool('perch_pull', { name: NAME, dir: path.join(OUT, NAME) });
await tool('perch_read', { pane: 'model', offset: 1, limit: 20 });
await tool('perch_outline', { pane: 'model', limit: 20 });
await tool('perch_grep', { pattern: 'function\\s+\\w+', pane: 'model', limit: 5 });
await tool('perch_eval', { js: 'document.querySelectorAll("button").length' });
await tool('perch_snapshot', { limit: 20 });
await tool('perch_wait', { selector: 'body', timeout: 5000 });
await tool('perch_errors', { clear: true });
await tool('perch_list_src');
await tool('perch_set_viewport', { width: 1280, height: 800 });
await tool('perch_shot', { what: 'preview', path: path.join(OUT, 'mcp-preview.png') });
await tool('perch_stop');

log('ALL STEPS DONE');
console.log('\ntranscript: ' + LOG);
child.kill();
process.exit(0);
