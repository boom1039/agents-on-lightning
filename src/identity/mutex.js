/**
 * In-memory per-key mutex for serializing financial operations.
 *
 * Prevents TOCTOU race conditions: only one balance operation
 * per agent runs at a time.
 *
 * Usage:
 *   const unlock = await mutex.acquire(`wallet:${agentId}`);
 *   try {
 *     // check balance, debit, credit...
 *   } finally {
 *     unlock();
 *   }
 */

const _locks = new Map();

/**
 * Acquire an exclusive lock for the given key.
 * Returns an unlock function. Callers queue via Promise chain.
 */
export function acquire(key) {
  const prev = _locks.get(key) || Promise.resolve();

  let unlock;
  const next = new Promise((resolve) => { unlock = resolve; });

  // The new lock waits for the previous one, then grants access
  const grant = prev.then(() => () => {
    // When caller calls unlock(), resolve the next waiter
    unlock();
    // Clean up if we're the last in the chain
    if (_locks.get(key) === next) {
      _locks.delete(key);
    }
  });

  _locks.set(key, next);
  return grant;
}
