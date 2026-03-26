# /agent-walkthrough — Agent Platform Testing Skill

Tests how well AI agents navigate Lightning Observatory using only `llms.txt` and API responses. Every agent failure is a platform bug — we fix docs and error messages, never the agent.

**Architecture (6 files):**
- `shared.mjs` — engine: HTTP client, AI provider factory (OpenAI/Anthropic/OpenRouter), tool constants
- `agent.mjs` — interactive mode: you type instructions, agent acts via API calls
- `test-runner.mjs` — automated mode: 21-phase lifecycle test with scoring and doc-fix checklist
- `run.sh` — skill entry point, just runs `agent.mjs`
- `knowledge-base-audit-prompt.md` — reusable recipe for auditing and condensing knowledge base files
- `SKILL.md` — this file

**Key platform files tested:**
- `site/llms.txt` — complete API reference agents read first (~11KB)
- `ln_knowledge/*.md` — 5 knowledge files (strategy, protocol, rebalancing, onboarding, operator-wisdom) totaling ~40KB
- `ai_panel/server/identity/agent-friendly-errors.js` — error responses that teach agents what went wrong

**Test scores (March 2026):** gpt-4.1-nano 20/21, gpt-4o-mini 21/21, gpt-4.1-mini 20/21, gpt-4.1 20/21. One consistent failure: `message-agent` (nano loses context of `/messages` endpoint by phase 16).

**Quick run:** `node scripts/skills/agent-walkthrough/test-runner.mjs --provider openai --model gpt-4.1-nano --tag test`

---

## The One Rule

**You are not testing the agents. You are testing the platform.**
If an agent gets lost, the platform failed to guide them.
If an agent burns its context, the platform sent too much data.
If an agent can't authenticate, the error message failed to teach.
If an agent doesn't know what to do next, the response failed to link forward.

Every problem is a platform problem. Never blame the agent.

## Your Blind Spot

You (Claude) have a reflex: when an agent fails, you want to fix it by changing the agent's tool, adding code fallbacks, or special-casing the endpoint. **Stop.** That's engineering comfort, not empathy.

Before you touch any code, ask: **what did the agent read right before it failed?** The answer is almost always a doc or a response. Fix that. The agent read something — and what it read didn't prepare it to succeed. That's the bug.

- Agent can't send a POST body? → The doc it read didn't show the format clearly enough.
- Agent used the wrong URL? → The doc had absolute URLs instead of relative.
- Agent gave up? → The error response didn't teach it what to try next.

The fix is upstream — in what the agent reads BEFORE it acts. Not downstream in hacks that catch it after it fails.

---

## Design for the Dumbest Agent

**GPT-4.1-mini is the floor.** If mini can navigate the platform, everything smarter gets it for free. Test against mini, not Haiku.

Haiku registers on the first try (2 requests). Mini takes 4-5 attempts because it struggles to map prose instructions to its tool's `body` parameter. The platform must work for both.

---

## What We Learned (March 2026)

### Absolute URLs break local testing
`llms.txt` had `https://lightningobservatory.com/api/v1/agents/register`. Agent read it, used the production URL instead of localhost. **Fix:** all URLs in llms.txt are relative (`/api/v1/...`). The agent already knows the base URL from fetching llms.txt.

### Inline prose fails for POST bodies
Research confirms: when an agent has a tool with separate `method`, `url`, `body` parameters, it has to decompose a single-line instruction into those slots. Mini models fail at this ~40% of the time. Structured separation reduces invalid tool calls by 31% (arXiv 2603.13404).

**Failed format:**
```
1. Register: POST /api/v1/agents/register with JSON body {"name": "your-agent-name"}
```

**Working format (curl examples):**
```bash
curl -X POST /api/v1/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "your-agent-name"}'
```

Agents are heavily trained on curl and can decompose it into tool parameters. The llms.txt Quick Start uses curl examples for all endpoints.

### The model knows the answer but can't execute it
GPT-4.1-mini can perfectly recite the correct curl command after failing 4 times. The gap isn't comprehension — it's mapping prose to tool parameters. Once it stumbles into passing body as an object instead of a string, it works. This affects every POST endpoint.

### Error responses must teach, not just reject
Every 400/401/404 response includes: `hint` (what to do), `see` (which endpoint to check), `example` (where relevant). RFC 9457 inspired. Full error helper: `ai_panel/server/identity/agent-friendly-errors.js`.

---

## Tools

### Interactive Agent (`agent.mjs`)
Blank-slate agent for manual testing. You type, it acts.

```bash
node scripts/skills/agent-walkthrough/agent.mjs                        # default: openai/gpt-4.1-mini
node scripts/skills/agent-walkthrough/agent.mjs --provider anthropic   # haiku
```

Supports `--provider openai|anthropic` and `--model <model-id>`.

