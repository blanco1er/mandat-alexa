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
| 11 | Amazon Bedrock model access | High | On a new account, the newest Claude models answer `AccessDeniedException` "not available for this account" with no reason given |
| 12 | Amazon Bedrock quotas | High | Nova 2 Lite on a new account: 20 requests/minute per inference profile (not adjustable for the US profile); one agent turn makes 6 model calls |
| 13 | Strands Agents TS 1.21 × Bedrock | Medium | A `ThrottlingException` on the request (HTTP 429) becomes a plain `ModelError`, so the default retry strategy never retries it |
| 14 | Strands Agents TS 1.21 AgentSkills × Nova 2 Lite | Medium | The model called the `skills` tool before acting in only 4 of 11 turns and skipped the playbooks otherwise |
| 15 | AWS Lambda on a new account | Medium | Account concurrency limit is 10: reserving even 1 execution is refused, so reserved concurrency cannot cap a public demo |
| 16 | Amazon Bedrock model catalogue | Low | Listed ids that do not work: Nova Premier (profile listed, "end of its life"), Nova 2 Pro (priced and quota'd, id invalid) |
| 17 | Alexa+ account-linking docs × MCP authorization | Medium | The page never says how Alexa sends the access token, nor names RFC 9728 / `WWW-Authenticate`, which the MCP spec relies on |
| 18 | Alexa+ Permissions (customer data) | Medium | The Permissions page says Alexa asks for name, email, address, but not how the granted values reach an MCP add-on |
| 19 | Alexa+ account linking, end to end | Medium | Alexa's redirect URIs live in the Alexa+ Developer Hub (Private Preview): the real linking round-trip cannot be tested without access |
| 20 | Amazon Nova 2 Lite (Strands) off the script | High | Live, a repeated "Yes, book it" with nothing waiting made the model capture two held orders; a too-early yes surfaced a raw validation error |

---

### 1. No public Alexa+ simulator or inspector to test an MCP add-on
- **Task attempted:** see our MCP Apps cards and our voice flow the way an Echo Show would render them, before recording the demo.
- **Steps taken:** read the Alexa+ add-on docs (design guide, functional requirements, client lifecycle); looked for the Web Simulator / Local Inspector they mention.
- **Expected:** a public simulator (even a reduced one) where any developer can point an MCP server URL and see cards, voice and device sizes.
- **Actual:** the Alexa+ add-on tooling (Web Simulator and Local Inspector) is in Private Preview only. Nothing to run as an independent developer without an invitation.
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
- **Workaround:** every AWS integration has a local stand-in (simulated merchants, scripted Strands model, JSON store, browser voice) so the whole product runs and is tested without an account; once deployed (on the owner's own new account, free plan), a hard model budget shared by every Lambda container (`MANDAT_LLM_BUDGET_USD`, one DynamoDB counter), per-address limits and an AWS Budgets alert cap the bill (reserved concurrency could not be used, see #15).
- **Suggestion:** a small per-entrant Bedrock allowance, or a sandbox account with model access pre-approved for hackathon entrants.

### 11. Newest Claude models "not available for this account" on a new AWS account
- **Task attempted:** run the Alexa+ brain (Strands `BedrockModel`) on Claude Haiku 5.5 as first planned, on a brand-new AWS account (free plan, us-east-1), 18 Oct 2026.
- **Steps taken:** `aws bedrock-runtime converse --model-id us.anthropic.claude-haiku-5-5` (and `us.anthropic.claude-sonnet-5-5`); both profiles are listed by `aws bedrock list-inference-profiles`.
- **Expected:** an answer, or an error that says what to do (enable access, upgrade the plan, wait).
- **Actual:** `AccessDeniedException: anthropic.claude-haiku-5-5 is not available for this account. You can explore other available models on Amazon Bedrock. For additional access options, contact AWS Sales`. The same call to `us.anthropic.claude-haiku-4-5-20251001-v1:0` answered. No reason is given (plan? account age? model generation?), while `list-inference-profiles` lists both profiles.
- **Severity:** High (a design change on deploy day).
- **Workaround:** moved the brain to **Amazon Nova 2 Lite** and the merchant agents to **Amazon Nova Lite** (first-party models available on every account); Claude stays a documented optional provider (`MANDAT_BEDROCK_BRAIN_ID`), and the deploy script builds its IAM policy from whatever model ids are configured.
- **Suggestion:** say *why* in the error (for example "requires a paid support plan / account age"), and show the access status in `list-inference-profiles` so builders find out before they write code.

### 12. Nova 2 Lite quota on a new account: 20 requests per minute
- **Task attempted:** replay our three demo stories (11 voice turns) through the Strands agent on Nova 2 Lite.
- **Steps taken:** ran `npm run live:scenarios`; one in-laws turn makes about 6 brain calls plus 6 merchant-agent calls in parallel.
- **Expected:** a short demo to run without throttling on a pay-as-you-go account.
- **Actual:** after about 20 calls, every call failed with `Too many requests, please wait before trying again.` Service Quotas shows "Cross-region model inference requests per minute for Amazon Nova 2 Lite" = **20, not adjustable**; the global profile has its own pool of 20 (adjustable); Amazon Nova Lite has 200.
- **Severity:** High (8 of 11 turns failed on the first run).
- **Workaround:** merchant agents moved to Amazon Nova Lite (its own 200/minute pool, a fifth of the price); the brain uses a Strands `ModelRouter` that falls back from the `us.` profile to the `global.` one; throttled calls are retried with backoff (#13). Result: 33/33 turns on three full runs.
- **Suggestion:** document per-profile request pools next to each model, and give new accounts a default that fits one agentic demo (an agent turn is many calls, not one).

### 13. Strands TS: request-level throttling is not retried
- **Task attempted:** rely on Strands' default retry strategy (6 attempts, exponential backoff) to ride out Bedrock throttling.
- **Steps taken:** read `retry/default-model-retry-strategy.js` and `models/bedrock.js` in `@strands-agents/sdk` 1.21.0 after seeing turns fail at once.
- **Expected:** a Bedrock `ThrottlingException` to be retried.
- **Actual:** only `ModelThrottledError` is retryable, and `BedrockModel` raises it only for a throttling event *inside* a stream. When `ConverseStream` itself is refused with HTTP 429, the error is wrapped as a generic `ModelError` (`models/model.js`) and surfaces immediately.
- **Severity:** Medium.
- **Workaround:** a 3-line subclass of `DefaultModelRetryStrategy` whose `isRetryable` also accepts throttling messages and causes (`orchestrator/brain.mjs`), plus the `ModelRouter` fallback.
- **Suggestion:** map `ThrottlingException` / `ServiceUnavailableException` from the request to `ModelThrottledError` in `BedrockModel`.

### 14. AgentSkills: the model has to choose to load the skill, and Nova 2 Lite often did not
- **Task attempted:** let the Strands `AgentSkills` plugin load our `mandat-household-errands` skill on demand (progressive disclosure), as with the scripted model.
- **Steps taken:** logged `skills.getActivatedSkills(agent)` after each live turn.
- **Expected:** the model calls the `skills` tool before the first Mandat tool, as the system prompt asks.
- **Actual:** it did in 4 of 11 turns. Without the playbook, story 3 went wrong (cleaning moved to the wrong day, two products bundled into one plan, a budget raised on its own).
- **Severity:** Medium.
- **Workaround:** with Bedrock, the host pins the skill's instructions (read with `Skill.fromDirectory`) into the system prompt; the plugin stays for the skill's reference files. Money-critical rules are also enforced outside the model: the host writes the user's own words into `user_confirmation` and refuses `set_spending_mandate` when no amount was said; the server refuses a bundled plan under an auto-approve rule.
- **Suggestion:** an `AgentSkills` option to pre-activate skills (`activate: ['name']`) for single-purpose agents, and a hook to know when a turn ran without its skill.

### 15. Lambda on a new account: no reserved concurrency possible
- **Task attempted:** cap the public demo with reserved concurrency (5) in the one-command deploy.
- **Steps taken:** `aws lambda put-function-concurrency --reserved-concurrent-executions 1` (even 1).
- **Expected:** the reservation, as in every Lambda guide.
- **Actual:** `InvalidParameterValueException: Specified ReservedConcurrentExecutions for function decreases account's UnreservedConcurrentExecution below its minimum value of [10]` — `get-account-settings` shows a total limit of 10.
- **Severity:** Medium (the documented way to bound cost and abuse does not exist on a new account).
- **Workaround:** the deploy script reads the account limit and skips the reservation when it cannot be made; the bill is capped by a model budget shared across containers (DynamoDB atomic counter), per-address limits on `/turn`, `/tts` and `/mcp`, and an AWS Budgets alert.
- **Suggestion:** mention the new-account limit of 10 in the reserved-concurrency docs and console, and offer a per-function maximum that does not consume the unreserved pool.

### 16. Model ids listed but not callable
- **Task attempted:** compare Nova models for tool use before choosing the brain.
- **Steps taken:** `list-inference-profiles` and `list-foundation-models`, then one Converse call each.
- **Expected:** listed ids to work, or to be marked.
- **Actual:** `us.amazon.nova-premier-v1:0` is listed and answers `ResourceNotFoundException: This model version has reached the end of its life`; "Nova 2 Pro" has prices in the Price List API and quotas in Service Quotas ("Nova 2 Pro Preview", 1 request/minute) but no callable id (`amazon.nova-2-pro-v1:0` → `The provided model identifier is invalid`).
- **Severity:** Low.
- **Workaround:** picked from what answered: Nova 2 Lite (brain, native parallel tool calls, no `<thinking>` text) over Nova Pro (it writes `<thinking>` blocks into the answer, which a voice would read aloud).
- **Suggestion:** hide end-of-life profiles from the listing, and show preview models with their access status.

### 17. How does the access token reach an MCP add-on?
- **Task attempted:** implement account linking for Mandat exactly as Amazon's *Account Linking for Alexa+ MCP add-ons* page describes (18 Oct 2026).
- **Steps taken:** read the page end to end; built an OAuth 2.1 authorization server (code + PKCE S256, `resource` parameter, refresh tokens, static clients, the well-known metadata document, 401/403 without a token).
- **Expected:** the page to say how the token is attached to each MCP request (the MCP 2025-11-25 authorization spec uses `Authorization: Bearer` and a `WWW-Authenticate` header pointing at the RFC 9728 document), and whether Alexa reads RFC 8414 authorization-server metadata.
- **Actual:** it says only that Alexa "includes this access token in every request"; the header, `WWW-Authenticate`, RFC 9728 and RFC 8414 are not named, although its metadata document is RFC 9728's `oauth-protected-resource`.
- **Severity:** Medium (we had to infer the transport from the MCP spec).
- **Workaround:** we follow the MCP spec on both sides: `Authorization: Bearer`, HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, RFC 9728 and RFC 8414 documents, and the simulator discovers everything from the 401 like a client would.
- **Suggestion:** one sentence and one sample request on the page: the header Alexa sends, and that the 401 should carry `WWW-Authenticate` with `resource_metadata`.

### 18. Customer-data permissions for MCP add-ons are not specified
- **Task attempted:** greet the household by name and book at its address, using Alexa's customer-data permissions instead of asking again.
- **Steps taken:** read *Supported capabilities* (Category SDK) and the *Permissions* page it links to.
- **Expected:** the permission names (name, email, address), how they are declared, and how the granted values reach the add-on (a field in the request, an API with a consent token like classic skills…), plus what happens when one is revoked.
- **Actual:** the Permissions page says Alexa+ asks the customer to open the Alexa app to grant permissions, and that the customer manages them under Alexa+ Store > add-on > Manage. Nothing about delivery of the values, and the page sits under the Category SDK, not the MCP toolkit.
- **Severity:** Medium (that part of our flow has to be simulated).
- **Workaround:** a simulated Alexa-app permission screen (one switch per item) passes the allowed values to an app-only tool; Mandat keeps only what was allowed and deletes a value when its switch is turned off. Marked "simulated" in the README and on the screen.
- **Suggestion:** document the permission scopes and the delivery mechanism for MCP add-ons (for example a signed customer-profile block in `_meta`, or an API with a consent token), and the revocation signal.

### 19. The linking round-trip cannot be tested without the Developer Hub
- **Task attempted:** register Alexa's redirect URIs and run a real account link from an Alexa device.
- **Steps taken:** followed Step 4 of the account-linking page ("In the Alexa+ Developer Hub, find the list of Alexa redirect URIs").
- **Expected:** the redirect URIs (or their pattern) published, or a test redirect for developers outside the preview.
- **Actual:** the URIs are only in the Developer Hub, which needs Private Preview access; the page's sample (`https://alexa.amazon.com/api/skill/link/<id>`) is an example, not a list.
- **Severity:** Medium.
- **Workaround:** the real Alexa client is configured by environment (`MANDAT_OAUTH_CLIENT_ID`, `MANDAT_OAUTH_CLIENT_SECRET`, `MANDAT_OAUTH_REDIRECT_URIS`); the demo uses a second static client (the simulator) with our own redirect page, and `scripts/link-demo.mjs` replays the full PKCE flow for tests and the MCP Inspector.
- **Suggestion:** publish the redirect URI list per region, and an `alexa-ai` command that runs a linking round-trip against a development add-on.

### 20. A yes with nothing waiting: the model paid anyway
- **Task attempted:** check the turns a judge may say off the script on the public URL (19 Oct 2026, 8 Nova 2 Lite turns): a yes before any plan, a swap described in words, a remove, the total mid-way, a language switch, a yes said twice.
- **Steps taken:** Strands agent on `us.amazon.nova-2-lite-v1:0`, our MCP server, the context line carrying the household's close tokens.
- **Expected:** a yes with no plan waiting to do nothing and say so.
- **Actual:** the first early "Yes, book it." made the model call `confirm_plan` with an invented token, and the user heard "the confirmation token provided was too short". After a booking, a second "Yes, book it." made it call `close_order` **capture** on both held orders (sandbox money): it took the yes as "settle up". The server's rules held (valid close tokens), but the intent was wrong. Before our new tool, "Take the sateen set instead" without seeing the options first also got "I couldn't find the sateen set any more".
- **Severity:** High (money moved for a reason the user never gave).
- **Workaround:** the host answers a bare yes with nothing waiting itself (no model call); a host guard refuses `close_order` unless the user's own words ask to settle, cancel or refund (EN/FR/ES); a `swap_item` tool finds an item described in words and offers the closest options when nothing matches. All three are tested; the same eight turns now behave.
- **Suggestion:** a Strands hook or tool annotation for "requires an explicit user intent" (beyond `destructiveHint`), and guidance in the Alexa+ design guide on confirmations that arrive with nothing pending.

### 21. The model drops what is real and what is not
- **Task attempted:** keep "test money", "estimated price" and "booking request" in Alexa's answer once the demo used real products and real local businesses (19 Oct 2026, public URL, Amazon Nova 2 Lite).
- **Steps taken:** each tool's first text block carries the sentence; the skill says to keep it.
- **Expected:** the spoken answer keeps the sentence.
- **Actual:** Nova summarised the mixed plan ("I found a cleaner for Friday, fresh bedding, and dinner… Should I book it?") and dropped it, 2 turns out of 3.
- **Severity:** High for trust (a judge could believe a real business confirmed, or a store received an order).
- **Workaround:** the tool result also carries `honesty` = { text, must }; after the model's turn the host checks the answer and puts the sentence back before the closing question (`src/brain/honesty.mjs`, tested). No extra model call.
- **Suggestion:** a way for an MCP tool to mark a sentence as "must be said verbatim" (for example `_meta.voice.required`), honoured by Alexa+ when it phrases its answer.

### 22. Real data sources: what we had to work around
- **Task attempted:** real products (Channel3) and real local businesses (Google Places, OpenStreetMap) for the three stories.
- **Actual:** Channel3 has no coffee beans (a coffee search returns canisters and grinders), so story 2 moved to laundry detergent, and every search keeps only the category asked for. The public Overpass servers answered 500/502 "at capacity" for a whole morning. OpenStreetMap tags few house cleaners and some restaurants as caterers.
- **Workaround:** a kind check on every product search; Google Places first, OpenStreetMap second, a saved OpenStreetMap snapshot last (also used by the tests); name filters for dry cleaners, commissary kitchens and supply stores; a shared 24-hour cache so judges almost always hit the cache.
- **Suggestion (Alexa+):** a first-party way for an add-on to search Amazon's catalogue and local services with the customer's consent would remove the third-party keys and estimates altogether.


### 23. "Other options?" changed the plan
- **Task attempted:** play the in-laws story on the public URL like a judge (19 Oct 2026, Amazon Nova 2 Lite, Strands agent): "Show me the bed linen", then "Other options?".
- **Steps taken:** the same tools as story 1; `list_alternatives`, `revise_plan` and `swap_item` all available to the model.
- **Expected:** the other sheet sets listed, the plan unchanged until the user picks one.
- **Actual:** the model called `list_alternatives` and then `revise_plan` in the same turn: the plan went from $357.99 to $330.99 with cheaper sheets nobody chose. No money moved (the new plan still needed a yes), but the user lost track of what they were approving.
- **Severity:** Medium (no payment, but the plan the user approves must be the plan the user built).
- **Workaround:** a host guard refuses `revise_plan` and `swap_item` when the user's words only ask to see, list or compare options ("other options?", "show me", "compare", in EN/FR/ES) and contain no change verb ("take", "instead", "swap", "remove"…); tested.
- **Suggestion:** a tool annotation such as `requiresUserChoice` that a host enforces, and a line in the Alexa+ design guide: browsing never edits a pending transaction.
