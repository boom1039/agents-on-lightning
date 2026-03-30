import { spawn } from 'node:child_process';

/**
 * Shared constants, HTTP client, and provider factory for the agent walkthrough skill.
 * Used by both agent.mjs (interactive) and test-runner.mjs (automated).
 */

// ─── CLI helpers ───

export function flag(name, args) { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; }
export function opt(name, def, args) { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; }

// ─── Constants ───

export const SYSTEM = 'You are an AI agent. Use the provided tools carefully. The user will tell you what to do.';

export const TOOL_NAME = 'http_request';
export const TOOL_DESC = 'Make an HTTP request to any URL.';
export const TOOL_PARAMS = {
  type: 'object',
  properties: {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
    url: { type: 'string', description: 'Full URL (e.g. http://example.com/path)' },
    body: { type: 'object', description: 'JSON body (POST/PUT only)' },
    headers: { type: 'object', description: 'Extra headers' },
  },
  required: ['method', 'url'],
};

export const HTTP_TOOL = {
  name: TOOL_NAME,
  description: TOOL_DESC,
  parameters: TOOL_PARAMS,
};

export const TERMINAL_TOOL_NAME = 'terminal_command';
export const TERMINAL_TOOL_DESC = 'Run a local terminal command in a generic agent runtime. Use this the way a real agent would use its own shell.';
export const TERMINAL_TOOL_PARAMS = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Shell command to run locally.' },
    timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds.' },
  },
  required: ['command'],
};

export const TERMINAL_TOOL = {
  name: TERMINAL_TOOL_NAME,
  description: TERMINAL_TOOL_DESC,
  parameters: TERMINAL_TOOL_PARAMS,
};

// ─── Utilities ───

export const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

export function formatTime(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`;
}

export function formatBytes(b) {
  if (b < 1024) return `${b}B`;
  return `${(b / 1024).toFixed(1)}KB`;
}

function appendChunk(current, chunk, max) {
  if (current.length >= max) return current;
  const next = current + chunk;
  return next.length > max ? next.slice(0, max) : next;
}

function splitCommandSegments(command) {
  const segments = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escapeNext = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (escapeNext) {
      current += ' ';
      escapeNext = false;
      continue;
    }

    if (inSingle) {
      if (ch === '\'') inSingle = false;
      current += ' ';
      continue;
    }

    if (inDouble) {
      if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      current += ' ';
      continue;
    }

    if (inBacktick) {
      if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '`') {
        inBacktick = false;
      }
      current += ' ';
      continue;
    }

    if (ch === '\'') {
      inSingle = true;
      current += ' ';
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ' ';
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      current += ' ';
      continue;
    }
    if (ch === ';') {
      segments.push(current.trim());
      current = '';
      continue;
    }
    if (ch === '|' && next === '|') {
      segments.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    if (ch === '&' && next === '&') {
      segments.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    if (ch === '|') {
      segments.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments.filter(Boolean);
}

const TERMINAL_ALLOWED_COMMANDS = new Set([
  'awk',
  'base64',
  'cat',
  'cut',
  'date',
  'echo',
  'grep',
  'head',
  'hexdump',
  'jq',
  'ls',
  'mkdir',
  'node',
  'openssl',
  'printf',
  'pwd',
  'python',
  'python3',
  'sh',
  'sed',
  'sha256sum',
  'shasum',
  'sleep',
  'tail',
  'touch',
  'tr',
  'wc',
  'xxd',
]);

const TERMINAL_BLOCKED_PATTERN = /\b(?:apt|brew|curl|git|kill|lncli|mv|npm|npx|open|osascript|pip|pip3|pnpm|python3?\s+-m\s+pip|rm|rsync|scp|ssh|wget|yarn)\b/i;

function extractCommandHeads(command) {
  return splitCommandSegments(command)
    .map(segment => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const cleaned = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, '');
      const match = cleaned.match(/^([^\s]+)/);
      return match ? match[1] : '';
    })
    .filter(Boolean);
}

export async function doTerminalCommand({ command, timeout_ms }, options = {}) {
  const safeCommand = typeof command === 'string' ? command.trim() : '';
  if (!safeCommand) {
    return { ok: false, exit_code: -1, timed_out: false, stdout: '', stderr: 'missing command' };
  }
  if (TERMINAL_BLOCKED_PATTERN.test(safeCommand)) {
    return { ok: false, exit_code: -1, timed_out: false, stdout: '', stderr: 'command blocked in generic agent runtime' };
  }
  const commandHeads = extractCommandHeads(safeCommand);
  if (commandHeads.some(head => !TERMINAL_ALLOWED_COMMANDS.has(head))) {
    return {
      ok: false,
      exit_code: -1,
      timed_out: false,
      stdout: '',
      stderr: `command not allowed in generic agent runtime: ${commandHeads.join(', ')}`,
    };
  }

  const timeoutMs = Math.max(1000, Math.min(Number(timeout_ms) || 15000, 30000));
  const cwd = options.cwd || process.cwd();
  const maxOutput = Math.max(1024, Math.min(Number(options.maxOutputBytes) || 12000, 50000));

  return await new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-lc', safeCommand], {
      cwd,
      env: {
        ...process.env,
        AOL_AGENT_RUNTIME_DIR: cwd,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = appendChunk(stdout, String(chunk), maxOutput);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendChunk(stderr, String(chunk), maxOutput);
    });

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      resolve({
        ok: !timedOut && code === 0,
        exit_code: Number.isInteger(code) ? code : -1,
        signal: signal || null,
        timed_out: timedOut,
        cwd,
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({
        ok: false,
        exit_code: -1,
        signal: null,
        timed_out: timedOut,
        cwd,
        stdout,
        stderr: err.message,
      });
    });
  });
}

