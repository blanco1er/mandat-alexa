# Alexa+ add-on design guide: how Mandat honours it

Sources: Alexa+ MCP add-on design guide (overview, functional requirements), read 17 Oct 2026.

| Guide section | Requirement (summary) | Mandat |
|---|---|---|
| Principles | End-to-end task completion | Search, negotiate, plan, pay (hold), change, capture, refund: all through the add-on |
| Principles | Glanceable cards: one title, one or two supporting fields, one clear action | 5 cards (status, mandate, offers, plan, receipt), one primary button each |
| Principles | Readable at a distance (base canvas 768x480, Echo Show 1280x800, text x1.6) | Card type scale from 17 to 56 px, clamp() on the container width |
| §8 Transaction flow | Explicit confirmation | `propose_plan` -> spoken total -> yes -> `confirm_plan` with `user_confirmation`; server refuses without it |
| §8 | Price breakdown (base, taxes, fees, total) | `breakdown` on every plan, read aloud and shown on the plan card |
| §8 | Prevent duplicates | `confirm_plan` idempotent on `plan_id` (conditional write on `IDEMP#<plan_id>`) |
| §8 | Modify one parameter | `change_order` changes exactly one field: date, time or quantity |
| §8 | Cancellation with policy and fees | `close_order` `cancel` voids the hold (no fee before the service); merchant terms state their own policy |
| §8 | Written receipt | Receipt card with the payment timeline held -> captured -> released -> refunded |
| §9 Voice only | At most 5 options; read back and explicit "yes"; never refer to the screen | Dot mode: 3 options max, "Say yes to confirm the plan.", no screen words (tested) |
| §10 | Voice and screen consistent | Speech and card are built from the same tool result |
| Policy | Shopping add-ons must protect customers from unintended purchases | Budget envelope, auto-approve threshold, explicit yes, idempotency, merchant floor guard |
| Policy | Not targeted at children | Household errands for adults |
