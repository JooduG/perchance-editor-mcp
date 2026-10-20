// upload-src-files.mjs — one-shot: upload local files into a generator's src/ store
// through the editor's file panel, driving the perch MCP server over real stdio
// JSON-RPC (modern 2026-07-28 envelope, same as smoke-mcp.mjs).
//
// Usage:
//   node test/upload-src-files.mjs <generatorName> <collabKey> <localFile>[@<remoteName>] [...]
//   ('@' separator — ':' would collide with MSYS path-list conversion of Windows paths)
//
// The collab key is an argv credential — never logged, never written to any file.
// Tries the remote name verbatim first (so "emoji/x.svg" tests folder support);
// on a folder rejection it retries with the file's bare name.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [NAME, KEY, ...FILE_SPECS] = process.argv.slice(2);
if (!NAME || !FILE_SPECS.length) {
  console.error('usage: node test/upload-src-files.mjs <generator> <collabKey> <localFile>[:<remoteName>] [...]');
  process.exit(1);
}
const PROTOCOL = '2026-07-28';
const META = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'upload-src-files', version: '2.0.0' },
};

const SERVER = path.join(import.meta.dirname, '..', 'perch-mcp.mjs');
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
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
child.stderr.on('data', (d) => console.error('[server-stderr] ' + d.toString().trim().slice(0, 200)));

const call = (id, method, params) => new Promise((r) => {
  pending.set(id, r);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...(params || {}), _meta: META } }) + '\n');
});
let idc = 10;
const tool = async (name, args) => {
  const t = Date.now();
  const r = await call(++idc, 'tools/call', { name, arguments: args || {} });
  if (r.error) return { ok: false, error: r.error.message || 'jsonrpc error' };
  let body;
  try { body = JSON.parse(r.result.content[0].text); } catch { body = r.result.content[0].text; }
  console.log(name.padEnd(18) + String(Date.now() - t).padStart(7) + 'ms  ' + JSON.stringify(body).slice(0, 220));
  return body;
};

const disc = await call(1, 'server/discover', {});
if (disc.error) { console.error('server/discover failed:', JSON.stringify(disc.error).slice(0, 300)); child.kill(); process.exit(1); }
console.log('discovered, protocol ' + (disc.result.protocolVersion || PROTOCOL));

const start = await tool('perch_start', { name: NAME, collabKey: KEY });
if (!start.ok) { console.error('perch_start failed'); child.kill(); process.exit(1); }

let uploaded = 0;
for (const spec of FILE_SPECS) {
  const at = spec.lastIndexOf('@');
  const localPath = at === -1 ? spec : spec.slice(0, at);
  const remoteName = at === -1 ? '' : spec.slice(at + 1);
  const bare = path.basename(localPath);
  const remote = remoteName || bare;
  let content = fs.readFileSync(localPath, 'utf8');
  // The editor's file panel stores what the input carries; strip nothing — but a BOM would
  // ride into the served file, so drop it.
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  let res = await tool('perch_upload_src', { name: remote, content, timeout: 30000 });
  if (!res.ok && remote !== bare) {
    console.log('  ^ folder name rejected? retrying as bare: ' + bare);
    res = await tool('perch_upload_src', { name: bare, content, timeout: 30000 });
  }
  if (res && res.ok) uploaded++;
  else console.error('UPLOAD FAILED for ' + spec + ': ' + JSON.stringify(res).slice(0, 300));
}
console.log(`uploaded ${uploaded}/${FILE_SPECS.length}`);
const status = await tool('perch_status');
if (status && status.ok) console.log('saveState=' + status.saveState + ' collabSynced=' + status.collabSynced + ' outputLines=' + status.outputLines);
await tool('perch_stop');
child.kill();
process.exit(uploaded === FILE_SPECS.length ? 0 : 2);
