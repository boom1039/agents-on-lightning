import { agentError } from './agent-friendly-errors.js';

export function getIdempotencyKey(req) {
  const headerKey = req.get('Idempotency-Key') || req.get('X-Idempotency-Key');
  if (headerKey && typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
  const bodyKey = req.body?.idempotency_key;
  if (typeof bodyKey === 'string' && bodyKey.trim()) return bodyKey.trim();
  return null;
}

export async function runIdempotentRoute({ req, res, store, scope, handler, onError }) {
  const execute = async () => {
    try {
      return await handler();
    } catch (err) {
      if (typeof onError !== 'function') throw err;
      return onError(err);
    }
  };

  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey || !store) {
    const result = await execute();
    return res.status(result.statusCode).json(result.body);
  }

  const begin = await store.begin(scope, req.agentId, idempotencyKey);
  if (!begin.started) {
    const existing = begin.entry;
    if (existing.status === 'complete' && existing.response) {
      return res.status(existing.response.statusCode).json(existing.response.body);
    }
    return agentError(res, 409, {
      error: 'request_in_progress',
      message: 'A request with this idempotency key is already being processed.',
      hint: 'Retry with the same idempotency key later to get the original result.',
    });
  }

  const result = await execute();
  await store.finish(scope, req.agentId, idempotencyKey, result);
  return res.status(result.statusCode).json(result.body);
}
