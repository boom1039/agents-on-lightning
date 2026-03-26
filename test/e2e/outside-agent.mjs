#!/usr/bin/env node
/**
 * Outside Agent — A real external agent that knows ONLY the playbook.
 *
 * Uses an LLM with a single tool (http_request) to walk through
 * the entire agent lifecycle. No codebase access, no insider knowledge.
 *
 * If the agent can complete the lifecycle from the playbook alone, the docs work.
 * If it gets stuck, the playbook needs fixing.
 *
 * Usage:
 *   # Two agents in separate terminals (production-realistic):
 *   ANTHROPIC_API_KEY=sk-... node outside-agent.mjs --provider anthropic --phase lifecycle --agent-name alpha --verbose
 *   ANTHROPIC_API_KEY=sk-... node outside-agent.mjs --provider anthropic --phase lifecycle --agent-name bravo --verbose
 *
 *   # Legacy single-phase testing:
 *   node outside-agent.mjs --phase register
 *   ANTHROPIC_API_KEY=sk-... node outside-agent.mjs --provider anthropic --phase all
 *
 * Options:
 *   --provider <name>      LLM provider: ollama (default) or anthropic
 *   --phase <name>         Phase to run (register, wallet, social, channel, analytics, all, lifecycle)
 *   --agent-name <name>    Persistent agent identity (saves/loads keys to agent-keys.json)
 *   --model <id>           Override model (default depends on provider)
 *   --max-turns <n>        Max API round-trips (default: 80)
 *   --fresh                Ignore saved keys, register a new agent
 *   --verbose              Print full HTTP responses
 *   --dry-run              Print the system prompt and exit
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'http://localhost:3200';
const LOG_FILE = join(__dirname, 'outside-agent-runs.jsonl');
const KEYS_FILE = join(__dirname, 'agent-keys.json');

// ─── CLI args ───

const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; }
function opt(name, def) { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; }

const VERBOSE = flag('--verbose');
const DRY_RUN = flag('--dry-run');
const FRESH = flag('--fresh');
const PROVIDER = opt('--provider', 'anthropic');
const PHASE = opt('--phase', 'lifecycle');
const AGENT_NAME = opt('--agent-name', null);
const MODEL = opt('--model', PROVIDER === 'ollama' ? 'qwen2.5-coder:14b' : 'claude-haiku-4-5-20251001');
const MAX_TURNS = parseInt(opt('--max-turns', '80'), 10);

// ─── Key persistence ───

function loadKeys() {
  if (!existsSync(KEYS_FILE)) return {};
  try { return JSON.parse(readFileSync(KEYS_FILE, 'utf-8')); } catch { return {}; }
}

function saveKeys(keys) {
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2) + '\n');
}

// Load existing agent keys if --agent-name was given
let savedAgent = null;
if (AGENT_NAME && !FRESH) {
  const keys = loadKeys();
  if (keys[AGENT_NAME]) {
    savedAgent = keys[AGENT_NAME];
  }
}

// ─── Load the playbook (used by legacy phases) ───

const playbook = readFileSync(join(__dirname, '../../../site/llms-full.txt'), 'utf-8');

// ─── Phase definitions ───

const PERSONALITY = {
  alpha: '',
  bravo: '',
};

const PHASES = {
  register: `
Complete Phase 1 only:
1. Discover the platform (GET /api/v1/)
2. Register as a new agent
3. Read your profile
4. Update your profile with a name and description
Report your agent_id and api_key when done.`,

  wallet: `
Complete the wallet phase:
1. Register a new agent (you need an api_key first)
2. Create a mint quote for 10 sats
3. DO NOT try to pay the invoice — just verify the quote was created and the invoice is returned
4. Check your balance (should be 0)
5. Check your wallet history
Report what happened at each step.`,

  social: `
Complete the social phase with TWO agents:
1. Register Agent A and Agent B
2. Send a message from A to B
3. Check B's inbox
4. Propose an alliance from A to B
5. Accept the alliance as B
6. Check the leaderboard
Report what happened at each step.`,

  channel: `
Complete the channel research phase:
1. Register a new agent
2. Check network health
3. Profile a node (use the pubkey from network health top nodes)
4. Check fee competitiveness for that node
5. Check market config
6. Check peer safety for that node
Report what you learned about the network.`,

  analytics: `
Complete the analytics phase:
1. Register a new agent
2. Browse the analytics catalog
3. Get a quote for a query from the catalog
4. Check capital balance (should be 0)
Report what analytics are available and their costs.`,

  all: `
Complete the FULL agent lifecycle:

Phase 1 — Discovery & Registration:
1. GET /api/v1/ to discover the platform
2. Register as a new agent
3. Read and update your profile

Phase 2 — Wallet:
4. Create a mint quote (any small amount)
5. Check balance, history

Phase 3 — Social (register a second agent):
6. Send a message between agents
7. Propose and accept an alliance
8. Post a bounty
9. Check the leaderboard

Phase 4 — Network Research:
10. Analyze network health
11. Profile a top node
12. Check fee competitiveness
13. Check peer safety

Phase 5 — Analytics & Help:
14. Browse analytics catalog
15. Check capital balance

Phase 6 — Cashu Self-Custody:
16. Check cashu balance and mint metrics

Complete every step. Report what happened. If something fails, note it and move on.`,

  lifecycle: null, // Built dynamically below
};

// ─── Build lifecycle phase (bootstrap prompt — no playbook injection) ───

function buildLifecyclePrompt() {
  return `You are an AI agent. You have one tool: http_request (method, path, body, headers).`;
}

// ─── Build system prompt ───

let systemPrompt;

if (PHASE === 'lifecycle') {
  systemPrompt = buildLifecyclePrompt(AGENT_NAME);
} else {
  const mission = PHASES[PHASE];
  if (!mission) {
    console.error(`Unknown phase: ${PHASE}. Options: ${Object.keys(PHASES).join(', ')}`);
    process.exit(1);
  }

  const toolInstructions = PROVIDER === 'ollama'
    ? `
HOW TO MAKE REQUESTS:
Output an ACTION block to make an HTTP request. Format:

\`\`\`ACTION
{"method": "GET", "path": "/api/v1/"}
\`\`\`

For POST/PUT with a body:
\`\`\`ACTION
{"method": "POST", "path": "/api/v1/agents/register", "body": {"name": "my-agent"}}
\`\`\`

For authenticated requests:
\`\`\`ACTION
{"method": "GET", "path": "/api/v1/agents/me", "headers": {"Authorization": "Bearer YOUR-API-KEY"}}
\`\`\`

Output EXACTLY ONE action block per response. Think about what to do, then output the action.
The system will execute the request and show you the response. Then decide the next step.`
    : ``;

  systemPrompt = `You are an AI agent interacting with the Lightning Observatory platform.

You have ONE source of truth: the Agent Playbook below. You have NO other knowledge of the platform.
You can ONLY interact via HTTP requests. You cannot run shell commands, read files, or access anything else.

RULES:
- Use ONLY the endpoints documented in the playbook
- Use ONLY the field names shown in the playbook
- Parse JSON responses to extract IDs, tokens, and other values for subsequent requests
- If a response contains an error, read the error message carefully and adjust
- Always use the base URL: ${BASE_URL}
- When you need auth, use: Authorization: Bearer <your-api-key>
- Track your agent_id and api_key from registration — you need them for everything
- Be methodical: one request at a time, check the response, then decide the next step
${toolInstructions}

YOUR MISSION:
${mission}

IMPORTANT: After completing all steps, output a final summary starting with "=== FINAL REPORT ===" that lists:
- Each step attempted
- Whether it succeeded or failed
- Any errors encountered
- Any playbook documentation that was confusing or wrong

=== AGENT PLAYBOOK (your only reference) ===

${playbook}`;
}

if (DRY_RUN) {
  console.log(systemPrompt);
  console.log(`\n--- System prompt: ${systemPrompt.length} chars, ~${Math.ceil(systemPrompt.length / 4)} tokens ---`);
  process.exit(0);
}

// ─── The single tool: make HTTP requests ───

const tools = [
  {
    name: 'http_request',
    description: 'Make an HTTP request.',
    input_schema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE'],
          description: 'HTTP method',
        },
        path: {
          type: 'string',
          description: 'Path starting with /',
        },
        body: {
          type: 'object',
          description: 'JSON request body',
        },
        headers: {
          type: 'object',
          description: 'Additional headers',
        },
      },
      required: ['method', 'path'],
    },
  },
];

// ─── Execute HTTP requests ───

const requestLog = [];

async function executeHttpRequest({ method, path, body, headers = {} }) {
  const url = `${BASE_URL}${path}`;
  const fetchOpts = { method, headers: { ...headers } };

  if (body && (method === 'POST' || method === 'PUT')) {
    fetchOpts.headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(body);
  }

  const start = Date.now();
  let response;
  try {
    response = await fetch(url, fetchOpts);
  } catch (err) {
    const entry = { method, path, body: body || null, status: 0, error: err.message, ms: Date.now() - start };
    requestLog.push(entry);
    return JSON.stringify({ error: `Connection failed: ${err.message}` });
  }

  const text = await response.text();
  const ms = Date.now() - start;
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  const entry = {
    method, path,
    body: body || null,
    status: response.status,
    responseSize: text.length,
    ms,
  };
  requestLog.push(entry);

  // Intercept registration responses to save keys
  if (AGENT_NAME && method === 'POST' && path.includes('/agents/register') && json?.agent_id && json?.api_key) {
    const keys = loadKeys();
    keys[AGENT_NAME] = {
      agent_id: json.agent_id,
      api_key: json.api_key,
      name: json.name || AGENT_NAME,
      created_at: new Date().toISOString(),
    };
    saveKeys(keys);
    console.log(`    [Keys saved for "${AGENT_NAME}" → agent-keys.json]`);
  }

  // Also save if agent updates their name
  if (AGENT_NAME && method === 'PUT' && path.includes('/agents/me') && json?.name) {
    const keys = loadKeys();
    if (keys[AGENT_NAME]) {
      keys[AGENT_NAME].name = json.name;
      saveKeys(keys);
    }
  }

  // Truncate very large responses to save tokens
  const maxResponseSize = 4000;
  let resultBody;
  if (text.length > maxResponseSize) {
    resultBody = text.substring(0, maxResponseSize) + `\n\n... [TRUNCATED: ${text.length} bytes total, showing first ${maxResponseSize}]`;
  } else {
    resultBody = json || text;
  }

  if (VERBOSE) {
    console.log(`    ${method} ${path} → ${response.status} (${text.length}B, ${ms}ms)`);
    if (body) console.log(`      body: ${JSON.stringify(body).substring(0, 200)}`);
  }

  return JSON.stringify({
    status: response.status,
    body: resultBody,
  });
}

// ─── LLM Providers ───

async function callAnthropic(messages, systemPrompt, tools) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    tools,
    messages,
  });
  const toolCalls = response.content.filter(b => b.type === 'tool_use');
  const textBlocks = response.content.filter(b => b.type === 'text');
  return {
    textBlocks: textBlocks.map(b => b.text),
    toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
    stopReason: response.stop_reason,
    rawContent: response.content,
  };
}

function buildToolResultsAnthropic(toolCalls, results) {
  return results.map((r, i) => ({
    type: 'tool_result',
    tool_use_id: toolCalls[i].id,
    content: r,
  }));
}

async function callOllama(messages, _systemPrompt, _tools) {
  // Use text-based tool calling: model outputs reasoning + JSON action block
  // This works with ALL models (no tool_calls support needed)
  const response = await fetch('http://localhost:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 4096,
      temperature: 0.1,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama ${response.status}: ${text.substring(0, 200)}`);
  }
  const data = await response.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('No choices in Ollama response');

  const msg = choice.message;
  let textContent = msg.content || '';
  let toolCalls = [];

  // Parse ACTION blocks from the text: ```ACTION\n{...}\n```
  const actionMatch = textContent.match(/```ACTION\s*\n([\s\S]*?)\n```/);
  if (actionMatch) {
    try {
      const action = JSON.parse(actionMatch[1].trim());
      if (action.method && action.path) {
        toolCalls = [{
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          name: 'http_request',
          input: { method: action.method, path: action.path, body: action.body, headers: action.headers },
        }];
      }
    } catch { /* bad JSON in ACTION block */ }
    // Strip ACTION block from text output
    textContent = textContent.replace(/```ACTION\s*\n[\s\S]*?\n```/, '').trim();
  }

  // Fallback: try to find raw JSON with method+path anywhere in text
  if (toolCalls.length === 0) {
    const jsonMatch = textContent.match(/\{[^{}]*"method"\s*:\s*"(GET|POST|PUT|DELETE)"[^{}]*"path"\s*:\s*"[^"]+?"[^{}]*\}/);
    if (jsonMatch) {
      try {
        const action = JSON.parse(jsonMatch[0]);
        if (action.method && action.path) {
          toolCalls = [{
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            name: 'http_request',
            input: { method: action.method, path: action.path, body: action.body, headers: action.headers },
          }];
        }
      } catch { /* not valid JSON */ }
    }
  }

  const textBlocks = textContent.trim() ? [textContent] : [];

  return {
    textBlocks,
    toolCalls,
    stopReason: toolCalls.length === 0 ? 'end_turn' : 'tool_use',
    rawContent: msg,
  };
}

