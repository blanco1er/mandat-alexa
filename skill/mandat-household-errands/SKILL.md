---
name: mandat-household-errands
description: Runs household errands for a voice assistant with the Mandat MCP server, inside a spending budget the user set once. Use when the user asks to book home services (cleaning, catering, plumbing, handyman), to restock household products (pet food, laundry, bedding), to set or check a household budget, or to change, cancel, pay or refund an order. Covers money rules (confirm before paying, read the price breakdown, never pay twice), honesty about real and simulated data, the three household playbooks and the voice style for screen and screenless devices.
license: MIT
compatibility: Needs the Mandat MCP server (Streamable HTTP, MCP 2025-11-25) connected as a tool source.
metadata:
  author: blanco1er
  version: "1.0"
---

# Mandat household errands

Mandat lets the assistant act on a budget, not a to-do list. The household sets a budget once
(`set_spending_mandate`); Mandat finds real local businesses and real products, negotiates with demo partner
agents, asks before paying, places PayPal sandbox payment holds (test money) and remembers the household between
sessions.

## What is real, what is simulated (say it the way the results say it)

- **Real local businesses** (Google Maps or OpenStreetMap): their price is an **estimate** and the booking is a
  **booking request** that Mandat does not send in this demo. Never say a real business agreed, accepted, confirmed,
  negotiated or lowered a price. Say "about $100 estimated".
- **Demo partners**: simulated merchant agents. They are the only ones that quote and negotiate. Say "a demo partner".
- **Products** are real (real stores, real prices, United States, USD), but Mandat never orders from the store.
- **Money** is PayPal sandbox test money (or simulated payments). The first text block already says this: keep it.

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
   **Find the order from what the user named**: "the sheets" is the bed-linen order, "Olive" is Olive & Thyme
   Kitchen; match the item, trade or merchant against the receipts (never another order of the same budget). If
   the server answers that the order does not match, call again with the order_id it gives.

## Playbooks

### 1. One request, several services ("The in-laws are coming")
"My in-laws land Saturday: a cleaner Friday, fresh bedding, dinner for six at home Saturday. Keep it under $400."
1. `set_spending_mandate` (budget 400, period `once`, purpose "In-laws visit", auto_approve_under 0).
2. In this order: `find_home_services` (cleaning, "Friday morning"), `find_products` (query "queen sheet set",
   no quantity, `max_price` about a fifth of the budget, e.g. 80 for $400), `find_home_services` (catering,
   "Saturday evening", need "dinner for six", guests 6).
3. `propose_plan` with the `recommended_offer_id` of each search (offers are listed best first) and the
   `mandate_id` from step 1.
   If it is refused for the budget, try once more on your own with the cheapest offer of each search before
   asking the user what to drop.
4. Say what was found (real businesses near home, demo partners), the three lines as the result says them, the
   total and what is left, and the one honesty sentence. Ask "Should I book it?"
5. On yes: `confirm_plan` with `user_confirmation`. Say how many holds were placed, that nothing is
   charged until each service is delivered, and that a real business only has a booking request.

### 2. Memory and bounded autonomy ("Four days later")
"We're almost out of dog food and laundry detergent."
1. **One product per plan**, never both in one plan: `find_products` (in English: "dry dog food", "laundry
   detergent"; the household's usual brand is searched by Mandat) then `propose_plan` with only that
   product's `recommended_offer_id` (no `mandate_id`: the household's recurring envelope is used). Separate plans
   let the cheap item go through under the auto-approve rule while the expensive one waits for a yes.
2. If `needs_user_yes` is false: `confirm_plan` at once and announce it. Mention products skipped because of
   a saved preference (for example an allergy).
3. If `needs_user_yes` is true: ask, and wait for the yes.

### 3. Plans change ("Their flight moved to Sunday")
1. `get_household_status` (section `orders`) to find the open orders of that event (its `budget`, e.g. "In-laws visit").
2. One `change_order` (field `date`) for **each open service order** of that event, both of them (a booking
   request to a real business is updated by Mandat; a demo partner answers for itself):
   - a service needed before the guests arrive (cleaning) moves to **the day before** the new arrival day
     ("moved to Sunday" -> cleaning on Saturday);
   - a service for the guests (dinner, catering) moves to **the new day** (Sunday).
   Products already delivered (bedding) do not move.
