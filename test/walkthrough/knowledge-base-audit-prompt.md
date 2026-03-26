# Knowledge Base Audit — Prompt for Next Session

## Context

The Lightning Observatory platform serves knowledge base files to AI agents via `GET /api/v1/knowledge/:topic`. These are condensed reference documents about the Lightning Network. Agents discover them from `llms.txt` and can read any of them during their lifecycle on the platform.

**The problem:** These files are too big. When an agent reads `/knowledge/strategy` (47KB), that response sits in the agent's conversation context forever, crowding out the instructions from llms.txt and causing failures on later tasks. The smallest model (gpt-4.1-nano) loses the ability to recall basic endpoints by phase 16 of a 21-phase lifecycle because it's carrying ~95KB of accumulated API responses.

**What we control:** The content of these files and what llms.txt tells agents about them. We cannot control agent context windows or retry logic.

## The Files

| Topic | Endpoint | Size | Source |
|-------|----------|------|--------|
| strategy | `/api/v1/knowledge/strategy` | 47.6KB, 993 lines | Mastering the Lightning Network book condensed |
| lnd-operations | `/api/v1/knowledge/lnd-operations` | 82.3KB, 2553 lines | LND operational reference |
| api-reference | `/api/v1/knowledge/api-reference` | 102.1KB, 2675 lines | Complete LND gRPC/REST API |
| protocol | `/api/v1/knowledge/protocol` | 73.8KB, 1587 lines | All 12 BOLTs condensed |
| config | `/api/v1/knowledge/config` | 22.2KB, 280 lines | LND config flags reference |
| rebalancing | `/api/v1/knowledge/rebalancing` | 30.2KB, 929 lines | Balance of Satoshis strategies |
| operator-wisdom | `/api/v1/knowledge/operator-wisdom` | 7.7KB, 133 lines | Production operator reasoning |
| onboarding | `/api/v1/knowledge/onboarding` | 7.9KB, 222 lines | How to get sats |

Total: ~374KB across 8 files. Files are served from `ln_research/02-collect-knowledge/output/`.

## Your Task

For each of the 8 files:

1. **Read the full content** via `curl -s http://localhost:3200/api/v1/knowledge/{topic}` (pipe through `python3 -c "import sys,json; print(json.load(sys.stdin)['content'])"` to get raw text)

2. **Judge its importance to an agent operating on our platform.** Our agents register, explore the network, analyze nodes, open/close channels, manage fees, compete on a leaderboard, message other agents, and post bounties. Which parts of this file actually help them do those things?

3. **Decide what to do with it:**
   - **Keep as-is** (only if under 10KB and focused)
   - **Condense** — rewrite to keep only the parts agents actually need. Target: under 10KB per file. Cut academic content, protocol internals, historical context. Keep: actionable rules, formulas, decision frameworks, operational heuristics.
   - **Split** — break into sub-topics served at `/api/v1/knowledge/{topic}/{subtopic}` so agents can load only what they need (e.g., `/knowledge/protocol/channel-lifecycle` instead of all 12 BOLTs)
   - **Merge** — if two files cover overlapping content, combine the useful parts
   - **Deprecate** — if the file doesn't help agents on our platform, remove it from llms.txt

4. **For each file you condense, write the condensed version.** Save to `ln_research/02-collect-knowledge/output/` with the same filename. The server reads from there.

5. **Update llms.txt** (at `site/llms.txt`) to guide agents on WHEN to read each knowledge file. Instead of just listing them, tell agents what situation calls for each one. Example: "Read `/knowledge/rebalancing` before adjusting channel fees" instead of just "Rebalancing strategies."

## Principles

- Every KB token an agent reads is a token it can't use for reasoning later. Smaller is better.
- `operator-wisdom` (7.7KB) and `onboarding` (7.9KB) are the right size. Everything else should aspire to that.
- Academic understanding of Lightning is nice. Actionable decision rules are essential. When in doubt, cut the academic and keep the actionable.
- The test runner at `scripts/skills/agent-walkthrough/test-runner.mjs` runs 21-phase lifecycle tests. After making changes, run: `source ~/.zshrc; node test-runner.mjs --provider openai --model gpt-4.1-nano --tag nano` to verify scores don't regress.

## Success Criteria

- No knowledge file over 15KB
- Total knowledge base under 80KB (down from 374KB)
- Agent test scores stay at 20+/21
- llms.txt tells agents when to read each file, not just that it exists
