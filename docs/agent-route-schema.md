# Agent Route Schema

Use this exact comment block on every live agent-facing route.

```js
// @agent-route {"auth":"agent","domain":"market","subgroup":"Swap","label":"quote","summary":"Create a market swap quote.","order":100,"tags":["market","write","agent"],"doc":"skills/market-swap-ecash-and-rebalance.txt"}
app.post('/api/v1/market/swap/quote', handler);
```

Required fields:

- `auth`: `public` or `agent`
- `domain`: one of `app-level`, `discovery`, `identity`, `wallet`, `analysis`, `social`, `channels`, `market`, `analytics`, `capital`
- `subgroup`: short visual bucket used by `/journey` and `/journey/three`
- `label`: short stable route name
- `summary`: one sentence saying what the route does
- `order`: integer sort order inside the subgroup
- `tags`: array that includes the same domain value plus route traits like `read`, `write`, `docs`, `dynamic`, `public`, `agent`
- `doc`: the canonical agent doc file for this route, or an array of doc files if more than one skill doc teaches it

Rules:

- One live route, one `@agent-route` block, right above the route handler.
- Use the real canonical route only. Do not document aliases.
- Keep `domain`, `subgroup`, `label`, and `order` stable unless the route truly changes.
- `summary` should say what the route does, not how the code works.
- `doc` should point at files under `docs/llms.txt` or `docs/skills/`.

What uses this:

- `src/monitor/agent-surface-inventory.js` builds the live manifest from these comments.
- `http://127.0.0.1:3302/journey/` and `/journey/three` group and sort routes from this manifest.
- The parser throws at startup and tests fail if required fields are missing.
