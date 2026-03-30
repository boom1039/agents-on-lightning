# /test/walkthrough — Agent Docs And Route Eval Skill

Tests how well outside AI agents learn this API from the public agent docs, then uses the failures to improve the docs, the scoring, and the test harness.

This file is the **one human-facing hub** for the walkthrough system.
Open this first.

## Single Source Of Truth

For humans, this is now the **only file you should need**.

Simple rule:

- outside agents read `docs/llms.txt`
- humans read `test/walkthrough/SKILL.md`
- scripts and logs stay in the background

Do not treat the other loop files as normal reading.
They are support artifacts, not the main docs.

## One Entry Point

If you only open **one file**, open this one.

## Three-Layer Map

### Layer 1: Product docs

This is what outside agents read:

- `docs/llms.txt`
- `docs/skills/*.txt`

### Layer 2: Test system

This is what we read and run:

- `test/walkthrough/SKILL.md`
- `test/walkthrough/test-runner.mjs`
- `test/walkthrough/suites/*.mjs`
- `test/walkthrough/agent-coverage-scoring.mjs`

### Layer 3: History and logs

This is what records what happened:

- `autoresearch-state.json` = machine resume state
- `research-results.tsv` = score history
- `test/walkthrough/stress-test-results.jsonl` = serial run log
- `test/walkthrough/parallel-results/...` = parallel worker logs

Short version:

- outside agents read `llms.txt`
- humans read `SKILL.md`
- scripts read `autoresearch-state.json`
- logs record the results

Everything else is support code, support tests, or logs.

This skill is the **evergreen manual** for the walkthrough system.
They should stay separate:

- `SKILL.md` = how the system works now
- `autoresearch-state.json` = what the resume scripts remember

## What This Skill Is For

If you want the shortest mental model:

- outside agents read `docs/llms.txt`
- humans open `test/walkthrough/SKILL.md`
- machines resume from `autoresearch-state.json`
- old run history lives in `plans/...` and result logs

This repo now has two different ideas that must stay separate:

1. **Coverage**
   - deterministic robot checks
   - exact route-by-route HTTP validation
   - does the endpoint itself work?

2. **Agent coverage**
   - docs-only AI-agent checks
   - the agent starts from `llms.txt` and linked docs
   - can an outside agent learn the API and use it correctly?

The job here is mainly **agent coverage**.

## Core Rule

You are not trying to rescue the model.
If the agent gets lost, the platform failed to teach it.

Fix these first:

- `docs/llms.txt`
- `docs/skills/*.txt`
- response hints
- scoring bugs
- harness bugs that make the eval unfair

Do **not** “win” by spoon-feeding hidden route knowledge in the prompt.

## Current Surface

As of March 2026:

- `111` agent-facing API routes
- `28` agent-coverage groups
- `105/105` usable-now target
- the remaining hard routes are the signed/channel-management ones unless the harness has real signing and assigned-channel support

## Main Files

Core engine:

- `test/walkthrough/test-runner.mjs`
- `test/walkthrough/shared.mjs`
- `test/walkthrough/agent-coverage-scoring.mjs`
- `test/walkthrough/coverage-helpers.mjs`
- `test/walkthrough/verify-suite-coverage.mjs`
- `test/walkthrough/agent-local-tools.mjs`

Suite definitions:

- `test/walkthrough/suites/*.mjs`

Loop helpers:

- `test/walkthrough/agent-doc-feedback-loop.mjs`
- `test/walkthrough/parallel-agent-doc-feedback-loop.mjs`

Main docs agents read:

- `docs/llms.txt`
- `docs/skills/discovery.txt`
- `docs/skills/identity.txt`
- `docs/skills/wallet.txt`
- `docs/skills/analysis.txt`
- `docs/skills/social.txt`
- `docs/skills/channels.txt`
- `docs/skills/channels-signed.txt`
- `docs/skills/market.txt`
- `docs/skills/market-open-flow.txt`
- `docs/skills/market-close.txt`
- `docs/skills/market-swap.txt`
- `docs/skills/analytics.txt`
- `docs/skills/capital.txt`
- `docs/skills/signing-secp256k1.txt`

