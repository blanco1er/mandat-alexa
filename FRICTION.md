# Friction log — Mandat for Alexa+

Only things we actually hit while building this entry (17–23 Oct 2026), in the format the hackathon asks for:
task, steps, expected vs. actual, severity, workaround, suggestion. Versions are the ones in `package-lock.json`.

Severity scale: **Blocker** (could not continue) · **High** (hours lost or a design change) · **Medium** (a workaround in code) · **Low** (surprise, quick fix).

| # | Area | Severity | One line |
|---|---|---|---|
| 1 | Alexa+ developer tools | High | No public Alexa+ simulator or inspector: we had to build our own MCP Apps host to see our cards |
| 2 | Alexa+ docs × MCP spec | Low | The Alexa+ client lifecycle example negotiates `2025-03-26`; the hackathon requires `2025-11-25` |
| 3 | Strands Agents TS 1.21 | Medium | Mandatory peer deps (zod 4, MCP client v2) cannot live next to an MCP SDK 1.x / zod 3 server |
| 4 | Strands Agents TS 1.21 × MCP Apps | Medium | Only `content` reaches the model; ids needed to chain calls must be duplicated as text |
| 5 | Strands Agents TS 1.21 × MCP Apps | Medium | `_meta.ui.visibility: ["app"]` is ignored: app-only tools are offered to the model |
| 6 | MCP on AWS Lambda | Medium | Stateless + JSON responses (the only sane Lambda mode) rules out elicitation for the payment confirmation |
| 7 | MCP Apps SDK (`@modelcontextprotocol/ext-apps` 2.0.3) | Low | Requires MCP SDK v2 + zod 4 (+ React peer); a v1 server cannot use it |
| 8 | MCP TypeScript SDK 1.32.1 | Low | `McpServer` announces `listChanged: true` on its own, even when nothing can ever change |
| 9 | MCP Inspector 2.11 CLI | Low | `--protocol-era modern` fails hard against a `2025-11-25` server; a 403 Origin refusal is reported as `auth_required` |
| 10 | AWS promotional credits | High | The $150 hackathon credits were exhausted on 7 Oct, before many builders started on AWS |

---

### 1. No public Alexa+ simulator or inspector to test an MCP add-on
- **Task attempted:** see our MCP Apps cards and our voice flow the way an Echo Show would render them, before recording the demo.
- **Steps taken:** read the Alexa+ add-on docs (design guide, functional requirements, client lifecycle); looked for the Web Simulator / Local Inspector they mention.
- **Expected:** a public simulator (even a reduced one) where any developer can point an MCP server URL and see cards, voice and device sizes.
- **Actual:** the Alexa+ add-on tooling is available to partners only. Nothing to run as an independent developer.
- **Severity:** High (it shaped the project: a full simulator had to be built before the product could be judged visually).
- **Workaround:** we wrote our own voice-first MCP client and MCP Apps host (`simulator/`): Echo Show 15 (1920×1080) and Show 8 (1280×800) canvases at device resolution, Echo Dot screenless mode, `hostContext` with theme / display mode / container dimensions, and a JSON-RPC drawer.
- **Suggestion:** publish a minimal public Alexa+ add-on simulator, or at least the exact `hostContext` an Echo Show sends to an MCP App (theme, device class, container size, safe areas) so third-party hosts can reproduce it.

### 2. The Alexa+ lifecycle example uses protocol `2025-03-26`
- **Task attempted:** match the Alexa+ client handshake exactly while implementing MCP `2025-11-25` as the hackathon requires.
- **Steps taken:** replayed the `initialize` example from the Alexa+ *client lifecycle* page against our server (MCP TypeScript SDK 1.32.1).
- **Expected:** the example to use the version the hackathon requires.
- **Actual:** the example sends `protocolVersion: "2025-03-26"`; the SDK (correctly) answers `2025-03-26` back, so a server cannot "force" 2025-11-25 without refusing older clients.
- **Severity:** Low.
- **Workaround:** our own clients (simulator, Strands orchestrator, tests) ask for `2025-11-25`; a test checks that unknown future versions also fall back to `2025-11-25`.
- **Suggestion:** update the lifecycle example to `2025-11-25` and state which versions the Alexa+ client actually negotiates.

### 3. Strands Agents TS peer dependencies split the codebase
- **Task attempted:** run the Strands orchestrator in the same Node package as the MCP server.
- **Steps taken:** `npm i @strands-agents/sdk@1.21.0` in the server package (MCP SDK 1.32.1, zod 3).
- **Expected:** a library that works next to the current stable MCP server SDK.
- **Actual:** mandatory peer dependencies `zod ^4.5.4` and `@modelcontextprotocol/client ^2.0.0` conflict with the server's zod 3 / SDK 1.x.
- **Severity:** Medium.
- **Workaround:** a separate package `orchestrator/` with its own lockfile; the Lambda zip installs both.
- **Suggestion:** document the supported MCP SDK combinations in the Strands README, or accept zod 3 through a compatibility layer.

