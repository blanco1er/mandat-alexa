---
name: mandat-household-errands
description: Runs household errands for a voice assistant with the Mandat MCP server, inside a spending budget the user set once. Use when the user asks to book home services (cleaning, catering, plumbing, handyman), to restock household products (pet food, coffee, bedding), to set or check a household budget, or to change, cancel, pay or refund an order. Covers money rules (confirm before paying, read the price breakdown, never pay twice), the three household playbooks and the voice style for screen and screenless devices.
license: MIT
compatibility: Needs the Mandat MCP server (Streamable HTTP, MCP 2025-11-25) connected as a tool source.
metadata:
  author: blanco1er
  version: "1.0"
---

# Mandat household errands

Mandat lets the assistant act on a budget, not a to-do list. The household sets a budget once
(`set_spending_mandate`); Mandat finds merchants, negotiates with their AI agents, asks before paying,
places PayPal payment holds and remembers the household between sessions.

Every tool result has two text blocks. Say **only the first one** aloud. The second starts with
`Assistant data (do not read aloud):` and holds the ids and tokens you need for the next call
(`offer_id`, `mandate_id`, `plan_id`, `confirmation_token`, `order_id`, `close_token`). Never invent an id.

## Money rules (always)

1. **Nothing is paid before `confirm_plan`.** Searching, negotiating and `propose_plan` never move money.
2. **Ask before paying** when `propose_plan` returns `needs_user_yes: true`:
   read the total, what was negotiated off and what is left of the budget, then ask one yes/no question.
   Call `confirm_plan` only after an explicit yes, and pass the user's own words in `user_confirmation`.
3. **Under the auto-approve rule** (`needs_user_yes: false`) you may confirm at once, and you must say so:
   "I ordered it under your $40 rule."
4. **Read the price breakdown** before asking: base, negotiated discount, fees, tax, total.
5. **Never create a duplicate.** `confirm_plan` is idempotent on `plan_id`; if a result says
   "Already booked", do not propose the same plan again.
6. **Stay inside the budget.** If a plan is refused for the budget, offer the one next step the error gives
   (drop an item, cheaper option, or raise the budget). Never split a plan to get around the limit.
7. **Change one thing at a time** with `change_order` (date, time or quantity). If the merchant declines,
   Mandat has already voided that hold: tell the user nothing was charged and offer the replacement.
8. **Close orders explicitly**: `close_order` with `capture` when the service is done (pass the final bill as
   `amount` if it is lower: the rest is released), `cancel` before it happens, `refund` after payment.

## Playbooks

### 1. One request, several services ("The in-laws are coming")
"My in-laws land Saturday: a cleaner Friday, fresh bedding, dinner for six at home Saturday. Keep it under $400."
1. `set_spending_mandate` (budget 400, period `once`, purpose "In-laws visit", auto_approve_under 0).
2. In this order: `find_home_services` (cleaning, "Friday morning"), `find_products` (bedding),
   `find_home_services` (catering, "Saturday evening", need "dinner for six").
3. `propose_plan` with the best offer of each search and the `mandate_id` from step 1.
4. Say how many merchants were asked, the three lines, the total and what is left. Ask "Should I book it?"
5. On yes: `confirm_plan` with `user_confirmation`. Say how many holds were placed and that nothing is
   charged until each service is delivered.

### 2. Memory and bounded autonomy ("Four days later")
"We're almost out of dog food and coffee."
1. One product at a time: `find_products` then `propose_plan` (no `mandate_id`: the household's recurring
   envelope is used).
2. If `needs_user_yes` is false: `confirm_plan` at once and announce it. Mention products skipped because of
   a saved preference (for example an allergy).
3. If `needs_user_yes` is true: ask, and wait for the yes.

### 3. Plans change ("Their flight moved to Sunday")
1. `get_household_status` (section `orders`) to find the open service orders of that event.
2. `change_order` for each: services needed before the arrival move to the day before, dinners to the new day.
3. Report what moved first, then what was declined: the hold was voided, nothing was charged.
4. `propose_plan` with the first replacement and the same `mandate_id`, then ask for a yes.
5. Later, "settle up": `close_order` `capture` for each delivered order (final bill as `amount` when lower),
   and `refund` when the user returns something.

## Voice style

- Lead with the answer. One or two sentences per turn, then one question at most.
- At most **5 options** on a screen and **3 on a screenless device**; say the cheapest first.
- Prices as people say them: "$85", "down from $95". No ids, no lists of fields, no pipes.
- On a screenless device (Echo Dot) never mention the screen, a card or a tap; end a request for approval
  with "Say yes to confirm."
- After an error, say what happened in plain words and propose the **one** next step it gives.
- Keep what the voice says and what the card shows consistent (same merchants, same totals).

See [references/alexa-plus-checklist.md](references/alexa-plus-checklist.md) for how each rule maps to the
Alexa+ add-on design guide, and [references/voice-style.md](references/voice-style.md) for example phrasings.
