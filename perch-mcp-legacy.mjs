#!/usr/bin/env node
// perch-mcp-legacy.mjs — LEGACY MCP handshake entry (optional).
//
// Speaks the classic initialize / notifications/initialized / tools/list /
// tools/call stdio flow (protocol 2025-11-25 era) for clients that cannot use
// the modern 2026-07-28 discover-based flow of perch-mcp.mjs. Serves the SAME
// shared tool set (perch-tools.mjs) and the same perch-core.js session, so the
// two entries can never drift. The main entry stays modern-only; register this
// file instead only when the client cannot negotiate the modern protocol.
//
// No _meta envelope is required and no server/discover is implemented — that
// is the point of this entry.

import { createRequire } from "node:module";
import readline from "node:readline";
import { TOOLS, DISPATCH } from "./perch-tools.mjs";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

// Legacy protocol generations this entry is willing to speak. Echo the
// client's requested version when supported, else fall back to the oldest
// broadly-supported one.
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line || !line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
  const isRequest = msg.id !== undefined && msg.id !== null;

  if (msg.method === "initialize") {
    const requested = msg.params && msg.params.protocolVersion;
    const version = SUPPORTED.includes(requested) ? requested : SUPPORTED[SUPPORTED.length - 1];
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "perch", version: pkg.version + "-legacy" },
      },
    });
    return;
  }

  if (msg.method.startsWith("notifications/")) return; // no response for notifications

  if (msg.method === "ping") {
    if (isRequest) send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params && msg.params.name;
    const fn = DISPATCH[name];
    const t0 = Date.now();
    if (!fn) {
      send({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "unknown tool: " + name }) }], isError: true },
      });
      return;
    }
    Promise.resolve()
      .then(() => fn((msg.params && msg.params.arguments) || {}))
      .then((result) => {
        result.ms = Date.now() - t0;
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      })
      .catch((e) => {
        send({
          jsonrpc: "2.0", id: msg.id,
          result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 }) }], isError: true },
        });
      });
    return;
  }

  if (isRequest) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
  }
});

process.on("unhandledRejection", (e) => {
  console.error("[perch-legacy] unhandled rejection:", (e && e.message) || e);
});
process.on("uncaughtException", (e) => {
  console.error("[perch-legacy] uncaught exception:", (e && e.message) || e);
});
