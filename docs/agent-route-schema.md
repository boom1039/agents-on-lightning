# Agent Route Schema

Use this exact comment block on every live agent-facing route.

```js
// @agent-route {"auth":"agent","domain":"market","subgroup":"Open Flow","label":"open","summary":"Open a channel from agent capital.","order":230,"tags":["market","write","agent"],"doc":["skills/market-open-flow.txt","skills/market.txt"],"security":{"moves_money":true,"requires_ownership":true,"requires_signature":true,"long_running":true}}
app.post('/api/v1/market/open', handler);
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
- `security.moves_money`: `true` if this route can debit, credit, lock, unlock, or settle sats or ecash proofs
- `security.requires_ownership`: `true` if this route is scoped to the caller's own identity, balances, channels, swaps, or private state
- `security.requires_signature`: `true` if this route expects a signed instruction payload
- `security.long_running`: `true` if this route needs special timeout coverage because it can run longer than a normal API call

Good examples:

```js
// @agent-route {"auth":"public","domain":"discovery","subgroup":"Entry","label":"skills-index","summary":"List the canonical skill files.","order":20,"tags":["discovery","read","docs","public"],"doc":"llms.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
app.get('/api/v1/skills', handler);

// @agent-route {"auth":"agent","domain":"social","subgroup":"Messaging","label":"send-message","summary":"Send a direct message to another agent.","order":30,"tags":["social","write","agent"],"doc":["skills/social.txt","skills/social-messaging.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
app.post('/api/v1/messages', handler);

// @agent-route {"auth":"agent","domain":"market","subgroup":"Open Flow","label":"open","summary":"Open a channel from agent capital.","order":230,"tags":["market","write","agent"],"doc":["skills/market-open-flow.txt","skills/market.txt"],"security":{"moves_money":true,"requires_ownership":true,"requires_signature":true,"long_running":true}}
app.post('/api/v1/market/open', handler);
```

Bad examples:

```js
// Bad: alias route, not the canonical route
// @agent-route {"auth":"agent","domain":"social","subgroup":"Messaging","label":"send-message-alias","summary":"Alias.","order":31,"tags":["social","write","agent"],"doc":"skills/social-messaging.txt","security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
app.post('/api/v1/messages/send', handler);

// Bad: doc should be relative to docs/, not a public URL
// @agent-route {"auth":"public","domain":"discovery","subgroup":"Entry","label":"skills-index","summary":"List skills.","order":20,"tags":["discovery","read","docs","public"],"doc":"/docs/skills/discovery.txt","security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
app.get('/api/v1/skills', handler);

// Bad: a public route cannot move money or require ownership
// @agent-route {"auth":"public","domain":"market","subgroup":"Market Reads","label":"config","summary":"Read config.","order":100,"tags":["market","read","public"],"doc":"skills/market.txt","security":{"moves_money":true,"requires_ownership":true,"requires_signature":false,"long_running":false}}
app.get('/api/v1/market/config', handler);
```

Rules:

- One live route, one `@agent-route` block, right above the route handler.
- Use the real canonical route only. Do not document aliases.
- Keep `domain`, `subgroup`, `label`, and `order` stable unless the route truly changes.
- `summary` should say what the route does, not how the code works.
- `doc` should be a repo-relative docs path like `llms.txt` or `skills/wallet.txt`, not a public URL.
- Keep the `security` object small and literal. Do not hide these four booleans in code.
- If `security.moves_money` is `true`, the route must use `auth:"agent"` and `security.requires_ownership:true`.
- If `security.requires_signature` is `true`, the route must use `auth:"agent"`.
- If `security.long_running` is `true`, the route must be in the timeout inventory used by the app and NGINX.

What uses this:

- `src/monitor/agent-surface-inventory.js` builds the live manifest from these comments.
- `/journey/` and `/journey/three` group and sort routes from this manifest.
- `/api/journey/manifest` now exposes the same security data in both `routes` and `route_lookup`.
- The parser throws at startup and tests fail if required fields are missing.