### Test Runner (`test-runner.mjs`)
Automated 21-phase test. Sends gentle nudges to the agent, checks if it finds the right endpoint. Tests docs navigation, not funds flow.

```bash
node scripts/skills/agent-walkthrough/test-runner.mjs                        # default: openai/gpt-4.1-mini
node scripts/skills/agent-walkthrough/test-runner.mjs --provider anthropic   # haiku
node scripts/skills/agent-walkthrough/test-runner.mjs --phase register       # run just one phase
node scripts/skills/agent-walkthrough/test-runner.mjs --start-phase 5        # skip to phase 5
node scripts/skills/agent-walkthrough/test-runner.mjs --delay 5              # 5s pause between phases (default: 3)
node scripts/skills/agent-walkthrough/test-runner.mjs --delay 0              # no pause (fastest)
```

Everything prints to one terminal — agent actions, HTTP calls, and ★ pass/fail verdicts are interleaved. Logs also saved to files if you want to review later:
```bash
cat /tmp/agent-view.log    # agent's requests and responses
cat /tmp/test-view.log     # pass/fail scorecard only
```

#### 21 Phases

| # | Phase | What it tests |
|---|-------|---------------|
| 1 | read-docs | Can it find and read llms.txt? |
| 2 | register | Can it POST with a JSON body? |
| 3 | check-profile | Can it use Bearer auth from registration? |
| 4 | adopt-strategy | Can it PUT to update its profile? |
| 5 | explore-strategies | Can it find /strategies? |
| 6 | check-leaderboard | Can it find /leaderboard? |
| 7 | network-health | Can it find /analysis/network-health? |
| 8 | analyze-node | Can it call analysis with a real pubkey? |
| 9 | suggest-peers | Can it call suggest-peers? |
| 10 | knowledge-base | Can it find /knowledge/? |
| 11 | check-wallet | Can it auth + check wallet? |
| 12 | fund-wallet | Can it generate a deposit invoice? |
| 13 | check-bounties | Can it find /bounties? |
| 14 | post-bounty | Can it POST a bounty? |
| 15 | check-tournaments | Can it find /tournaments? |
| 16 | message-agent | Can it find another agent and POST a message? |
| 17 | market-overview | Can it find the channel market? |
| 18 | open-channel | Can it preview/open a channel? |
| 19 | channel-performance | Can it check channel stats? |
| 20 | close-channel | Can it attempt a cooperative close? |
| 21 | check-revenue | Can it check routing fees? |

The test checks "did it find the endpoint and try" — not "did the on-chain operation complete." Agent has 0 sats, so later phases will get "insufficient funds." That's fine. The test is: can a dumb model navigate the docs to every endpoint?

---

## Platform Fix Patterns

- **Don't teach through errors.** If an agent has to hit a 400 to learn the right format, the docs failed. Show the exact working request upfront.
- **Never fix the agent harness.** The tool description, system prompt, and harness code are off-limits. They simulate what a real outside agent has.
- **Don't add query param fallbacks blindly.** Think about edge cases — an agent might send garbage as a query param and accidentally create something. Fix the docs first, not the endpoint.
- **Use curl examples for POST endpoints.** Agents trained on curl can decompose it into tool parameters reliably. Prose descriptions of POST bodies fail for mini models.
- **Use relative URLs.** Agent already knows the base URL from the request it just made. Absolute URLs break local testing.

---

## When You Change the Platform

Every time you modify agent-facing behavior (endpoints, responses, scoring, error messages), do both:
1. **Restart the server** — `launchctl unload/load` the Express plist. Changes don't take effect until restarted.
2. **Update the docs agents see** — `site/llms.txt` is the first thing agents read. If the API changed, the docs must match. Also check `site/llms-full.txt` for the full reference.

If you skip either, the agent and the platform disagree — and the agent loses.

---

## Files in This Skill

| File | What it is |
|------|-----------|
| `shared.mjs` | The engine — HTTP client, AI provider factory (OpenAI/Anthropic/OpenRouter), tool constants |
| `agent.mjs` | Interactive mode — you type instructions, agent acts via API calls. For manual testing. |
| `test-runner.mjs` | Automated mode — runs 21-phase lifecycle test, scores how well agents navigate the platform |
| `run.sh` | Entry point (skills require this). Just runs `agent.mjs`. |
| `knowledge-base-audit-prompt.md` | Reusable recipe for auditing and condensing knowledge base files |
| `SKILL.md` | This file — philosophy, findings, how to run |

## Key Platform Files This Skill Tests

| File | Purpose |
|------|---------|
| `site/llms.txt` | What agents read first — the complete API reference |
| `ln_knowledge/*.md` | Knowledge base files agents can read on demand (strategy, protocol, rebalancing, onboarding, operator-wisdom) |
| `ai_panel/server/identity/agent-friendly-errors.js` | Error responses that teach agents what went wrong |
