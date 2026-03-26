/**
 * Shared constants, HTTP client, and provider factory for the agent walkthrough skill.
 * Used by both agent.mjs (interactive) and test-runner.mjs (automated).
 */

// ─── CLI helpers ───

export function flag(name, args) { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; }
export function opt(name, def, args) { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; }

// ─── Constants ───

export const SYSTEM = 'You are an AI agent. You have one tool: http_request. The user will tell you what to do.';

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

// ─── HTTP execution ───

const TRUNCATE_MAX = 4000;

export async function doHttp({ method, url, body, headers = {} }, baseUrl = '') {
  const fullUrl = (baseUrl && url.startsWith('/')) ? `${baseUrl}${url}` : url;
  const opts = { method, headers: { ...headers } };
  if (body && (method === 'POST' || method === 'PUT')) {
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

  const result = text.length > TRUNCATE_MAX
    ? text.substring(0, TRUNCATE_MAX) + `\n\n... [TRUNCATED: ${text.length} bytes, showing first ${TRUNCATE_MAX}]`
    : (parsed || text);

  const responseBytes = text.length;
  return {
    raw: JSON.stringify({ status: res.status, body: result }),
    status: res.status, parsed, latency, reqBody: body || null,
    errSnippet, responseBytes,
  };
}

// ─── Provider Factory ───

export async function createProvider(modelConfig) {
  const { provider, id } = modelConfig;

  if (provider === 'anthropic') {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();
    return {
      async call(messages) {
        const r = await client.messages.create({
          model: id, max_tokens: 4096, system: SYSTEM,
          tools: [{ name: TOOL_NAME, description: TOOL_DESC, input_schema: TOOL_PARAMS }],
          messages,
        });
        const text = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        const toolCalls = r.content.filter(b => b.type === 'tool_use').map(tc => ({ id: tc.id, input: tc.input }));
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
      const oaiMessages = [{ role: 'system', content: SYSTEM }, ...messages];
      const r = await client.chat.completions.create({
        model: id, max_tokens: 4096,
        tools: [{ type: 'function', function: { name: TOOL_NAME, description: TOOL_DESC, parameters: TOOL_PARAMS } }],
        messages: oaiMessages,
      });
      const msg = r.choices[0].message;
      const text = msg.content || '';
      const toolCalls = (msg.tool_calls || []).map(tc => {
        let input;
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
        return { id: tc.id, input };
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
