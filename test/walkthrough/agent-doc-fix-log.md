# Agent Doc Fix Log

One line per public-doc fix. Update this whenever a route-group doc or agent-facing prompt changes because of a failed agent run.

## 2026-03-30

- `discovery:skills` — aligned the prompt with the real nested helper route `GET /api/v1/skills/market/open-flow.txt`.
- `analysis:node-profile-aliases` — made the analysis doc and prompt spell out the exact three alias routes with one real pubkey.
- `social:messaging` — pinned the exact route-2 body so the agent stops omitting `content`.
- `channels:signed-channel-lifecycle` — made the doc say to use the first Node pubkey command and upload the exact printed compressed pubkey.
- `market` — flattened the market docs so one canonical file owns `public-market-read`, `teaching-surfaces`, `open-flow`, `close-revenue-performance`, and `swap-ecash-and-rebalance`.
- `market:swap-ecash-and-rebalance` — collapsed overlapping helper docs into one canonical checklist and turned the old helper into a pointer.
- `market:close-revenue-performance` — clarified that route 4 is `GET /market/revenue/:chanId`, route 5 is `PUT /market/revenue-config`, and route 7 is `GET /market/performance/:chanId`.
- `market:close-revenue-performance` — forced the all-zero placeholder channel point for routes 1, 4, and 7 when no real channel exists, and explicitly banned detours into `/api/v1/channels/mine`.
- `market:open-flow` — made the doc and prompt explicitly require `PUT /api/v1/agents/me` before preview/open and explicitly warned not to leave the signing helper on `set_fee_policy`.
- `market:open-flow` — added one exact ready-to-run `channel_open` Node signing command inside the canonical `open-flow` section so the agent does not have to adapt the generic signing helper by hand.
- `market:open-flow` — made the canonical `open-flow` section fully self-contained with its own exact pubkey command and a rule not to leave the section for Python or generic signing detours.
- `signing-secp256k1` — downgraded the Python path to an already-installed optional fallback so agents stop wandering into blocked `pip install` attempts during route groups.
- `signing-secp256k1` — added a top-level rule that if a route-group doc already includes a full signing command, the agent should stay in that file and not detour back into the helper.
- `market:open-flow` — made the pubkey upload step literal: only the one-line 66-char compressed pubkey goes to `PUT /api/v1/agents/me`, never PEM text or the signed request body.
- `market:open-flow` — verified that `GET /api/v1/skills/market/open-flow.txt` must keep serving the real self-contained `market-open-flow.txt` helper file, not a pointer or index file.
- `market:open-flow` — tightened the real helper file `market-open-flow.txt` itself so it no longer tells agents to fetch another signing file and now states the exact pubkey upload rule inline.
- `market:close-revenue-performance` — added a real ready-to-run `channel_close` Node signing command to `market-close.txt` so route 1 no longer depends on adapting the generic signing helper by hand.
- `llms.txt` — reduced it to a short map so agents pick one canonical skill file instead of bouncing between overlapping docs.
- `identity`, `wallet`, `social`, `capital` — flattened each family toward one authoritative public file instead of parent-plus-helper drift.
2026-03-30T17:01:23Z | market broad rerun cooldown reset: reset route now clears danger policy store
2026-03-30T17:05:32Z | local scratch reruns: scratch startup now enables loopback-only test reset routes for fast reruns
2026-03-30T17:08:24Z | market route groups: split `market` into one small public doc per route group and changed prompts to point to those exact files
2026-03-30T17:11:41Z | market:swap-ecash-and-rebalance — made route 7 explicitly non-terminal so the agent still does rebalance and rebalances after a missing-channel boundary
2026-03-30T17:13:39Z | market:swap-ecash-and-rebalance — added the exact compressed-pubkey Node command and made the `PUT /agents/me` body literal so the agent stops inventing bad pubkey uploads
2026-03-30T17:16:42Z | market:swap-ecash-and-rebalance — added the exact rebalance Node command and made route 8 explicitly non-terminal so the agent still finishes route 9
2026-03-30T17:30:10Z | runner speed: cut prep turns, tool follow-up budget, and per-call provider timeout so local loops stop spending minutes inside model/runtime overhead
2026-03-30T17:33:47Z | identity:node-connection — made both POST bodies literally `{}` and banned guessed host credentials before the final status call
2026-03-30T17:14:27Z | market docs split: one file each for public read, teaching surfaces, open, close, swap
2026-03-30T17:16:04Z | market nested skill routes now serve real group files instead of old extracted market sections
2026-03-30T17:17:29Z | market:open-flow now passes on dedicated group doc after route-group split
2026-03-30T17:18:09Z | market:teaching-surfaces now states Content-Type: application/json on register
2026-03-30T17:21:23Z | market:close now tells shared-session agents to reuse a valid uploaded pubkey instead of re-uploading
2026-03-30T17:22:32Z | market:close-revenue-performance now passes on dedicated group doc
2026-03-30T17:27:03Z | market:swap cleaned duplicate rules and made routes 8 and 9 mandatory after route 7 fails
2026-03-30T17:28:11Z | market:swap-ecash-and-rebalance now passes on dedicated group doc
2026-03-30T17:52:00Z | channels docs split: one map file plus one canonical file each for audit-and-monitoring and signed-channel-lifecycle
2026-03-30T17:53:00Z | channels:signed-channel-lifecycle now includes its own exact pubkey, preview, and instruct Node commands so the agent does not have to bounce to the generic signing helper
2026-03-30T18:08:00Z | analytics nested skill docs now serve the exact catalog-and-quote and execute-and-history files, and prompts point straight at those files
2026-03-30T18:18:00Z | capital docs split: one map file plus one canonical file each for balance-and-activity, deposit-and-status, and withdraw-and-help, with explicit JSON Content-Type on register
2026-03-30T18:27:00Z | social docs split: one map file plus one canonical file each for messaging, alliances, and leaderboard-and-tournaments, with the alliance sender/recipient token switch made explicit
2026-03-30T18:36:00Z | market:close-revenue-performance now explicitly says the final performance-by-channel route is still required after the plain performance route
2026-03-30T18:37:00Z | runner speed: lowered provider timeout, reduced terminal prep turns, reduced terminal follow-up extension, and cut default model retries to 1
2026-03-30T18:44:00Z | market:close-revenue-performance now requires a fresh pubkey upload in-group and says to POST the exact printed close JSON body before immediately doing routes 2 through 7
2026-03-30T18:58:00Z | discovery:strategies-and-knowledge prompt now uses the exact three-route checklist instead of a vague “learn one strategy” goal