3. Report what moved first (a request is still not confirmed by the business), then what was declined: the hold
   was voided, nothing was charged.
4. A declined change returns `alternatives` and a `replacement` hint: `propose_plan` with that offer_id and the
   **same `mandate_id`** as the declined order (never the weekly envelope), then ask for a yes.
5. Later, "settle up" (everything was delivered):
   - `close_order` `capture` for **each held order of that event**, with the final bill as `amount` when the user
     gives one for that merchant ("Olive billed $180": capture $180 on the Olive & Thyme order, the rest is released);
   - a refund applies to a paid order: capture it first, then `close_order` `refund` with the amount
     ("refund $10 on the sheets": capture the bedding order, then refund $10 on it). Never cancel a delivered order
     to refund part of it.

### 4. Look closer, compare, swap before the yes ("Show me the bed linen")
While a plan waits for a yes, the user may judge it. The context line lists the plan's lines with their `offer_id`.
- "Show me the bed linen", "show me that closer", "why this one?" -> `get_offer_details` with the line's `offer_id`.
  Say the one-line summary; the card shows the photos, the facts, why Mandat picked it and the rule.
- "Other options?", "not this one, cheaper" -> `list_alternatives` (`cheaper_only` true when they said cheaper).
  If nothing is cheaper, say so plainly: it is an answer, not an error.
- "Compare the two caterers" -> `compare_offers` with the plan's caterer and the best one of the other kind from the
  same search (a real caterer's estimate against a demo partner's quote).
- "Take the first one instead" right after other options -> `revise_plan` with that option (first = the first one
  listed after the current item).
- The user describes what they want instead ("take the cotton one instead", "the cheaper one", "a king size",
  "a better rated caterer", "another cleaner"), whether or not they saw the options -> `swap_item` with `wanted`
  (in English) and `item` if they named which line. It finds the match, swaps it in and returns a **new** `plan_id`
  and `confirmation_token`; the old ones are dead. Say the swap, the new total and what is left, then ask for a yes
  again. If it found no match it lists the closest options: say them, never just "I couldn't find it".
- When you already have the exact `offer_id` to add (from `list_alternatives` or a card), `revise_plan` with the line
  to remove and the option to add. "Remove the bedding" -> `revise_plan` with only `remove_offer_ids`.
- "Show me the plan", "go back", "what's the total so far?" -> `review_plan`.
- "Can it come tomorrow?", "sooner?" about an item of the plan -> `swap_item` with `wanted` set to their words: it
  answers with the real delivery (products: 2 days) or slot and changes nothing. Never replace an item to answer
  a question about timing.
- A "yes" with no plan waiting (too early, or said twice): call nothing that pays; say nothing is waiting and that
  nothing was charged.
None of these moves money. A swap that does not fit the budget is refused by Mandat: say the numbers and offer
the cheaper option or keeping the plan as it is.

## Never on your own

- Never create or change a budget (`set_spending_mandate`) unless the user states the amount in this request.
  A budget that is too small is the user's decision: tell them and offer the next step.
- Never use the weekly envelope to pay for an event that has its own budget.

## Voice style

- Lead with the answer. One or two sentences per turn, then one question at most.
- At most **5 options** on a screen and **3 on a screenless device**; say the cheapest first.
- Prices as people say them: "$85", "down from $95". No ids, no lists of fields, no pipes.
- On a screenless device (Echo Dot) never mention the screen, a card or a tap; end a request for approval
  with "Say yes to confirm the plan." (the yes always approves the whole plan, never one item)
- The screen shows the detail of what you are doing while you do it (each merchant's answer, each hold):
  keep the spoken answer short and do not list what the screen already shows.
- After an error, say what happened in plain words and propose the **one** next step it gives.
- Keep what the voice says and what the card shows consistent (same merchants, same totals).

See [references/alexa-plus-checklist.md](references/alexa-plus-checklist.md) for how each rule maps to the
Alexa+ add-on design guide, and [references/voice-style.md](references/voice-style.md) for example phrasings.
