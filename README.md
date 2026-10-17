# Mandat for Alexa+

**Give Alexa a budget, not a to-do list.**

Mandat is an Alexa+ add-on for household errands. You set a budget once ("keep it under $400",
"$150 a week, buy on your own under $40"). Mandat finds local services and products, negotiates with each
merchant's AI agent, asks before paying, places PayPal payment holds (sandbox) and remembers the household
from one session to the next.

> Hackathon entry for Amazon "Build, Ship, Shape" (Alexa+ track, AWS Builder mini-challenge).
> Unofficial Alexa+ simulator. PayPal sandbox only: no real money moves.

## What is in the box

| Part | What it is | Where |
|---|---|---|
| MCP server | MCP 2025-11-25 over Streamable HTTP (stateless, JSON responses), 10 intent tools + 1 app-only tool | `src/mcp/server.mjs` |
| MCP Apps | 5 cards (`ui://` resources, `text/html;profile=mcp-app`): status, budget, options, plan, receipt | `src/ui/` |
| Agent Skill | `mandat-household-errands` (agentskills.io format): money rules, 3 playbooks, voice style | `skill/` |
| Alexa+ web simulator | Voice-first page: a real MCP client and MCP Apps host, Echo Show 15 / Show 8 / Echo Dot modes, JSON-RPC drawer | `simulator/` |
| Orchestrator | Strands Agents (TypeScript) on Amazon Bedrock, McpClient to the server, AgentSkills plugin | `orchestrator/` |
| Household logic | Budgets (envelopes), negotiated quotes, plans, holds, changes, partial capture, refunds | `src/mandat.mjs`, `src/core/` |

### Tools

| Tool | Does |
|---|---|
| `get_household_status` | Budgets left, open orders, saved preferences, plans waiting for a yes |
| `set_spending_mandate` | Budget + period + auto-approve rule, one-time PayPal approval |
| `remember_preference` | Allergies, brands, notes, kept across sessions |
| `find_home_services` | Asks every matching merchant agent in parallel, verifies signed agent cards, up to 5 quotes |
| `find_products` | Products filtered by household preferences, usual brand first |
| `negotiate_offer` | One more round with a merchant agent (never below its floor) |
| `propose_plan` | Price breakdown, budget check, auto-approve or "needs your yes", confirmation token |
| `confirm_plan` | PayPal authorization holds, idempotent on the plan |
| `change_order` | New date, time or quantity; a declined change voids the hold and returns replacements |
| `close_order` | Capture (partial: the rest is released), cancel, refund |

## Run it

Requirements: Node.js 22+.

```bash
npm ci
npm test                      # 31 tests, no network, no AWS, no paid API
npm run demo                  # http://127.0.0.1:8787/simulator/
```

Strands orchestrator (optional locally, used on AWS):

```bash
cd orchestrator && npm ci && npm test      # 3 tests, Strands agent loop with a scripted model
cd .. && MANDAT_BRAIN=strands npm run demo
```

Without AWS keys everything runs on the simulated providers: merchant agents answer from their own terms,
payments are simulated PayPal calls clearly marked `offline`. Settings are listed in `.env.example`.

### Try the three stories (type or say them in the simulator)

1. *Set a weekly household budget of $150, and buy on your own under $40.* · *Remember that Max, our dog, is allergic to chicken.* · *Remember we drink Northbeam medium roast.*
2. *Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.* → *Yes, book it.*
3. *We're almost out of dog food and coffee.* → *Yes.*
4. *Their flight moved to Sunday.* → *Yes, go ahead.* → *Everything went well. Settle up: Olive billed $180, and refund the $28 pillowcases.*

Press **D** for the JSON-RPC drawer (initialize, tools/list, resources/read, tools/call, MCP Apps messages).

## Architecture

```
Browser: Alexa+ simulator (MCP client + MCP Apps host, Web Speech in, Polly or browser voice out)
   │ 1) MCP Streamable HTTP: initialize / tools/list / resources/read / tools/call (card buttons)
   │ 2) POST /turn ─► orchestrator: Strands agent on Bedrock (or the simulated brain)
   ▼                    │ McpClient (Streamable HTTP)
Mandat MCP server (/mcp, stateless; AWS Lambda + Function URL; locally node :8787)
   ├─ DynamoDB (one table: household, budgets, envelopes, offers, plans, orders, preferences, events)
   ├─ PayPal sandbox (vault, authorize / capture / void / refund)
   ├─ Merchant network (signed agent cards, merchant agents on Bedrock Nova 2 Lite)
   └─ Products (sandbox catalogue; Channel3 when enabled)
```

## Money safety

- Nothing is paid before `confirm_plan`, which needs the token issued for that exact plan.
- Above the household's auto-approve rule, `confirm_plan` also needs the user's explicit yes.
- The budget is checked when the plan is proposed and again when it is confirmed.
- `confirm_plan` is idempotent: a retry returns the same receipt, nothing is held twice.
- A merchant agent's quote is clamped to the merchant's floor and list price, whatever the model says.

## Before / After

<!-- TODO (owner): fill before submission. Keep it factual, with the commit range. -->

**Before (existing project, before 31 Aug 2026):** _placeholder_ — Mandat, a PWA web app with its own chat,
NVIDIA Nemotron on Nebius, Cloudflare R2 storage, travel and restaurant flows.

**After (built during the submission period):** _placeholder_ — MCP server (2025-11-25), MCP Apps cards,
Agent Skill, household categories, DynamoDB memory, recurring budgets with auto-approve, change / cancel /
refund flows, screenless mode, Bedrock + Strands, AWS deployment.

**Commit range:** _placeholder_ (first commit of this repo = the copied core, `git log --reverse`).

## Built with

MCP TypeScript SDK 1.32.1 · MCP Apps (spec 2026-01-26) · Agent Skills · Strands Agents TypeScript SDK 1.21.0 ·
Amazon Bedrock · AWS Lambda · Amazon DynamoDB · Amazon Polly · PayPal Server SDK (sandbox)

## License

MIT, see [LICENSE](LICENSE).
