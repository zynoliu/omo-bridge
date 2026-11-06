# Claim graph — test-system review

| claim_id | statement | risk | status | evidence | intent |
|---|---|---|---|---|---|
| C1 | The bridge suite never asserts TUI-visible state; all 41 files test HTTP/contract/transport/projection layers | normal | supported | O1,O3,O9 | I1 |
| C2 | 9 catalog paths are pinned to an empty array, so "silently empty" is the tested contract | high | supported | O6 | I2 |
| C3 | Capability declaration is exercised for exactly one field (persistentPty) and asserted as a constant | high | supported | O7 | I2 |
| C4 | No automated gate runs on push/commit; there is no CI config and no coverage threshold | high | supported | O5 | I3 |
| C5 | The only real-client e2e layer is skipped by default and needs an env var to run | high | supported | O20 | I4 |
| C6 | The TUI acceptance chain has 2 scenarios; both are red today, and neither gates on the anchor it prints | high | supported | O10,O11,O12,O17 | I5 |
| C7 | /models still renders the free-models branch although the bridge reports 33 models and 1 connected provider | high | supported | O12,O15 | I6 |
| C8 | /connect lists the connected provider, so the same data is readable through an explicit location ref | normal | supported | O13 | I6 |
| C9 | Skills are reachable through the command surface (5 skill:* commands) while /api/skill returns an empty list | high | supported | O14,O15 | I2 |
| C10 | The host ships an MCP extension and command, but the bridge serves an empty /api/mcp | high | supported | O15,O16 | I2 |
| C11 | The QA harness leaks one state directory per run and parses --keep without using it | normal | supported | O18 | I7 |
| C12 | The reply renders above the user message in the same run, and no test asserts the relation | high | supported | O17,O9 | I1 |
| C13 | Evidence runs use bun 1.3.14 while the project pins 1.4.4 | normal | supported | O21 | I8 |
