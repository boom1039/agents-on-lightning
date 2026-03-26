/**
 * Agent-Friendly Error Responses
 *
 * Inspired by Cloudflare's RFC 9457 approach: every error tells the agent
 * what happened, whether to retry, and what to do next. Agents parse JSON,
 * not prose — so errors must be machine-actionable, not just human-readable.
 *
 * Every error response includes:
 *   - status: HTTP status code (in body, so agents don't need to inspect headers)
 *   - error: short machine-readable error name
 *   - message: human-readable explanation
 *   - retryable: boolean — should the agent retry this request?
 *   - hint: what the agent should do to recover
 *
 * Optional fields:
 *   - retry_after_seconds: how long to wait before retrying (429s)
 *   - see: URL/endpoint with more info
 *   - available: list of valid options (404s)
 */

/**
 * Send a structured agent-friendly error response.
 *
 * @param {import('express').Response} res
 * @param {number} status - HTTP status code
 * @param {object} opts
 * @param {string} opts.error - Short error name (e.g., 'authentication_required')
 * @param {string} opts.message - Human-readable explanation
 * @param {boolean} [opts.retryable=false] - Whether the agent should retry
 * @param {string} [opts.hint] - Recovery instructions
 * @param {number} [opts.retry_after_seconds] - Seconds to wait before retry
 * @param {string} [opts.see] - Endpoint or URL with more info
 * @param {string[]} [opts.available] - Valid options (for 404s)
 * @param {object} [opts.extra] - Any additional fields to merge
 */
export function agentError(res, status, opts) {
  const body = {
    status,
    error: opts.error,
    message: opts.message,
    retryable: opts.retryable ?? false,
  };

  if (opts.hint) body.hint = opts.hint;
  if (opts.retry_after_seconds != null) {
    body.retry_after_seconds = opts.retry_after_seconds;
    res.set('Retry-After', String(opts.retry_after_seconds));
  }
  if (opts.see) body.see = opts.see;
  if (opts.available) body.available = opts.available;
  if (opts.extra) Object.assign(body, opts.extra);

  return res.status(status).json(body);
}

// --- Pre-built errors for common cases ---

export function err401NoAuth(res) {
  return agentError(res, 401, {
    error: 'authentication_required',
    message: 'This endpoint requires an API key.',
    hint: 'Send Authorization: Bearer <api_key> header. Get a key: POST /api/v1/agents/register with {"name": "your-agent-name"}.',
    see: 'POST /api/v1/agents/register',
  });
}

export function err401BadFormat(res) {
  return agentError(res, 401, {
    error: 'invalid_api_key_format',
    message: 'API key must start with lb-agent-.',
    hint: 'Register to get a valid key: POST /api/v1/agents/register with {"name": "your-agent-name"}.',
    see: 'POST /api/v1/agents/register',
  });
}

export function err401BadKey(res) {
  return agentError(res, 401, {
    error: 'invalid_api_key',
    message: 'API key not recognized. It may have expired or been revoked.',
    hint: 'Register again: POST /api/v1/agents/register with {"name": "your-agent-name"}.',
    see: 'POST /api/v1/agents/register',
  });
}

export function err429(res, { category, retryAfter }) {
  return agentError(res, 429, {
    error: 'rate_limit_exceeded',
    message: `Rate limit exceeded${category ? ` for ${category}` : ''}. Wait and retry.`,
    retryable: true,
    retry_after_seconds: retryAfter,
    hint: `Wait ${retryAfter} seconds, then retry. If rate-limited again, double the wait time.`,
  });
}

export function err503Service(res, serviceName) {
  return agentError(res, 503, {
    error: 'service_unavailable',
    message: `${serviceName} is temporarily unavailable.`,
    retryable: true,
    retry_after_seconds: 30,
    hint: 'This is usually temporary. Wait 30 seconds and try again. If it persists, the platform may be restarting.',
    see: 'GET /api/v1/platform/status',
  });
}

export function err404NotFound(res, resource, { available, see } = {}) {
  const opts = {
    error: 'not_found',
    message: `${resource} not found.`,
    hint: available
      ? `Valid options: ${available.slice(0, 10).join(', ')}${available.length > 10 ? ` (${available.length} total)` : ''}.`
      : see
        ? `Check ${see} for available options.`
        : 'Verify the identifier and try again.',
  };
  if (available) opts.available = available;
  if (see) opts.see = see;
  return agentError(res, 404, opts);
}

export function err400Validation(res, message, { hint, see } = {}) {
  return agentError(res, 400, {
    error: 'validation_error',
    message,
    hint: hint || 'Check your request body and try again.',
    see,
  });
}

export function err400MissingField(res, field, { example, hint, see } = {}) {
  return agentError(res, 400, {
    error: 'missing_required_field',
    message: `${field} is required.`,
    hint: example
      ? `Include ${field} in your request. Example: ${JSON.stringify(example)}`
      : hint || `Include ${field} in your request body.`,
    see,
  });
}

export function err500Internal(res, context) {
  return agentError(res, 500, {
    error: 'internal_error',
    message: `Something went wrong${context ? ` while ${context}` : ''}.`,
    retryable: true,
    retry_after_seconds: 5,
    hint: 'This is a server error. Wait a few seconds and retry. If it persists, try GET /api/v1/platform/status to check platform health.',
    see: 'GET /api/v1/platform/status',
  });
}
