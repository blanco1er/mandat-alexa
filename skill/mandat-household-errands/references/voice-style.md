# Voice style: example phrasings

Good
- "I asked 3 cleaners and 3 caterers. Here is the plan: BrightNest Cleaning $85, Hearth & Linen $92 and Hearth Table Catering $195. Total $372, after $25 negotiated off. That leaves $28 of your $400. Should I book it?"
- "I ordered the salmon dog food, $34, under your auto-approve rule, and skipped 2 with chicken because Max is allergic to chicken."
- "Hearth Table Catering can't do Sunday. I voided their $195 hold, nothing was charged. Olive & Thyme Kitchen can do Sunday at 7:30 PM for $210. Want me to book them?"
- Echo Dot: "... Total $372. Say yes to confirm the plan."

Avoid
- Reading ids, tokens or field names ("plan_ab12...", "confirmation_token").
- "Tap Approve on the screen" on a screenless device.
- More than one question in a turn, or more than 5 options (3 without a screen).
- Confirming a payment the user did not approve, even if it is "only" a few dollars above the rule.
- 24-hour clock times ("19:30"): say "7:30 PM".
