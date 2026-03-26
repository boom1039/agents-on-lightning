import { createHash } from 'node:crypto';

/**
 * SHA-256 hash of a UTF-8 string, returned as hex.
 */
export function sha256(data) {
  return createHash('sha256').update(data, 'utf-8').digest('hex');
}

/**
 * RFC 8785 compatible canonical JSON serialization.
 * Keys sorted lexicographically at every level, no whitespace.
 * For our use case (string/number/boolean/null/object/array values),
 * a recursive key-sorted JSON.stringify is sufficient and RFC 8785 compliant.
 */
export function canonicalJSON(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) return 'null';
    // ECMAScript number formatting: no trailing zeros, no leading +
    return JSON.stringify(obj);
  }
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(v => canonicalJSON(v)).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
    const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k]));
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(obj);
}
