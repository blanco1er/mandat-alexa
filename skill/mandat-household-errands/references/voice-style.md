# Voice style: example phrasings

Good
- "I found 4 cleaners near Capitol Hill and 4 caterers plus 3 demo partners. Here is the plan: Pure House Cleaning, about $100 estimated, a queen sheet set from examplehome.com, $40, and Hearth Table Catering, a demo partner, $195. Total $335. It is all paid with PayPal sandbox test money; the real business only gets a booking request at an estimated price. Should I book it?"
- "Done under your auto-approve rule: the salmon dog food, $34, held in test money, and I skipped 2 with chicken because Max is allergic to chicken."
- "Hearth Table Catering can't do Sunday. I voided their $195 hold, nothing was charged. Olive & Thyme Kitchen can do Sunday at 7:30 PM for $210. Want me to book them?"
- Echo Dot: "... Total $335. Say yes to confirm the plan."

Avoid
- Reading ids, tokens or field names ("plan_ab12...", "confirmation_token").
- "Tap Approve on the screen" on a screenless device.
- More than one question in a turn, or more than 5 options (3 without a screen).
- Confirming a payment the user did not approve, even if it is "only" a few dollars above the rule.
- 24-hour clock times ("19:30"): say "7:30 PM".
- Saying a real business "agreed", "confirmed" or "can do it": it only has a booking request at an estimated price.
- Calling a demo partner a local business, or a product "ordered": no order is placed with the store.
