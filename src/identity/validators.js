/**
 * Strict input validation functions for all externally-exposed endpoints.
 * Every function returns { valid: true } or { valid: false, reason: string }.
 */

const PUBKEY_RE = /^[0-9a-f]{66}$/;          // 33-byte compressed pubkey hex
const CHANNEL_ID_RE = /^\d{10,20}$/;          // numeric channel point
const AGENT_ID_RE = /^[0-9a-f]{8}$/;          // 4-byte hex
const NAME_CHARSET_RE = /^[a-zA-Z0-9_\-. ]+$/;
const ED25519_PUBKEY_RE = /^[0-9a-f]{64}$/;   // Ed25519 hex
const REFERRAL_CODE_RE = /^ref-[0-9a-f]{8}$/;
const GEO_TARGET_RE = /^[a-zA-Z0-9\-]{1,50}$/;
const MESSAGE_TYPES = ['message', 'challenge', 'intel'];
const TIERS = ['observatory', 'wallet', 'read-only', 'readonly', 'invoice', 'admin'];

export function validatePubkey(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'pubkey must be a string' };
  if (!PUBKEY_RE.test(s)) return { valid: false, reason: 'Invalid pubkey format (expected 66 hex chars)' };
  return { valid: true };
}

export function validateChannelId(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'channel_id must be a string' };
  if (!CHANNEL_ID_RE.test(s)) return { valid: false, reason: 'Invalid channel_id format (expected 10-20 digits)' };
  return { valid: true };
}

export function validateChannelIdOrPoint(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'channel ID must be a string' };
  if (!CHANNEL_ID_RE.test(s) && !/^[a-f0-9]{64}:\d+$/.test(s)) {
    return { valid: false, reason: 'Invalid channel ID format (expected uint64 chan_id or txid:vout)' };
  }
  return { valid: true };
}

export function validateAgentId(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'agent_id must be a string' };
  if (!AGENT_ID_RE.test(s)) return { valid: false, reason: 'Invalid agent_id format (expected 8 hex chars)' };
  return { valid: true };
}

export function validateAmount(n, min = 1, max = 10_000_000) {
  if (typeof n !== 'number' || !Number.isInteger(n)) return { valid: false, reason: 'Amount must be an integer' };
  if (n < min) return { valid: false, reason: `Amount must be at least ${min}` };
  if (n > max) return { valid: false, reason: `Amount must be at most ${max}` };
  return { valid: true };
}

export function validateString(s, maxLen = 500) {
  if (typeof s !== 'string') return { valid: false, reason: 'Expected a string' };
  const trimmed = s.trim();
  if (trimmed.length === 0) return { valid: false, reason: 'String must not be empty' };
  if (trimmed.length > maxLen) return { valid: false, reason: `String must be ${maxLen} characters or less` };
  return { valid: true };
}

export function validateName(s, maxLen = 100) {
  const strCheck = validateString(s, maxLen);
  if (!strCheck.valid) return strCheck;
  if (!NAME_CHARSET_RE.test(s.trim())) {
    return { valid: false, reason: 'Name may only contain letters, numbers, underscores, hyphens, periods, and spaces' };
  }
  return { valid: true };
}

export function validateUrl(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'URL must be a string' };
  if (s.length > 500) return { valid: false, reason: 'URL must be 500 characters or less' };
  if (!s.startsWith('https://')) return { valid: false, reason: 'URL must start with https://' };
  return { valid: true };
}

export function validateEd25519Pubkey(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'pubkey must be a string' };
  if (!ED25519_PUBKEY_RE.test(s)) return { valid: false, reason: 'Invalid Ed25519 pubkey format (expected 64 hex chars)' };
  return { valid: true };
}

export function validateReferralCode(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'referral_code must be a string' };
  if (!REFERRAL_CODE_RE.test(s)) return { valid: false, reason: 'Invalid referral code format (expected ref-XXXXXXXX)' };
  return { valid: true };
}

export function validateTier(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'tier must be a string' };
  if (!TIERS.includes(s)) return { valid: false, reason: `Invalid tier. Must be one of: ${TIERS.join(', ')}` };
  return { valid: true };
}

export function validateGeographicTarget(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'target must be a string' };
  if (!GEO_TARGET_RE.test(s)) return { valid: false, reason: 'Invalid geographic target (alphanumeric + hyphens, max 50 chars)' };
  return { valid: true };
}

export function validateMessageType(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'type must be a string' };
  if (!MESSAGE_TYPES.includes(s)) return { valid: false, reason: `Invalid message type. Must be one of: ${MESSAGE_TYPES.join(', ')}` };
  return { valid: true };
}

/**
 * Strip control characters and truncate for safe logging.
 */
export function sanitizeForLog(s, maxLen = 200) {
  if (typeof s !== 'string') return String(s).slice(0, maxLen);
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLen);
}
