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
 *   - see: URL/endpoint with more info
 *   - available: list of valid options (404s)
 */

const MAX_MESSAGE_CHARS = 160;
const MAX_HINT_CHARS = 180;
const MAX_NEXT_STEP_CHARS = 140;

function compactText(value, maxChars) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function setCompactText(target, key, value, maxChars) {
  const compact = compactText(value, maxChars);
  if (compact) target[key] = compact;
}

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
 * @param {string} [opts.see] - Endpoint or URL with more info
 * @param {string[]} [opts.available] - Valid options (for 404s)
 * @param {object} [opts.extra] - Any additional fields to merge
 */
export function agentError(res, status, opts) {
  const body = {
    status,
    error: opts.error,
    message: compactText(opts.message, MAX_MESSAGE_CHARS) || 'Request failed.',
    retryable: opts.retryable ?? false,
  };

  setCompactText(body, 'hint', opts.hint, MAX_HINT_CHARS);
  setCompactText(body, 'see', opts.see, MAX_HINT_CHARS);
  if (opts.available) body.available = opts.available;
  if (opts.extra) Object.assign(body, opts.extra);

  return res.status(status).json(body);
}

export function tinySuccessGuidance({ message, hint, nextStep } = {}) {
  const guidance = {};
  setCompactText(guidance, 'message', message, MAX_MESSAGE_CHARS);
  setCompactText(guidance, 'hint', hint, MAX_HINT_CHARS);
  setCompactText(guidance, 'next_step', nextStep, MAX_NEXT_STEP_CHARS);
  return guidance;
}

export function agentSuccess(res, status = 200, payload = {}, guidance = {}) {
  const body = { ...payload };
  const tinyGuidance = tinySuccessGuidance(guidance);
  for (const [key, value] of Object.entries(tinyGuidance)) {
    if (body[key] == null) body[key] = value;
  }
  return res.status(status).json(body);
}

// --- Pre-built errors for common cases ---

export function err401NoAuth(res) {
  return agentError(res, 401, {
    error: 'signed_agent_auth_required',
    message: 'This endpoint requires a signed MCP agent assertion.',
    hint: 'Use the matching named MCP tool with agent_auth. Private API routes are internal implementation details behind MCP tools.',
    see: '/llms.txt',
  });
}

export function err401BadFormat(res) {
  return agentError(res, 401, {
    error: 'invalid_signed_agent_auth',
    message: 'The signed MCP agent assertion is missing or malformed.',
    hint: 'Build the exact payload with aol_build_tool_auth_payload, sign it locally with the registered secp256k1 key, then retry through the named MCP tool.',
    see: '/llms.txt',
  });
}

export function err401BadKey(res, { hint, see } = {}) {
  return agentError(res, 401, {
    error: 'invalid_signed_agent_identity',
    message: 'The signed agent identity was not recognized.',
    hint: hint || 'Register first with a secp256k1 public key, then sign private MCP tool calls with that key.',
    see: see || '/llms.txt',
  });
}

export function err429(res, { category, retryAfter }) {
  return agentError(res, 429, {
    error: 'rate_limit_exceeded',
    message: `Rate limit exceeded${category ? ` for ${category}` : ''}. Wait and retry.`,
    retryable: true,
    hint: 'Wait a bit, then retry. If rate-limited again, wait longer.',
  });
}

export function err503Service(res, serviceName) {
  return agentError(res, 503, {
    error: 'service_unavailable',
    message: `${serviceName} is temporarily unavailable.`,
    retryable: true,
    hint: 'This is usually temporary. Wait a bit and try again. If it persists, the platform may be restarting.',
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

export function err413PayloadTooLarge(res, message = 'Request body too large.') {
  return agentError(res, 413, {
    error: 'payload_too_large',
    message,
    hint: 'Reduce the request body size and retry.',
  });
}

export function err415JsonRequired(res) {
  return agentError(res, 415, {
    error: 'unsupported_media_type',
    message: 'This write endpoint only accepts application/json.',
    hint: 'Set Content-Type: application/json and send a valid JSON object.',
  });
}

export function err404HiddenRoute(res, hint = 'This route is not available in this runtime.') {
  return agentError(res, 404, {
    error: 'not_found',
    message: 'Endpoint not found.',
    hint,
  });
}

export function err403AbuseDenied(
  res,
  {
    message = 'Nice try. That request is out of bounds.',
    hint = 'Use documented routes and public targets only.',
  } = {},
) {
  return agentError(res, 403, {
    error: 'forbidden',
    message,
    hint,
  });
}

export function err403LoopbackOnly(res, subject = 'This route', hint) {
  const verb = subject.endsWith('s') ? 'are' : 'is';
  return err403AbuseDenied(res, {
    message: `Nice try. ${subject} ${verb} local-only.`,
    hint: hint || 'Run this request on the API host.',
  });
}

export function err403OperatorSecretRequired(res) {
  return err403AbuseDenied(res, {
    message: 'Nice try. Operator secret required.',
    hint: 'Send the configured x-operator-secret header from a trusted operator client.',
  });
}

export function err503OperatorMisconfigured(res) {
  return agentError(res, 503, {
    error: 'operator_misconfigured',
    message: 'Operator route unavailable.',
    hint: 'Configure the operator secret, then retry from a trusted operator client.',
  });
}

export function getPublicHostRequirement(field = 'host') {
  const safeField = compactText(field, 40) || 'host';
  return {
    code: 'public_host_required',
    message: `${safeField} must be public host:port.`,
    reason: `${safeField} must be public host:port. Private, loopback, and .local targets are off-limits.`,
    hint: `Use a public ${safeField} reachable from outside this machine.`,
  };
}

export function err500Internal(res, context) {
  return agentError(res, 500, {
    error: 'internal_error',
    message: `Something went wrong${context ? ` while ${context}` : ''}.`,
    retryable: true,
    hint: 'This is a server error. Wait a few seconds and retry. If it persists, try GET /api/v1/platform/status to check platform health.',
    see: 'GET /api/v1/platform/status',
  });
}

// --- Recovery guidance for financial operations ---

const MAX_RECOVERY_MESSAGE_CHARS = 160;
const MAX_RECOVERY_STEP_CHARS = 140;

/**
 * Build a recovery guidance block for financial error responses.
 *
 * @param {'safe'|'pending'|'action_needed'} fundsStatus
 * @param {string} message - Plain English explanation of fund safety
 * @param {string[]} nextSteps - Actionable instructions
 * @returns {{ funds_status: string, message: string, next_steps: string[] }}
 */
export function buildRecovery(fundsStatus, message, nextSteps) {
  const recovery = { funds_status: fundsStatus };
  const compactMsg = compactText(message, MAX_RECOVERY_MESSAGE_CHARS);
  if (compactMsg) recovery.message = compactMsg;
  if (Array.isArray(nextSteps) && nextSteps.length > 0) {
    recovery.next_steps = nextSteps
      .map((s) => compactText(s, MAX_RECOVERY_STEP_CHARS))
      .filter(Boolean);
  }
  return recovery;
}

/**
 * Merge a recovery block into an existing error response body object.
 *
 * @param {object} body - The error response body (mutated in place)
 * @param {'safe'|'pending'|'action_needed'} fundsStatus
 * @param {string} message
 * @param {string[]} nextSteps
 * @returns {object} body with recovery field added
 */
export function withRecovery(body, fundsStatus, message, nextSteps) {
  body.recovery = buildRecovery(fundsStatus, message, nextSteps);
  return body;
}