function buildMessagesAnthropic(messages, assistantRaw, toolResults) {
  messages.push({ role: 'assistant', content: assistantRaw });
  messages.push({ role: 'user', content: toolResults });
}

function buildMessagesOllama(messages, assistantRaw, toolCalls, results) {
  messages.push({ role: 'assistant', content: assistantRaw.content || '' });
  // Feed tool results back as a user message so the model can see them
  const resultText = results.map((r, i) => {
    const tc = toolCalls[i];
    return `HTTP Response for ${tc.input.method} ${tc.input.path}:\n${r}`;
  }).join('\n\n');
  messages.push({ role: 'user', content: resultText });
}

// ─── Main agent loop ───

async function main() {
  const isOllama = PROVIDER === 'ollama';

  if (!isOllama && !process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY environment variable');
    process.exit(1);
  }

  const t0 = Date.now();

  console.log(`\n  Outside Agent E2E Test`);
  console.log(`  Provider: ${PROVIDER}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  Phase: ${PHASE}`);
  if (AGENT_NAME) console.log(`  Agent: ${AGENT_NAME}${savedAgent ? ` (resuming as "${savedAgent.name}", id=${savedAgent.agent_id})` : ' (new)'}`);
  console.log(`  Max turns: ${MAX_TURNS}`);
  if (PHASE !== 'lifecycle') console.log(`  Playbook: ${playbook.length} chars`);
  console.log();

  // Check server is up
  try {
    const r = await fetch(`${BASE_URL}/api/v1/`);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
  } catch (err) {
    console.error(`  Server not responding at ${BASE_URL}: ${err.message}`);
    process.exit(1);
  }
  console.log(`  Server: ${BASE_URL} ✓`);

  // Check Ollama is up
  if (isOllama) {
    try {
      const r = await fetch('http://localhost:11434/api/tags');
      if (!r.ok) throw new Error(`status ${r.status}`);
      console.log(`  Ollama: localhost:11434 ✓`);
    } catch (err) {
      console.error(`  Ollama not responding: ${err.message}`);
      process.exit(1);
    }
  }
  console.log();

  // Reset rate limits for clean test
  await fetch(`${BASE_URL}/api/v1/test/reset-rate-limits`, { method: 'POST' });

  // Build initial messages (format differs per provider)
  let messages;
  if (isOllama) {
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: BASE_URL },
    ];
  } else {
    messages = [{ role: 'user', content: BASE_URL }];
  }

  let turn = 0;
  let finalReport = null;

  while (turn < MAX_TURNS) {
    turn++;
    process.stdout.write(`  Turn ${turn}/${MAX_TURNS}: `);

    let result;
    try {
      result = isOllama
        ? await callOllama(messages, systemPrompt, tools)
        : await callAnthropic(messages, systemPrompt, tools);
    } catch (err) {
      console.log(`API error: ${err.message}`);
      break;
    }

    // Print text output (agent's reasoning)
    for (const text of result.textBlocks) {
      const trimmed = text.trim();
      if (trimmed) {
        if (trimmed.includes('=== FINAL REPORT ===')) finalReport = trimmed;
        // For lifecycle phase, print more text so human can follow along
        if (PHASE === 'lifecycle') {
          // Print lines that contain INVOICE: in full (human needs to copy them)
          const lines = trimmed.split('\n');
          for (const line of lines) {
            if (line.includes('INVOICE:') || line.startsWith('lnbc')) {
              console.log(`\n  ⚡ ${line}`);
            }
          }
          // Print first 3 lines of reasoning
          const preview = lines.slice(0, 3).join(' | ').substring(0, 150);
          console.log(preview);
        } else {
          const firstLine = trimmed.split('\n')[0].substring(0, 100);
          console.log(firstLine);
        }
      }
    }

    if ((result.stopReason === 'end_turn' || result.stopReason === 'stop') && result.toolCalls.length === 0) {
      console.log('  [Agent finished]');
      if (!finalReport) finalReport = result.textBlocks.join('\n');
      break;
    }

    if (result.toolCalls.length === 0) {
      console.log('  [No tool calls, no end_turn — stopping]');
      break;
    }

    // Execute tool calls
    const execResults = [];
    for (const call of result.toolCalls) {
      if (call.name === 'http_request') {
        console.log(`${call.input.method} ${call.input.path}`);
        if (requestLog.length % 10 === 0) {
          await fetch(`${BASE_URL}/api/v1/test/reset-rate-limits`, { method: 'POST' });
        }
        execResults.push(await executeHttpRequest(call.input));
      } else {
        console.log(`[unknown tool: ${call.name}]`);
        execResults.push(JSON.stringify({ error: `Unknown tool: ${call.name}` }));
      }
    }

    // Append to message history (format differs per provider)
    if (isOllama) {
      buildMessagesOllama(messages, result.rawContent, result.toolCalls, execResults);
    } else {
      const toolResults = buildToolResultsAnthropic(result.toolCalls, execResults);
      buildMessagesAnthropic(messages, result.rawContent, toolResults);
    }
  }

  // ─── Summary ───

  const totalMs = Date.now() - t0;
  const successCount = requestLog.filter(r => r.status >= 200 && r.status < 400).length;
  const errorCount = requestLog.filter(r => r.status >= 400).length;
  const failCount = requestLog.filter(r => r.status >= 500 || r.status === 0).length;
  const uniqueEndpoints = new Set(requestLog.map(r => `${r.method} ${r.path.split('?')[0]}`));

  console.log('\n  ═══════════════════════════════════════');
  console.log(`  Turns: ${turn}/${MAX_TURNS}`);
  console.log(`  Requests: ${requestLog.length} (${successCount} ok, ${errorCount} client errors, ${failCount} server errors)`);
  console.log(`  Unique endpoints: ${uniqueEndpoints.size}`);
  console.log(`  Duration: ${(totalMs / 1000).toFixed(1)}s`);
  if (AGENT_NAME) console.log(`  Agent name: ${AGENT_NAME}`);

  // Show all requests
  console.log('\n  Request log:');
  for (const r of requestLog) {
    const icon = r.status >= 500 || r.status === 0 ? '✗' : r.status >= 400 ? '⚠' : '✓';
    console.log(`    ${icon} ${r.method} ${r.path} → ${r.status} (${r.responseSize || 0}B, ${r.ms}ms)`);
  }

  // Show largest responses
  const sorted = [...requestLog].sort((a, b) => (b.responseSize || 0) - (a.responseSize || 0));
  if (sorted.length > 0) {
    console.log('\n  Largest responses:');
    for (const r of sorted.slice(0, 5)) {
      console.log(`    ${String(r.responseSize || 0).padStart(7)}B  ${r.method} ${r.path}`);
    }
  }

  // Print final report
  if (finalReport) {
    console.log('\n  ═══════════════════════════════════════');
    console.log('  AGENT FINAL REPORT:');
    console.log('  ───────────────────');
    console.log(finalReport.split('\n').map(l => `  ${l}`).join('\n'));
  }

  // Append to history
  appendFileSync(LOG_FILE, JSON.stringify({
    ts: new Date().toISOString(),
    provider: PROVIDER,
    model: MODEL,
    phase: PHASE,
    agent_name: AGENT_NAME || null,
    turns: turn,
    max_turns: MAX_TURNS,
    requests: requestLog.length,
    success: successCount,
    client_errors: errorCount,
    server_errors: failCount,
    unique_endpoints: uniqueEndpoints.size,
    ms: totalMs,
    endpoints_hit: [...uniqueEndpoints],
    has_final_report: !!finalReport,
  }) + '\n');

  console.log(`\n  → ${LOG_FILE}\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
