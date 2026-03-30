import { timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  err403AbuseDenied,
  err403LoopbackOnly,
  err403OperatorSecretRequired,
  err400Validation,
  err413PayloadTooLarge,
  err415JsonRequired,
  err404HiddenRoute,
  err503OperatorMisconfigured,
  getPublicHostRequirement,
} from './agent-friendly-errors.js';
import { logAuthorizationDenied, logValidationFailure } from './audit-log.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/;

export function getSocketAddress(req) {
  return req.socket?.remoteAddress || req.connection?.remoteAddress || '';
}

export function isLoopbackAddress(address) {
  return LOOPBACKS.has(address);
}

export function isLoopbackRequest(req) {
  return isLoopbackAddress(getSocketAddress(req));
}

export function areTestRoutesEnabled() {
  return process.env.NODE_ENV === 'test' || process.env.ENABLE_TEST_ROUTES === '1';
}

export function areOperatorRoutesEnabled() {
  return process.env.ENABLE_OPERATOR_ROUTES === '1';
}

export function hasConfiguredOperatorSecret() {
  return typeof process.env.OPERATOR_API_SECRET === 'string' && process.env.OPERATOR_API_SECRET.trim().length > 0;
}

function safeSecretEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function getBasicAuthPassword(req) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

export function hasValidOperatorSecret(req) {
  if (!hasConfiguredOperatorSecret()) return false;
  const expected = process.env.OPERATOR_API_SECRET.trim();
  const candidates = [req.get('x-operator-secret'), getBasicAuthPassword(req)];
  return candidates.some(candidate => typeof candidate === 'string' && safeSecretEqual(candidate, expected));
}

export function requireJsonWriteContent(req, res, next) {
  if (!WRITE_METHODS.has(req.method) || !req.path.startsWith('/api/v1/')) {
    return next();
  }
  if (req.is('application/json')) return next();

  logValidationFailure(req.path, 'content-type', req.headers['content-type'] || 'missing');
  return err415JsonRequired(res);
}