## Scoring Words

This skill uses four scores:

- **contract**
  - did the agent call the route correctly?
- **success**
  - correct route, correct request, intended success response
- **boundary**
  - correct route, correct request, intended teaching/error response
- **reach**
  - touched the route at all, even if the request was wrong

Headline score = **contract score**.

## 3-Try Rule

Every documented endpoint gets at most **3 exact tries**.

Exact try means:

- exact method
- exact documented path pattern

Failure buckets:

- `cannot_find_endpoint`
- `found_endpoint_wrong_request`
- `found_endpoint_wrong_response`

This matters because “the agent found the URL” is **not** enough.

## Main Modes

### 1. `walkthrough`

Old benchmark-style agent journey.
Useful, but not the main exhaustive eval anymore.

### 2. `coverage`

Deterministic route checks.
Good for exact API correctness.
This is a **backend contract suite**, not outside-agent proof.
It must not open, assign, rebalance, fee-change, or close live channels.

### 3. `agent-coverage`

The main docs-only eval.
The agent gets a base URL, a task, normal HTTP access, and whatever docs the site itself serves.
No harness-side signing help or hidden state help.

### 4. Parallel feedback loop

Best way to iterate fast.

Workers:

- `W1 = discovery,analysis`
- `W2 = identity,wallet`
- `W3 = social,channels`
- `W4 = market,analytics,capital`

Loop:

1. run agents
2. inspect misses
3. reread `docs/llms.txt` and the relevant public skill/helper docs in full before patching
4. tighten docs
5. rerun

Better iteration rule:

1. classify the miss first
2. apply only the matching fix
3. rerun only that narrow lane
4. require 2 clean passes before calling it done

Hard-stop rule:

1. run the broad eval in fail-fast mode
2. stop at the first failed lane
3. switch to targeted reruns for that one lane only
4. if the same lane gets 3 narrow fix cycles with no contract-score improvement, hard-stop and mark it as a real blocker
5. hard-stop immediately if the next blocker needs real money, a real assigned channel, or a backend/product fix instead of a docs/test fix

Targeted test rule:

1. use the smallest rerun that can prove the fix
2. do not rerun unrelated lanes while a narrow blocker is still open
3. only go back to the broad eval after the narrow lane passes twice

Post-failure reread rule:

1. after any failed agent run, reread `docs/llms.txt` in full
2. reread in full the public skill/helper docs that fan out from it and are relevant to the failed area
3. keep the failure details in mind while rereading so you can decide whether the miss is findability, exactness, signing/runtime, state, or product behavior
4. do this before you decide where to patch

Scope of that reread:

- include the public agent doc tree:
  - `docs/llms.txt`
  - `docs/skills/*.txt`
  - docs-only helper files linked from `llms.txt`
- do not automatically reread the large condensed knowledge docs on every miss:
  - `docs/knowledge/alex_bosworth_writings_MEMORY_CONDENSED.md`
  - `docs/knowledge/balanceofsatoshis_MEMORY_CONDENSED.md`
  - `docs/knowledge/bolts_MEMORY_CONDENSED.md`
  - `docs/knowledge/lnbook_MEMORY_CONDENSED.md`
- only pull those larger knowledge files back in when the failure actually depends on deeper Lightning theory instead of the public product docs

Miss classes:

- `findability`
- `exact_request_shape`
- `runtime_or_signing`
- `state_prerequisite`
- `real_product_bug`

For hard combined phases, keep the final benchmark group unchanged, but split them into smaller debug lanes while iterating.
Example:

- `swap-ecash-and-rebalance` can be debugged as:
  - `swap`
  - `fund-from-ecash`
  - `rebalance`

## What We Added In This Work

This skill must now remember that the system grew a lot:

- contract-first scoring
- 3 exact tries per route
- parallel workers
- doc-visibility tracing
- route-by-route manifests
- safe dedupe cleanup
- helper docs for long route groups
- stricter separation between backend contract tests and outside-agent proof
- direct live mutation paths removed from the harness

## Philosophy

The main eval should model a real outside agent as closely as possible.

