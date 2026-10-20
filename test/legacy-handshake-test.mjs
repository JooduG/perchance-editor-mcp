// Test the legacy entry: spawn it, run the old handshake, list tools, call a
// browser-free tool, verify results — then close.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["perch-mcp-legacy.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch {}
  }
});
child.stderr.on("data", (d) => process.stderr.write("[srv] " + d.toString()));

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const results = {};
try {
  const init = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-test", version: "1.0" } });
  results.initVersion = init.result && init.result.protocolVersion;
  results.serverInfo = init.result && init.result.serverInfo;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await request("tools/list", {});
  results.toolCount = list.result ? list.result.tools.length : -1;
  results.hasUpload = list.result ? list.result.tools.some(t => t.name === "perch_upload_src") : false;

  const call = await request("tools/call", { name: "perch_list_src", arguments: {} });
  const payload = JSON.parse(call.result.content[0].text);
  results.listSrcOk = payload.ok;
  results.listSrcCount = payload.count;

  const pull = await request("tools/call", { name: "perch_pull", arguments: { name: "minimal" } });
  const pullPayload = JSON.parse(pull.result.content[0].text);
  results.pullOk = pullPayload.ok;

  const unknown = await request("tools/call", { name: "nope", arguments: {} });
  results.unknownIsError = unknown.result && unknown.result.isError === true;

  // unsupported version echo fallback
  const init2 = await request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" } });
  results.fallbackVersion = init2.result && init2.result.protocolVersion;
} catch (e) {
  results.fatal = String(e && e.message || e);
}

console.log(JSON.stringify(results, null, 2));
child.kill();
process.exit(0);
