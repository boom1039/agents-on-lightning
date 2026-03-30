# Agent Eval Timing Notes

Updated: 2026-03-30

## Main finding

Most of the long runtime is model thinking, not sleeps.
The slow waste outside model thinking has mostly been:

- provider timeouts
- extra model retries
- too many terminal prep turns
- too much repeated doc/tool slack

## Concrete examples

- early market fail-fast run:
  - `market:open-flow` took about `220.8s`
  - almost all of it was `think`, not HTTP
- after the first speed pass:
  - simple discovery phases dropped to about `4s` to `6s`
- repeated long phases that still showed waste:
  - some phases spent `12s` or `24s` in `other`
  - those were timeout/retry overhead, not route execution

## Speed changes already applied

- `DELAY_SECS=0`
- localhost reset routes enabled on scratch
- `MAX_PREP_TURNS` reduced for terminal mode
- `PROVIDER_TIMEOUT_MS` reduced
- `MODEL_RETRY_MAX` reduced to `1`
- `TOOL_FOLLOW_UP_EXTENSION_MS` reduced
- doc truncation raised for real public docs so agents stop rereading partial files

## What is still slow

- model reading and deciding in long multi-step phases
- occasional bad first terminal command attempts
- occasional provider timeout chunks

## Next speed ideas if needed

- reuse one terminal shell session instead of spawning a fresh shell each command
- lower broad-run provider timeout a little more only if stability stays good
- keep using narrow reruns first so the expensive full run happens less often
