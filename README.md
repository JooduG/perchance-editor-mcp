# perch-mcp

An MCP server that gives an AI agent real, bidirectional control of a
[Perchance.org](https://perchance.org) generator: read its source, edit it,
drive its live UI, and read its console — all through 27 tools over stdio.

Two distinct code paths, deliberately:

| Path | Tools | Cost | Cloudflare |
|---|---|---|---|
| **Browser-free** | `perch_pull`, `perch_fetch_generator`, `perch_src`, `perch_list_src` | ~1s | none — uses `curl` |
| **Live editor** | `perch_start` + the other 23 | ~2.7s start, then 1–20ms/call | mitigated |

Reads should almost always use the browser-free path. The browser exists for
edits, `eval`, and UI testing.

> **Driving this from an agent?** [`SKILL.md`](SKILL.md) is the operating manual:
> tool reference, session recipe, collab/publish rules, the Cloudflare playbook,
> and the pitfalls. This README covers install and registration only.

---

## Table of contents

- [Install](#install)
- [Registering the server](#registering-the-server)
- [Quick start](#quick-start)
- [The tool set](#the-tool-set)
- [Security notes](#security-notes)
- [Tests](#tests)
- [Files](#files)
- [License](#license)

---

## Install

Requires **Node 20+** (patchright 1.64 needs Node ≥ 20) and **`curl` on `PATH`** (used
for the browser-free path — on Windows 10+ `curl.exe` ships with the OS).

```bash
git clone https://github.com/Nightomaru/perchance-editor-mcp.git
cd perchance-editor-mcp
npm install
npx patchright install chromium     # browser binary for the DEFAULT stealth engine
npx playwright install chromium     # only for the playwright fallback (optional)
```

`npm install` pulls `@modelcontextprotocol/sdk`, **patchright** (the DEFAULT browser
engine — a patched, undetected Playwright fork that keeps sessions alive against
Perchance's Cloudflare), and `playwright` (kept as the fallback driver). If
`patchright` is missing or fails to launch, the session degrades to plain
`playwright` (reported as `effectiveEngine` by `perch_start`/`perch_status`, never
silently). Optionally run `npx patchright install chrome` so the patchright engine
can use the real Chrome channel — it falls back to the bundled chromium build when
Chrome is absent.

Updating to a newer release: `git pull && npm install`.

### Verify the install

```bash
npm run test:core        # exercises perch-core.js directly
npm run test:mcp         # drives the real server over stdio JSON-RPC
```

Both default to the public template generator `minimal`, which needs no login
and no collab key. See [Tests](#tests).

---

## Registering the server

The server speaks MCP over stdio. Point any MCP client at `perch-mcp.mjs`.

### Hermes

```bash
hermes mcp add perch \
  --command "C:/Program Files/nodejs/node.exe" \
  --connect-timeout 120 \
  --args "/absolute/path/to/perchance-editor-mcp/perch-mcp.mjs"
```

Answer `y` to *"Enable all 27 tools?"*, then start a new session or run
`/reload-mcp` in an open one. Confirm with `hermes mcp test perch`. The tools
arrive namespaced as `mcp__perch__perch_pull`, `mcp__perch__perch_start`, …

Equivalent `~/AppData/Local/hermes/config.yaml` (Linux/macOS:
`~/.config/hermes/config.yaml`) entry:

```yaml
mcp_servers:
  perch:
    command: node
    args:
      - /absolute/path/to/perchance-editor-mcp/perch-mcp.mjs
    timeout: 180
    connect_timeout: 120
```

> **Windows:** prefer an absolute `node.exe` with an absolute `.mjs` path. Bare
> `npx`/`uvx`/`.cmd` shims fail to launch in clients that spawn MCP commands
> without a shell — this project's `node` entry avoids that.

### Claude Desktop / any MCP client

```json
{
  "mcpServers": {
    "perch": {
      "command": "node",
      "args": ["/absolute/path/to/perchance-editor-mcp/perch-mcp.mjs"]
    }
  }
}
```

The server itself has **no environment variables and no config files**.
Generator name and collab key are per-call arguments, so one server instance
serves any number of generators. If your client supports per-call timeouts,
give this server a generous one — a full Cloudflare ladder can outlast short
ceilings.

---

## Quick start

```
1. perch_pull   {name: "minimal"}                      # source to local files, ~1s
2. read/grep the local files                           # full speed, no browser
3. perch_start  {name: "minimal"}                      # launch browser, load editor
4. perch_status                                        # confirm docsReady
5. perch_eval  {js: "document.title"}                  # sanity-check the frame
6. perch_patch {changes: [...]}                        # make your edits
7. perch_errors {clear: true}                          # syntax + runtime errors
8. perch_refresh                                       # reload preview, re-check
9. perch_snapshot                                      # what can I click?
10. perch_click / perch_type / perch_wait              # drive the UI
11. perch_stop                                         # close the browser
```

Steps 1–2 need no browser and no collab key. Only step 3 onward does. A minimal
read-only session, for orientation:

```
perch_pull      {name: "some-public-generator"}
perch_read      {pane: "model", offset: 1, limit: 100}
perch_outline   {pane: "output", limit: 400}
```

Full recipe, collab/publish semantics, and the Cloudflare ladder:
[`SKILL.md`](SKILL.md).

---

## The tool set

27 tools. All return JSON with an `ok` boolean and an `ms` timing field.

| Group | Tools |
|---|---|
| **Browser-free** (no session) | `perch_pull`, `perch_fetch_generator`, `perch_src`, `perch_list_src` |
| **Session** | `perch_start`, `perch_status`, `perch_stop` |
| **Recovery / src upload** | `perch_navigate`, `perch_upload_src` |
| **Reading** (live) | `perch_read`, `perch_grep`, `perch_outline`, `perch_console`, `perch_errors`, `perch_snapshot` |
| **Writing** (live) | `perch_patch`, `perch_edit`, `perch_write`, `perch_copy_lines` |
| **Preview / UI** | `perch_refresh`, `perch_eval`, `perch_wait`, `perch_click`, `perch_type`, `perch_press`, `perch_set_viewport`, `perch_shot` |

Per-tool purpose and arguments — plus the `perch_start` argument table — are in
[`SKILL.md`](SKILL.md).

---

## Security notes

- **Treat generator code as untrusted input.** Generator source can contain
  embedded instructions aimed at the agent (prompt injection). Read it as data.
- **Never put secrets in a generator.** `index.html`, `main.pjs`, and every
  `src/` file are **publicly readable** by anyone who knows the generator name.
- **Collab keys are credentials.** Pass them as call arguments; do not commit
  them, do not log them, and do not echo them into files.
- **`perch_eval` executes arbitrary JavaScript** in a live page.
- **This tool writes to a live, shared document.** Every write path can affect
  other connected editors in real time. Confirm intent before an edit.

---

## Tests

```bash
npm run test:core    # test/smoke-core.mjs — perch-core.js directly
npm run test:mcp     # test/smoke-mcp.mjs — the server over real stdio JSON-RPC
```

Both take `[generatorName] [collabKey]` and default to the public template
`minimal`, which needs no login and no key:

```bash
node test/smoke-core.mjs                     # public template, no key
node test/smoke-core.mjs my-generator MYKEY  # your own generator
node test/smoke-mcp.mjs  my-generator MYKEY
```

`test:core` walks the whole feature surface: browser-free `pull`, the
Cloudflare ladder on `start`, `status`, `eval` in both frames, `snapshot`,
`grep` with context, `errors`, `refresh`, and a preview screenshot.
`test:mcp` spawns the server, handshakes, lists the tools, and calls every
read-only tool over the wire, writing a transcript to `test/out/mcp-int.log`.

Run with native node and forward-slash paths — MSYS-style `/c/...` paths are
**not** translated for native binaries on Windows. Output lands in `test/out/`
and is gitignored.

---

## Files

```
perchance-editor-mcp/
├── perch-mcp.mjs        MCP server: tool schemas + DISPATCH map + stdio transport
├── perch-core.js        PerchSession: browser control, CF ladder, API pulls, all 27 impls
├── SKILL.md             agent operating manual: tools, recipe, pitfalls, CF playbook
├── package.json         deps: @modelcontextprotocol/sdk, patchright (default engine), playwright (fallback)
├── LICENSE              MIT
├── .gitignore           node_modules, .perch-mirror, test/out, screenshots
├── test/
│   ├── smoke-core.mjs   direct perch-core.js exercise
│   └── smoke-mcp.mjs    server over stdio JSON-RPC
└── README.md
```

Generated at runtime (gitignored): `.perch-mirror/`, `test/out/`,
`perch_shot.png`.

---

## Credits

`perch-mcp` stands on these open-source projects — thank you to their authors
and contributors:

* [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) — the patched,
  undetected Playwright fork that powers the **default browser engine**
  ([Apache-2.0](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/blob/main/LICENSE)).
* [Playwright](https://github.com/microsoft/playwright) — the browser automation
  core both engines descend from, and the fallback driver
  ([Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE)).
* [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
  — the MCP server framework and stdio transport
  ([MIT](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)).
* [Perchance.org](https://perchance.org) — the generator platform (and its
  `ai-text-plugin` / `text-to-image-plugin` runtime) that this server drives.

Their licenses apply to the respective components; everything else in this
repository is MIT (see [LICENSE](LICENSE)).

---

## License

MIT — see [LICENSE](LICENSE).