### 4. Only `content` reaches the model (Strands + MCP Apps)
- **Task attempted:** let the agent chain `propose_plan` → `confirm_plan` using the `plan_id` and `confirmation_token` returned by the first call.
- **Steps taken:** returned ids in `structuredContent` (rendered by the card); read `@strands-agents/sdk/dist/src/tools/mcp-tool.js`.
- **Expected:** the model can see the structured result.
- **Actual:** Strands' `McpTool` forwards only `content` to the model, and the MCP Apps spec says `structuredContent` is not added to model context either.
- **Severity:** Medium.
- **Workaround:** every tool result carries `content[0]` (what Alexa says, no ids) and `content[1]` ("Assistant data (do not read aloud)": the ids and tokens).
- **Suggestion:** a documented convention (or a `_meta` flag) for "model-only" text in MCP results, so voice clients never read ids aloud by mistake.

### 5. App-only tools reach the model in Strands
- **Task attempted:** keep `refresh_card` (declared `_meta.ui.visibility: ["app"]`) for the cards only, as the MCP Apps spec requires of hosts.
- **Steps taken:** listed the agent's tools through Strands `McpClient.listTools()`.
- **Expected:** app-only tools filtered out of the model's tool list.
- **Actual:** Strands 1.21 does not read `_meta.ui.visibility`; `refresh_card` was offered to the model.
- **Severity:** Medium.
- **Workaround:** `toolFilters: { rejected: ['refresh_card'] }` on the `McpClient`, with a test that the model never sees it.
- **Suggestion:** honour MCP Apps visibility in Strands' MCP client (or expose `_meta` to tool filters).

### 6. No elicitation on a stateless Lambda MCP server
- **Task attempted:** ask the user "Approve $372?" through MCP elicitation before placing payment holds.
- **Steps taken:** server on Lambda + Function URL, `StreamableHTTPServerTransport` stateless with `enableJsonResponse: true` (no SSE stream, no session).
- **Expected:** a way to request user input mid-call in the recommended serverless setup.
- **Actual:** server-to-client requests need a live stream or a session; neither exists in this mode.
- **Severity:** Medium.
- **Workaround:** two-step confirmation: `propose_plan` returns a short-lived `confirmation_token`; `confirm_plan` needs it plus the user's own words in `user_confirmation` above the auto-approve threshold. The server refuses "maybe" or a missing yes (tested).
- **Suggestion:** an AWS sample for MCP elicitation on serverless (e.g. Lambda response streaming) or guidance for confirmation flows without it.

### 7. MCP Apps SDK requires MCP SDK v2
- **Task attempted:** use `@modelcontextprotocol/ext-apps` 2.0.3 for the card bridge.
- **Steps taken:** checked its peer dependencies against our server.
- **Expected:** usable from a server on the stable MCP SDK 1.x.
- **Actual:** peers are MCP SDK v2, zod 4 and React.
- **Severity:** Low.
- **Workaround:** a dependency-free 150-line bridge (`src/ui/bridge.js`) implementing `ui/initialize`, tool input/result notifications, `tools/call`, display modes, size changes and teardown from the spec text.
- **Suggestion:** ship a framework-free, SDK-agnostic bridge build.

### 8. `McpServer` announces `listChanged: true` by itself
- **Task attempted:** describe our stateless server's capabilities truthfully.
- **Steps taken:** declared `tools: { listChanged: false }` in the constructor; ran MCP Inspector `--method initialize`.
- **Expected:** our declared capabilities.
- **Actual:** `McpServer.registerTool` / `registerResource` merge `listChanged: true` in, overriding ours.
- **Severity:** Low.
- **Workaround:** `server.server.registerCapabilities({ tools: { listChanged: false }, resources: { listChanged: false } })` after registration (test added).
- **Suggestion:** respect an explicit `listChanged: false`.

### 9. MCP Inspector CLI protocol eras and error codes
- **Task attempted:** run the official Inspector (CLI, 2.11.0) against the server in every mode, recorded in `docs/inspector/`.
- **Steps taken:** `--protocol-era legacy|auto|modern`; a request with a foreign `Origin` header.
- **Expected:** `modern` to fall back or explain; a 403 to be reported as forbidden.
- **Actual:** `modern` pins `2026-07-28` via `server/discover` and stops ("no fallback in pin mode"); the 403 Origin refusal comes back as `"code": "auth_required"`.
- **Severity:** Low.
- **Workaround:** `auto` (falls back to `2025-11-25`); our check looks at the HTTP status instead of the code.
- **Suggestion:** a clearer message when the server only speaks `2025-11-25`, and a distinct error code for 403.

### 10. AWS promotional credits ran out before the build week
- **Task attempted:** request the $150 AWS credits offered to registered entrants.
- **Steps taken:** read the rules and the request form notice.
- **Expected:** credits for the AWS Builder mini-challenge.
- **Actual:** "while supplies last": exhausted on 7 Oct; Bedrock, Polly and the rest are paid by the entrant.
- **Severity:** High for individual builders (it decides whether the Bedrock path gets built at all).
- **Workaround:** every AWS integration has a local stand-in (simulated merchants, scripted Strands model, JSON store, browser voice) so the whole product runs and is tested without an account; a budget cap (`MANDAT_LLM_BUDGET_USD`) and reserved concurrency limit the bill once deployed.
- **Suggestion:** a small per-entrant Bedrock allowance, or a sandbox account with model access pre-approved for hackathon entrants.