That means `agent-coverage` should give the model only:

- a base URL
- a human task
- normal HTTP access
- whatever docs and responses the website itself serves

Optional production-like variant:

- a generic terminal

That terminal must stay generic.
It is allowed only because a real outside agent may have its own shell.
It must never become a hidden crypto helper, funding helper, or channel helper.

That means `agent-coverage` should **not** give the model:

- local signing helpers
- hidden funding help
- hidden channel assignment help
- hidden operator actions
- subsection coaching
- route-by-route success hints

The loop should also stay classifier-driven:

- do not make random doc edits
- identify what class of miss happened
- change only the part that matches that miss
- prefer narrow reruns over broad reruns
- do not call a phase stable on one lucky pass; require 2 clean passes

## Signed Route Testing

Signed routes are still the hardest part.

Current rule:

- the pure outside-agent eval does **not** get signing help from the harness
- if a signed flow needs a real assigned channel or real local signing runtime, that must come from the real agent environment, not the harness
- if we want to simulate that environment, use a generic terminal lane, not custom signing tools
- deterministic `coverage` can still check backend contracts and honest boundary responses, but it must not mutate live channel state

### Server rule

Use at most two local app servers:

- `3302` = main
- `3306` = scratch

Do not start ad hoc copies on `3201`, `3304`, or random ports.

Production should use only one app server.

Normal testing server:

- use `http://localhost:3302`
- use `http://localhost:3306` only for scratch work that is clearly separated from the main outside-agent eval

Do **not** use port `3200`.

## Monitoring And Logs

Important artifacts:

- `test/walkthrough/stress-test-results.jsonl`
- `test/walkthrough/parallel-results/...`
- dashboard and monitoring routes in `src/monitor/`

What to log and inspect:

- which docs the agent fetched
- what payload the agent actually saw
- which request it chose next
- contract vs reach score
- failed routes grouped by failure type

## Best Current Read

As of this skill update:

- latest fresh clean full parallel run: `109/111` contract
- latest fresh clean usable-now score: `105/105`
- latest fresh clean reach score: `111/111`
- strongest clean lanes:
  - `discovery + analysis = 18/18`
  - `identity + wallet = 27/27`
- remaining misses are concentrated in:
  - `social:alliances`
  - `channels:audit-and-monitoring`
  - `channels:signed-channel-lifecycle`
  - `market:open-flow`
  - `market:close-revenue-performance`
  - `market:swap-ecash-and-rebalance`
- those remaining misses are now a mix of:
  - real doc clarity gaps
  - honest funding or channel-assignment blockers

## Known Hazard

One earlier live signed-channel experiment changed the inactive channel
`6a8793cbdf9d85d5ec11d9d5a0b70ba3b64e48f7a4c39663c8a3a85fa9135688:0`
to:

- `base_fee_msat=1000`
- `fee_rate_ppm=100`

Do not ignore that.
Future signed-channel proof runs should happen only in the real outside-agent lane, not through harness-side mutation shortcuts.

## Commands

Useful commands:

```bash
npm run test:walkthrough:verify
npm run test:walkthrough:scoring
npm run test:walkthrough:agent-coverage:quick -- --suite social --phase messaging --base-url http://localhost:3302
npm run test:walkthrough:agent-coverage:terminal -- --suite channels --phase signed-channel-lifecycle --base-url http://localhost:3302
npm run test:walkthrough:agent-feedback:parallel -- --top 8 --base-url http://localhost:3302
```

Outside-agent real-flow pattern:

```bash
AOL_SERVER_ROLE=scratch PORT=3306 node src/index.js

npm run test:walkthrough:agent-coverage:quick -- \
  --provider openai \
  --model gpt-4.1-mini \
  --mode agent-coverage \
  --suite channels \
  --phase signed-channel-lifecycle \
  --base-url http://localhost:3306
```

## Update Rules

Whenever this system changes, update this file for:

- new route counts
- new score definitions
- new helper docs
- new worker splits
- new safety rules
- new test commands
- new known hazards

This file is the only human summary that must stay current.

Do **not** turn this file into a dated diary.
