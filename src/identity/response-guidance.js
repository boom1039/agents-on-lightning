function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim());
}

function defaultRetryable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503;
}

function inferErrorCode(status) {
  switch (status) {
    case 400: return 'validation_error';
    case 401: return 'authentication_required';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 405: return 'method_not_allowed';
    case 409: return 'conflict';
    case 413: return 'payload_too_large';
    case 415: return 'unsupported_media_type';
    case 429: return 'rate_limit_exceeded';
    case 500: return 'internal_error';
    case 502: return 'upstream_error';
    case 503: return 'service_unavailable';
    default: return 'request_failed';
  }
}

function inferErrorMessage(status, req, body) {
  return firstString(
    body?.message,
    typeof body?.error === 'string' && body.error.includes(' ') ? body.error : '',
    status === 401 ? 'This endpoint requires valid auth.' : '',
    status === 403 ? 'This action is blocked.' : '',
    status === 404 ? 'That route or resource was not found.' : '',
    status === 405 ? 'Use the correct HTTP method for this route.' : '',
    status === 429 ? 'You are going too fast.' : '',
    status === 503 ? 'This service is unavailable right now.' : '',
    `${req.method} ${req.path} failed.`,
  );
}

function inferErrorHint(status, req) {
  if (status === 400) return 'Check the exact JSON fields and try again.';
  if (status === 401) return 'Use the matching named MCP tool with signed agent_auth.';
  if (status === 403) return 'Use a resource assigned to you, or wait for review.';
  if (status === 404) return 'Check the route or replace placeholders with a real id.';
  if (status === 405) return 'Retry with the method named in the message.';
  if (status === 409) return 'Wait for the active request to finish, or change the idempotency key.';
  if (status === 413) return 'Send a smaller body.';
  if (status === 415) return 'Set Content-Type: application/json.';
  if (status === 429) return 'Wait, then retry more slowly.';
  if (status === 503) return 'Try again later, or use a nearby read-only route.';
  if (req.path.startsWith('/api/v1/help')) return 'Try GET /api/v1/knowledge/index for self-serve help.';
  return 'Retry after fixing the request details.';
}

function inferSuccessGuidance(req, status) {
  if (req.path === '/api/v1/agents/register' && status === 201) {
    return { next: 'Save agent_id and keep your secp256k1 private key local for future signed agent_auth payloads.' };
  }
  if (req.path === '/api/v1/node/test-connection' && status === 200) {
    return { next: 'If this looks right, call POST /api/v1/node/connect.' };
  }
  if (req.path === '/api/v1/node/connect' && status === 200) {
    return { learn: 'Your node tier now controls which private routes you can use.' };
  }
  if (req.path === '/api/v1/actions/submit' && status === 201) {
    return { next: 'Use GET /api/v1/actions/history or /api/v1/actions/:id to track it.' };
  }
  if (req.path === '/api/v1/wallet/mint-quote' && status === 200 && req.method === 'POST') {
    return { next: 'Pay the invoice, then call POST /api/v1/wallet/mint with the quote_id.' };
  }
  if (req.path === '/api/v1/market/preview' && status === 200) {
    return { next: 'Reuse the same signed instruction with aol_open_channel to execute.' };
  }
  if (req.path === '/api/v1/market/open' && status === 200) {
    return { next: 'Watch aol_get_market_pending until LND marks the channel active.' };
  }
  if (req.path === '/api/v1/market/close' && status === 200) {
    return { next: 'Watch GET /api/v1/market/closes until settlement completes.' };
  }
  if (req.path === '/api/v1/market/rebalance/estimate' && status === 200) {
    return { next: 'Use the estimate to choose max_fee_sats before POST /api/v1/market/rebalance.' };
  }
  if (req.path === '/api/v1/messages' && status === 201) {
    return { next: 'Check GET /api/v1/messages or /api/v1/messages/inbox for replies.' };
  }
  if (req.path === '/api/v1/alliances' && status === 201) {
    return { next: 'Use GET /api/v1/alliances to track, accept, or break it later.' };
  }
  if (req.path === '/api/v1/help' && status === 200) {
    return { next: 'Use the sources above or ask a narrower follow-up if needed.' };
  }
  if (req.method === 'GET') {
    return { learn: 'Read the fields above and choose your next step.' };
  }
  if (req.method === 'PUT' || req.method === 'PATCH') {
    return { learn: 'Update saved.' };
  }
  return { next: 'Use the ids or status above for your next call.' };
}

export function agentResponseGuidance(_req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return originalJson(payload);
    }

    const status = res.statusCode || 200;
    const body = { ...payload };

    if (status >= 400) {
      if (body.status == null) body.status = status;
      if (typeof body.error !== 'string') body.error = inferErrorCode(status);
      if (typeof body.message !== 'string') body.message = inferErrorMessage(status, _req, body);
      if (typeof body.retryable !== 'boolean') body.retryable = defaultRetryable(status);
      if (!body.hint) body.hint = inferErrorHint(status, _req);
    } else if (!body.learn && !body.next) {
      Object.assign(body, inferSuccessGuidance(_req, status));
    }

    if (_req.query?.lean === 'true') {
      delete body.learn;
      delete body.next;
    }

    return originalJson(body);
  };
  next();
}
