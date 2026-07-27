# BrainOutput Community Edition — Feedback (alpha)

You are one of a few technical alpha users — your feedback directly shapes the product. Thank you.

## How to send it
Email the template below to **contact@brainoutput.com** (subject: `Community alpha feedback`).
*(Please don't include secrets — API keys, tokens, or customer data. A `bo-community store export`
attachment is safe; it excludes all credentials.)*

Please **never include secrets** (API keys, tokens, customer data). Exports from
`bo-community store export` already exclude credentials — prefer attaching that over raw files.

## Include this diagnostic (no secrets)
```bash
node bo-community.mjs doctor        # Node + detected model sources
node --version && uname -a          # environment
node bo-community.mjs store show    # your company shape (no keys)
```

## Feedback template
```
Summary:            (one line)
Type:               bug | confusing | slow | missing feature | worked well
What you did:       (steps — which page / command / objective)
Expected:
Actual:
Model source used:  local (ollama/…) | free (…) | BYOK (provider)
Approx. task latency:
Environment:        OS, Node version (from doctor)
BrainOutput-funded inference stayed $0?   yes / no  (if no — that's a priority bug, tell us!)
Anything that asked for a BrainOutput account / Claude / Kimi / BrainOutput credentials?  yes / no
```

## Most useful signals right now
- Anything that was **confusing** in onboarding or the dashboard.
- Any moment inference did **not** clearly show its **cost source** / **$0**.
- Model/latency experience (which models, how fast, what you'd want).
- Whether the three sample workflows (technical / customer-service / finance-with-approval) ran.
- Any human-approval gate that was missing where money/publishing/deploys were involved.