// ─── HTTP execution ───

const TRUNCATE_MAX = 4000;
const DOC_TRUNCATE_MAX = 24000;

function responseTruncateMax(url = '') {
  return /\/llms\.txt$|\/api\/v1\/skills\/|\/docs\/skills\//.test(url) ? DOC_TRUNCATE_MAX : TRUNCATE_MAX;
}

export async function doHttp({ method, url, body, headers = {} }, baseUrl = '') {
  const safeMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';
  const safeUrl = typeof url === 'string' ? url.trim() : '';
  if (!safeUrl) {
    return {
      raw: JSON.stringify({ status: 0, error: 'missing url' }),
      status: 0, parsed: null, latency: 0, reqBody: body || null,
      errSnippet: 'missing url', responseBytes: 0,
    };
  }

  const fullUrl = (baseUrl && safeUrl.startsWith('/')) ? `${baseUrl}${safeUrl}` : safeUrl;
  const opts = { method: safeMethod, headers: { ...headers } };
  if (body && (safeMethod === 'POST' || safeMethod === 'PUT')) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(fullUrl, opts);
  } catch (err) {
    const latency = Date.now() - t0;
    return {
      raw: JSON.stringify({ status: 0, error: err.message }),
      status: 0, parsed: null, latency, reqBody: body || null,
      errSnippet: err.message, responseBytes: 0,
    };
  }

  const latency = Date.now() - t0;
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }

  let errSnippet = null;
  if (res.status >= 400 && parsed) {
    errSnippet = parsed.error || parsed.message || parsed.detail || JSON.stringify(parsed).substring(0, 120);
  }

  const truncateMax = responseTruncateMax(fullUrl);
  const result = text.length > truncateMax
    ? text.substring(0, truncateMax) + `\n\n... [TRUNCATED: ${text.length} bytes, showing first ${truncateMax}]`
    : (parsed || text);

  const responseBytes = text.length;
  return {
    raw: JSON.stringify({ status: res.status, body: result }),
    status: res.status, parsed, latency, reqBody: body || null,
    errSnippet, responseBytes,
  };
}

// ─── Provider Factory ───

function toAnthropicTools(tools) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function toOpenAiTools(tools) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export async function createProvider(modelConfig, options = {}) {
  const { provider, id } = modelConfig;
  const system = options.system || SYSTEM;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? options.requestTimeoutMs
    : 12000;
  const tools = Array.isArray(options.tools) && options.tools.length > 0
    ? options.tools
    : [HTTP_TOOL];

  async function withTimeout(label, promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`${label}_timeout`);
            err.code = 'PROVIDER_TIMEOUT';
            reject(err);
          }, requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (provider === 'anthropic') {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();
    return {
      async call(messages) {
        const r = await withTimeout('anthropic', client.messages.create({
          model: id, max_tokens: 4096, system,
          tools: toAnthropicTools(tools),
          messages,
        }));
        const text = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        const toolCalls = r.content
          .filter(b => b.type === 'tool_use')
          .map(tc => ({ id: tc.id, name: tc.name, input: tc.input }));
        return { text, toolCalls, raw: r.content, usage: { input: r.usage?.input_tokens || 0, output: r.usage?.output_tokens || 0 } };
      },
      push(messages, raw, results) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) });
      },
    };
  }

  // OpenAI and OpenRouter both use the OpenAI SDK
  const OpenAI = (await import('openai')).default;
  const config = provider === 'openrouter'
    ? { baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY }
    : {};
  const client = new OpenAI(config);

  return {
    async call(messages) {
      const oaiMessages = [{ role: 'system', content: system }, ...messages];
      const completionBudget = id.startsWith('gpt-5')
        ? { max_completion_tokens: 4096 }
        : { max_tokens: 4096 };
      const r = await withTimeout('openai', client.chat.completions.create({
        model: id,
        ...completionBudget,
        tools: toOpenAiTools(tools),
        messages: oaiMessages,
      }));
      const msg = r.choices[0].message;
      const text = msg.content || '';
      const toolCalls = (msg.tool_calls || []).map(tc => {
        let input;
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
        return { id: tc.id, name: tc.function.name, input };
      });
      return { text, toolCalls, raw: msg, usage: { input: r.usage?.prompt_tokens || 0, output: r.usage?.completion_tokens || 0 } };
    },
    push(messages, raw, results) {
      messages.push({ role: 'assistant', content: raw.content, tool_calls: raw.tool_calls });
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    },
  };
}
