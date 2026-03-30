/**
 * Strict input validation functions for all externally-exposed endpoints.
 * Every function returns { valid: true } or { valid: false, reason: string }.
 */

const PUBKEY_RE = /^[0-9a-f]{66}$/;          // 33-byte compressed pubkey hex
const CHANNEL_ID_RE = /^\d{10,20}$/;          // numeric channel point
const AGENT_ID_RE = /^[0-9a-f]{8}$/;          // 4-byte hex
const NAME_CHARSET_RE = /^[a-zA-Z0-9_\-. ]+$/;
const SECP256K1_PUBKEY_RE = /^(02|03)[0-9a-f]{64}$/i;
const REFERRAL_CODE_RE = /^ref-[0-9a-f]{8}$/;
const GEO_TARGET_RE = /^[a-zA-Z0-9\-]{1,50}$/;
const MESSAGE_TYPES = ['message', 'challenge', 'intel'];
const TIERS = ['observatory', 'wallet', 'read-only', 'readonly', 'invoice', 'admin'];
const BITCOIN_ADDRESS_RE = /^(bc1[ac-hj-np-z02-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
// eslint-disable-next-line no-control-regex
const DISALLOWED_TEXT_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g;

function normalizeTextValue(s, { allowNewlines = true } = {}) {
  let normalized = String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(DISALLOWED_TEXT_CONTROL_RE, '');

  if (!allowNewlines) {
    normalized = normalized.replace(/\n+/g, ' ');
  }

  normalized = normalized
    .split('\n')
    .map(line => line.replace(/ {2,}/g, ' ').trimEnd())
    .join('\n');

  return normalized.trim();
}

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

export function validateSecp256k1Pubkey(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'pubkey must be a string' };
  if (!SECP256K1_PUBKEY_RE.test(s)) {
    return { valid: false, reason: 'Invalid secp256k1 pubkey format (expected compressed 66 hex chars starting with 02 or 03)' };
  }
  return { valid: true };
}

export function validateReferralCode(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'referral_code must be a string' };
  if (!REFERRAL_CODE_RE.test(s)) return { valid: false, reason: 'Invalid referral code format (expected ref-XXXXXXXX)' };
  return { valid: true };
}

export function validateBitcoinAddress(s) {
  if (typeof s !== 'string') return { valid: false, reason: 'Bitcoin address must be a string' };
  const trimmed = s.trim();
  if (!BITCOIN_ADDRESS_RE.test(trimmed)) {
    return { valid: false, reason: 'Invalid Bitcoin address format' };
  }
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

export function validatePlainObject(value, {
  field = 'value',
  allowedKeys = null,
  maxKeys = null,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: `${field} must be a JSON object` };
  }

  const keys = Object.keys(value);
  if (maxKeys !== null && keys.length > maxKeys) {
    return { valid: false, reason: `${field} must contain at most ${maxKeys} keys` };
  }

  if (allowedKeys) {
    const allowed = new Set(allowedKeys);
    const unknown = keys.filter(key => !allowed.has(key));
    if (unknown.length > 0) {
      return { valid: false, reason: `${field} contains unknown fields: ${unknown.join(', ')}` };
    }
  }

  return { valid: true };
}

export function normalizeFreeText(s, {
  field = 'text',
  maxLen = 500,
  maxLines = 8,
  maxLineLen = 200,
  allowNewlines = true,
} = {}) {
  if (typeof s !== 'string') return { valid: false, reason: `${field} must be a string` };

  const raw = s;
  const value = normalizeTextValue(s, { allowNewlines });
  if (value.length === 0) {
    return { valid: false, reason: `${field} must not be empty` };
  }
  if (value.length > maxLen) {
    return { valid: false, reason: `${field} must be ${maxLen} characters or less` };
  }

  const lines = allowNewlines ? value.split('\n') : [value];
  if (lines.length > maxLines) {
    return { valid: false, reason: `${field} must be ${maxLines} lines or less` };
  }
  if (lines.some(line => line.length > maxLineLen)) {
    return { valid: false, reason: `${field} lines must be ${maxLineLen} characters or less` };
  }

  return {
    valid: true,
    value,
    raw,
    changed: value !== raw,
  };
}

/**
 * Strip control characters and truncate for safe logging.
 */
export function sanitizeForLog(s, maxLen = 200) {
  if (typeof s !== 'string') return String(s).slice(0, maxLen);
  return normalizeTextValue(s, { allowNewlines: false }).slice(0, maxLen);
}
