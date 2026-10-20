// One-shot: extract TOOLS/DISPATCH from perch-mcp.mjs into perch-tools.mjs,
// then rewrite perch-mcp.mjs to import them (modern entry unchanged in behavior).
const fs = require('fs');
const src = fs.readFileSync('perch-mcp.mjs', 'utf8');

const paneStart = src.indexOf('const PANE = ');
const dispatchEnd = src.indexOf('};', src.indexOf('const DISPATCH = {'));
if (paneStart < 0 || dispatchEnd < 0) throw new Error('markers not found');
const shared = src.slice(paneStart, dispatchEnd + 2); // PANE/FRAME/TOOLS/DISPATCH

const tools = `// perch-tools.mjs — shared tool schemas + dispatch table for the perch MCP
// server entries. perch-mcp.mjs (modern 2026-07-28 discover flow) and
// perch-mcp-legacy.mjs (legacy initialize/tools-list/tools-call handshake)
// both serve this exact set, so the two entries can never drift.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PerchSession } = require("./perch-core.js");

export const session = new PerchSession();

${shared}
`;
fs.writeFileSync('perch-tools.mjs', tools);
console.log('perch-tools.mjs written,', tools.split('\n').length, 'lines');

// rewrite the modern entry
const header = src.slice(0, src.indexOf('// ----------------------------- tool schemas'));
const newHeader = header
  .replace("//   * start.engine     — 'chromium' | 'patchright' (undetected playwright\n//     fork, used as the Cloudflare fallback engine).",
    "//   * start.engine     — 'firefox' (DEFAULT; clears CF on perchance.org\n//     subdomains) | 'chromium' (escape hatch / automatic fallback).")
  .replace('// Stdio transport; Hermes auto-discovers the tools as mcp_perch_<name>.',
    '// Stdio transport; tools arrive namespaced by the client (e.g. mcp__perch_*).');
const tail = src.slice(src.indexOf('// ----------------------------- server factory (MCP v2)'));
const rewritten = newHeader
  .replace('import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";\nimport { serveStdio } from "@modelcontextprotocol/server/stdio";\nimport { createRequire } from "node:module";\n\nconst require = createRequire(import.meta.url);\nconst { PerchSession } = require("./perch-core.js");\n\nconst session = new PerchSession();\n',
    'import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";\nimport { serveStdio } from "@modelcontextprotocol/server/stdio";\nimport { TOOLS, DISPATCH } from "./perch-tools.mjs";\n') + tail;
fs.writeFileSync('perch-mcp.mjs', rewritten);
console.log('perch-mcp.mjs rewritten,', rewritten.split('\n').length, 'lines');
