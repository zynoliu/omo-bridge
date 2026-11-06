# Intent-vs-reality diff

| intent_id | expected truth | observed reality | diff | violated invariant | status |
|---|---|---|---|---|---|
| I1 | Tests prove what the user sees on the first-minute path | Suite proves HTTP/contract shapes; render assertions only in 2 red scenarios | Missing layer | "verified" must include the user path | violated |
| I2 | Backend-owned surfaces either work or say "not wired" | 9 families answer 200 [] | Silent degradation shipped as contract | no silent empty | violated |
| I3 | Every change is gated automatically | No CI, no hooks, no thresholds | Manual-only gating | gates must run without a human | violated |
| I4 | The real client contract is exercised by default | e2e skipped unless env set | Default gate omits the only client test | default run must include it | violated |
| I5 | Acceptance scenarios assert the user's anchor, not just presence | 2 scenarios, both red; submitted/order not gating (order added today) | Assertion too weak | pass = user-visible criterion | violated |
| I6 | /models shows the host's models when a provider is connected | Free models / no items | Dialog branch reads wrong key | menu must call the real backend | violated |
| I7 | QA leaves no residue | one state dir per run | Leak | zero residue | violated |
| I8 | Evidence runs use the pinned runtime | 1.3.14 vs pinned 1.4.4 | Drift | measure with the pin | violated |