export function handleJsonBodyError(err, req, res, next) {
  if (!err) return next();

  if (err.type === 'entity.too.large') {
    logValidationFailure(req.path, 'body', 'too_large');
    return err413PayloadTooLarge(res, 'Request body exceeds the 16kb limit.');
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logValidationFailure(req.path, 'body', 'invalid_json');
    return err400Validation(res, 'Malformed JSON body.', {
      hint: 'Send a valid JSON object with double-quoted keys and values.',
    });
  }

  return next(err);
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map(part => parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
  if (parts[0] >= 224) return true;
  return false;
}

function isPrivateIpv6(host) {
  const normalized = host.toLowerCase();
  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('::ffff:127.')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:');
}

function isNonPublicIp(address) {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export function validatePublicNodeHost(host) {
  const publicHostRequirement = getPublicHostRequirement('host');

  if (typeof host !== 'string') {
    return { valid: false, code: 'host_not_string', reason: 'host must be a string' };
  }

  const trimmed = host.trim();
  if (!trimmed) return { valid: false, code: 'host_empty', reason: 'host must not be empty' };
  if (trimmed.length > 500) return { valid: false, code: 'host_too_long', reason: 'host too long (max 500 chars)' };
  if (/[/?#]/.test(trimmed)) return { valid: false, code: 'host_not_host_port', reason: 'host must be host:port only' };

  let hostname = '';
  let portRaw = '';
  const ipv6Match = trimmed.match(/^\[([0-9a-fA-F:]+)\]:(\d{1,5})$/);
  if (ipv6Match) {
    hostname = ipv6Match[1];
    portRaw = ipv6Match[2];
  } else {
    const lastColon = trimmed.lastIndexOf(':');
    if (lastColon <= 0 || trimmed.indexOf(':') !== lastColon) {
      return { valid: false, code: 'host_format', reason: 'host must use host:port format' };
    }
    hostname = trimmed.slice(0, lastColon);
    portRaw = trimmed.slice(lastColon + 1);
  }

  const port = parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { valid: false, code: 'port_range', reason: 'port must be between 1 and 65535' };
  }

  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local')) {
    return { valid: false, code: 'local_host', reason: publicHostRequirement.reason };
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isPrivateIpv4(hostname)) {
    return { valid: false, code: 'private_ipv4', reason: publicHostRequirement.reason };
  }
  if (ipVersion === 6 && isPrivateIpv6(hostname)) {
    return { valid: false, code: 'private_ipv6', reason: publicHostRequirement.reason };
  }
  if (ipVersion === 0 && !HOSTNAME_RE.test(hostname)) {
    return { valid: false, code: 'host_name_format', reason: 'host name format is invalid' };
  }

  return { valid: true, host: trimmed, hostname, port };
}

export async function resolvePublicNodeHost(host, { lookup = dnsLookup } = {}) {
  const base = validatePublicNodeHost(host);
  if (!base.valid) return base;

  if (isIP(base.hostname)) {
    return { ...base, resolvedAddresses: [base.hostname] };
  }

  let answers;
  try {
    answers = await lookup(base.hostname, { all: true, verbatim: true });
  } catch {
    return {
      valid: false,
      code: 'host_resolution_failed',
      reason: 'host must resolve to a public IP address',
    };
  }

  const resolvedAddresses = Array.isArray(answers)
    ? answers
      .map((entry) => entry?.address)
      .filter((entry) => typeof entry === 'string' && entry.length > 0)
    : [];

  if (resolvedAddresses.length === 0) {
    return {
      valid: false,
      code: 'host_resolution_empty',
      reason: 'host must resolve to a public IP address',
    };
  }

  if (resolvedAddresses.some((address) => isNonPublicIp(address))) {
    return {
      valid: false,
      code: 'host_resolution_private',
      reason: 'host must resolve only to public IP addresses',
    };
  }

  return { ...base, resolvedAddresses };
}

export async function pickSafePublicPeerAddress(addresses, { resolveHost = resolvePublicNodeHost } = {}) {
  if (!Array.isArray(addresses)) return null;
  for (const entry of addresses) {
    const candidate = typeof entry === 'string' ? entry : entry?.addr;
    const check = await resolveHost(candidate);
    if (check.valid) return candidate;
  }
  return null;
}

export function rejectUnauthorizedOperatorRoute(req, res) {
  if (!areOperatorRoutesEnabled()) {
    logAuthorizationDenied(req.path, req.agentId || null, null, getSocketAddress(req) || null);
    return err404HiddenRoute(res);
  }
  if (!hasConfiguredOperatorSecret()) {
    logAuthorizationDenied(req.path, req.agentId || null, null, getSocketAddress(req) || null);
    return err503OperatorMisconfigured(res);
  }
  if (!isLoopbackRequest(req)) {
    logAuthorizationDenied(req.path, req.agentId || null, null, getSocketAddress(req) || null);
    return err403LoopbackOnly(res, 'Operator routes', 'Run this on the API host and send the operator secret.');
  }
  if (!hasValidOperatorSecret(req)) {
    logAuthorizationDenied(req.path, req.agentId || null, null, getSocketAddress(req) || null);
    return err403OperatorSecretRequired(res);
  }
  return null;
}

export function requireDashboardOperatorAuth(req, res, next) {
  if (process.env.NODE_ENV !== 'production' && isLoopbackRequest(req)) {
    return next();
  }
  if (!hasConfiguredOperatorSecret()) {
    return res.status(404).send('Not found');
  }
  if (hasValidOperatorSecret(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Agents on Lightning Dashboard"');
  return res.status(401).send('Operator authentication required.');
}

export function rejectUnauthorizedTestRoute(req, res) {
  if (!areTestRoutesEnabled()) {
    logAuthorizationDenied(req.path, req.agentId || null, null, getSocketAddress(req) || null);
    return err404HiddenRoute(res, 'Test routes are disabled in this runtime.');
  }
  if (!isLoopbackRequest(req)) {
    logAuthorizationDenied(req.path, req.agentId || null, null, getSocketAddress(req) || null);
    return err403AbuseDenied(res, {
      message: 'Nice try. Test routes are local-only.',
      hint: 'Run this request on the API host.',
    });
  }
  return null;
}
