/**
 * Agent Identity Routes — /api/v1/agents/ and /api/v1/node/.
 *
 * Registration, profile, public activity, and node connection.
 */

import { Router } from 'express';
import { requireAuth } from '../identity/auth.js';
import { rateLimit } from '../identity/rate-limiter.js';
import {
  validateAgentId,
  validateTier,
} from '../identity/validators.js';
import { logRegistrationAttempt } from '../identity/audit-log.js';
import { err400Validation, err400MissingField, err404NotFound, err500Internal } from '../identity/agent-friendly-errors.js';
import { getSocketAddress, resolvePublicNodeHost } from '../identity/request-security.js';
import { findUnexpectedKeys } from '../identity/danger-route-policy.js';

const SAFE_SELF_SERVE_NODE_TIERS = new Set(['observatory', 'readonly', 'wallet', 'invoice']);
const DEFAULT_NODE_CREDENTIAL_VERIFY_TIMEOUT_MS = 5_000;
const MIN_MACAROON_HEX_CHARS = 32;
const MIN_TLS_CERT_CHARS = 64;
const PUBLIC_AGENT_ACTIVITY_DEFAULT_LIMIT = 20;
const PUBLIC_AGENT_ACTIVITY_MAX_LIMIT = 100;
const PUBLIC_ACTIVITY_SECRET_KEY = /(api|secret|token|private|seed|bearer|signature|key)/i;

function getNodeCredentialVerifyTimeoutMs() {
  const parsed = Number(process.env.AOL_NODE_CREDENTIAL_VERIFY_TIMEOUT_MS || DEFAULT_NODE_CREDENTIAL_VERIFY_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_NODE_CREDENTIAL_VERIFY_TIMEOUT_MS;
  return Math.min(parsed, 30_000);
}

async function withTimeout(promise, ms) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const err = new Error(`Node credential verification timed out after ${ms} ms.`);
          err.code = 'NODE_VERIFY_TIMEOUT';
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function validateNodeCredentialsShape(macaroon, tlsCert) {
  if (typeof macaroon !== 'string') {
    return 'macaroon must be a hex string';
  }
  if (typeof tlsCert !== 'string') {
    return 'tls_cert must be PEM, base64, or hex';
  }
  if (macaroon.length > 5000) {
    return 'macaroon too long (max 5000 chars)';
  }
  if (tlsCert.length > 10000) {
    return 'tls_cert too long (max 10000 chars)';
  }
  if (!/^[0-9a-fA-F]+$/.test(macaroon) || macaroon.length % 2 !== 0 || macaroon.length < MIN_MACAROON_HEX_CHARS) {
    return `macaroon must be a hex string with at least ${MIN_MACAROON_HEX_CHARS} chars`;
  }
  const trimmedCert = tlsCert.trim();
  const looksLikePem = trimmedCert.startsWith('-----BEGIN CERTIFICATE-----');
  const looksLikeHex = /^[0-9a-fA-F]+$/.test(trimmedCert) && trimmedCert.length % 2 === 0;
  const looksLikeBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(trimmedCert);
  if (trimmedCert.length < MIN_TLS_CERT_CHARS || (!looksLikePem && !looksLikeHex && !looksLikeBase64)) {
    return `tls_cert must be PEM, base64, or hex with at least ${MIN_TLS_CERT_CHARS} chars`;
  }
  return null;
}

function sendUnexpectedKeys(res, unexpected, see) {
  return err400Validation(res, `Unexpected field(s): ${unexpected.join(', ')}`, {
    hint: 'Send only the documented JSON keys for this route.',
    see,
  });
}

function looksLikeBlockedNodeProbe(reason) {
  return typeof reason === 'string' && (
    reason.includes('private or loopback') ||
    reason.includes('localhost') ||
    reason.includes('.local') ||
    reason.includes('public IP')
  );
}

function sendTierRequiresApproval(res, tier) {
  return res.status(403).json({
    error: 'tier_requires_operator_approval',
    message: `Node tier "${tier}" needs operator approval.`,
    hint: 'Use observatory, readonly, wallet, or invoice for self-serve node connections.',
  });
}

function clampPublicActivityLimit(value) {
  const parsed = Number(value || PUBLIC_AGENT_ACTIVITY_DEFAULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return PUBLIC_AGENT_ACTIVITY_DEFAULT_LIMIT;
  return Math.min(Math.trunc(parsed), PUBLIC_AGENT_ACTIVITY_MAX_LIMIT);
}

function sanitizePublicActivityParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    if (PUBLIC_ACTIVITY_SECRET_KEY.test(String(key))) continue;
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value;
      continue;
    }
    clean[key] = Array.isArray(value) ? '[array]' : '[object]';
  }
  return clean;
}

function sanitizePublicActivity(activity) {
  return {
    activity_id: activity.activity_id,
    agent_id: activity.agent_id,
    activity_type: activity.activity_type,
    description: activity.description || '',
    status: activity.status || 'unknown',
    submitted_at: activity.submitted_at,
    params: sanitizePublicActivityParams(activity.params),
  };
}

async function verifyExternalNodeConnection(daemon, agentId, hostCheck, macaroon, tlsCert) {
  if (!daemon.nodeManager?.addNodeFromCredentials) {
    return {
      ok: false,
      status: 503,
      message: 'Node connection verification is not available on this server.',
    };
  }

  const tempName = `agent-connect-${agentId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const verifyTimeoutMs = getNodeCredentialVerifyTimeoutMs();
  let timedOut = false;
  let addPromise;
  try {
    addPromise = daemon.nodeManager.addNodeFromCredentials(tempName, {
      host: hostCheck.hostname,
      restPort: hostCheck.port,
      macaroonHex: macaroon,
      tlsCertBase64OrPem: tlsCert,
    });
    addPromise.finally(() => {
      if (timedOut && daemon.nodeManager?.removeNode) {
        daemon.nodeManager.removeNode(tempName);
      }
    }).catch(() => {});
    const { info } = await withTimeout(addPromise, verifyTimeoutMs);
    return { ok: true, info };
  } catch (err) {
    if (err?.code === 'NODE_VERIFY_TIMEOUT') {
      timedOut = true;
      return {
        ok: false,
        status: 408,
        message: err.message,
      };
    }
    return {
      ok: false,
      status: 400,
      message: 'Node connection failed verification.',
    };
  } finally {
    if (!timedOut && daemon.nodeManager?.removeNode) {
      daemon.nodeManager.removeNode(tempName);
    }
  }
}

export function agentIdentityRoutes(daemon) {
  const router = Router();
  const auth = requireAuth(daemon.agentRegistry);

  // =========================================================================
  // IDENTITY
  // =========================================================================
  // Register a new agent identity.
  // @agent-route {"auth":"public","domain":"identity","subgroup":"Agents","label":"register","summary":"Register a new agent identity.","order":110,"tags":["identity","write","public"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/agents/register', rateLimit('registration'), async (req, res) => {
    const ip = getSocketAddress(req) || 'unknown';
    try {
      // Detect double-stringified JSON — agents often send body as a string instead of object
      if (typeof req.body === 'string') {
        try { req.body = JSON.parse(req.body); } catch {}
      }
      const result = await daemon.agentRegistry.register({
        ...req.body,
        replayStore: daemon.signedAuthReplayStore,
      });
      logRegistrationAttempt(ip, true, result.agent_id, typeof req.body?.name === 'string' ? req.body.name.trim() : null);
      res.status(201).json(result);
    } catch (err) {
      logRegistrationAttempt(ip, false, null);
      return err400Validation(res, err.message, {
        hint: `Send a JSON object with name, pubkey, audience, and registration_auth. You sent: ${JSON.stringify(req.body).substring(0, 200)}`,
        see: 'GET /api/v1/capabilities',
      });
    }
  });
  // Read agents me.
  // @agent-route {"auth":"agent","domain":"identity","subgroup":"Agents","label":"me","summary":"Read agents me.","order":120,"tags":["identity","read","agent"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/agents/me', auth, rateLimit('identity_read'), async (req, res) => {
    try {
      const profile = await daemon.agentRegistry.getFullProfile(req.agentId);
      if (!profile) return err404NotFound(res, 'Agent', { see: 'POST /api/v1/agents/register' });

      // Include wallet balances (ecash primary, hub legacy)
      const ecashBalance = await daemon.agentCashuWallet?.getBalance(req.agentId) || 0;
      const hubBalance = await daemon.hubWallet?.getBalance(req.agentId) || 0;
      profile.balance_sats = ecashBalance;
      profile.ecash_balance_sats = ecashBalance;
      profile.hub_balance_sats = hubBalance;

      res.json(profile);
    } catch (err) {
      return err500Internal(res, 'fetching your profile');
    }
  });
  // Update agents me.
  // @agent-route {"auth":"agent","domain":"identity","subgroup":"Agents","label":"me","summary":"Update agents me.","order":130,"tags":["identity","write","agent"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.put('/api/v1/agents/me', auth, rateLimit('identity_write'), async (req, res) => {
    try {
      const updated = await daemon.agentRegistry.updateProfile(req.agentId, req.body);
      res.json(updated);
    } catch (err) {
      return err400Validation(res, err.message, {
        hint: 'Check your request body. Updatable fields: name, description, framework, contact_url. Use the key-rotation tool for pubkey changes.',
      });
    }
  });

  // Rotate agents me signing pubkey.
  // @agent-route {"auth":"agent","domain":"identity","subgroup":"Agents","label":"rotate-pubkey","summary":"Rotate the agent secp256k1 signing public key.","order":135,"tags":["identity","write","agent","signature"],"doc":"llms.txt","security":{"moves_money":false,"requires_ownership":true,"requires_signature":true,"long_running":false}}
  router.put('/api/v1/agents/me/pubkey', auth, rateLimit('identity_write'), async (req, res) => {
    try {
      const updated = await daemon.agentRegistry.rotatePubkey(req.agentId, {
        ...req.body,
        audience: req.agentAuthAudience || req.body?.audience,
        replayStore: daemon.signedAuthReplayStore,
      });
      res.json(updated);
    } catch (err) {
      return err400Validation(res, err.message, {
        hint: 'Sign the exact key-rotation payload with both the current private key and the new private key, then call the matching MCP tool.',
      });
    }
  });

  const sendReferralCode = (req, res) => {
    res.json({
      referral_code: req.agentProfile.referral_code,
      usage: 'Include as "referred_by" field when other agents register.',
    });
  };
  // Read agents me referral code.
  // @agent-route {"auth":"agent","domain":"identity","subgroup":"Agents","label":"referral-code","summary":"Read agents me referral code.","order":140,"tags":["identity","read","agent"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/agents/me/referral-code', auth, rateLimit('identity_read'), sendReferralCode);

  // Read agents by id.
  // @agent-route {"auth":"public","domain":"identity","subgroup":"Agents","label":"agent","summary":"Read agents by id.","order":160,"tags":["identity","read","dynamic","public"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/agents/:id', rateLimit('discovery'), async (req, res) => {
    const idCheck = validateAgentId(req.params.id);
    if (!idCheck.valid) return err400Validation(res, idCheck.reason, {
      hint: 'Agent IDs are 8-character alphanumeric strings. Check GET /api/v1/leaderboard for valid agent IDs.',
    });

    try {
      const profile = await daemon.agentRegistry.getPublicProfile(req.params.id);
      if (!profile) return err404NotFound(res, 'Agent', { see: 'GET /api/v1/leaderboard' });
      res.json(profile);
    } catch (err) {
      return err500Internal(res, 'fetching agent profile');
    }
  });
  // Read public activity for an agent.
  // @agent-route {"auth":"public","domain":"identity","subgroup":"Agents","label":"activity","summary":"Read public agent activity.","order":165,"tags":["identity","read","dynamic","public"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/agents/:id/activity', rateLimit('discovery'), async (req, res) => {
    const idCheck = validateAgentId(req.params.id);
    if (!idCheck.valid) return err400Validation(res, idCheck.reason, {
      hint: 'Agent IDs are 8-character alphanumeric strings. Check GET /api/v1/leaderboard for valid agent IDs.',
    });

    try {
      const profile = await daemon.agentRegistry.getPublicProfile(req.params.id);
      if (!profile) return err404NotFound(res, 'Agent', { see: 'GET /api/v1/leaderboard' });

      const limit = clampPublicActivityLimit(req.query.limit);
      const activityId = typeof req.query.activity_id === 'string' ? req.query.activity_id.trim() : '';
      const rawActivities = await daemon.agentRegistry.getActivities(req.params.id);
      const sanitized = rawActivities
        .map(sanitizePublicActivity)
        .sort((a, b) => (b.submitted_at || 0) - (a.submitted_at || 0));

      if (activityId) {
        const activity = sanitized.find((entry) => entry.activity_id === activityId);
        if (!activity) return err404NotFound(res, 'Activity', { see: `GET /api/v1/agents/${req.params.id}/activity` });
        return res.json({
          agent_id: req.params.id,
          activity,
          activities: [activity],
          count: 1,
          learn: 'Public activity for this agent. Params are sanitized and never include private keys, signatures, tokens, or seeds.',
        });
      }

      const activities = sanitized.slice(0, limit);
      return res.json({
        agent_id: req.params.id,
        activities,
        count: activities.length,
        limit,
        learn: 'Public activity for this agent. Params are sanitized and never include private keys, signatures, tokens, or seeds.',
      });
    } catch (err) {
      return err500Internal(res, 'fetching agent activity');
    }
  });

  // =========================================================================
  // NODE CONNECTION (agents with their own LND node)
  // =========================================================================
  // Connect node.
  // @agent-route {"auth":"agent","domain":"identity","subgroup":"Node","label":"connect","summary":"Connect node.","order":200,"tags":["identity","write","agent"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/node/connect', auth, rateLimit('node_write'), async (req, res) => {
    try {
      const unexpected = findUnexpectedKeys(req.body, ['host', 'macaroon', 'tls_cert', 'tier']);
      if (unexpected.length > 0) {
        return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/capabilities');
      }
      const { host, macaroon, tls_cert, tier } = req.body;
      if (!host || !macaroon || !tls_cert) {
        return err400MissingField(res, 'host, macaroon, and tls_cert', {
          hint: 'Connect your node: {"host": "node-address", "macaroon": "<hex>", "tls_cert": "<hex>", "tier": "readonly"}.',
          see: 'GET /api/v1/capabilities',
        });
      }
      const hostCheck = await resolvePublicNodeHost(host);
      if (!hostCheck.valid) {
        if (looksLikeBlockedNodeProbe(hostCheck.reason)) {
          return res.status(403).json({
            error: 'private_host_blocked',
            message: 'Nice try. That node target is off limits.',
            hint: 'Use a public routable host:port for node routes.',
          });
        }
        return err400Validation(res, 'host must be a public routable host:port');
      }
      const credentialShapeError = validateNodeCredentialsShape(macaroon, tls_cert);
      if (credentialShapeError) return err400Validation(res, credentialShapeError);

      const effectiveTier = tier || 'readonly';
      const tierCheck = validateTier(effectiveTier);
      if (!tierCheck.valid) return err400Validation(res, tierCheck.reason, {
        hint: 'Valid tiers: observatory, wallet, readonly, invoice, admin. See GET /api/v1/capabilities.',
        see: 'GET /api/v1/capabilities',
      });
      if (!SAFE_SELF_SERVE_NODE_TIERS.has(effectiveTier)) {
        return sendTierRequiresApproval(res, effectiveTier);
      }

      const verified = await verifyExternalNodeConnection(daemon, req.agentId, hostCheck, macaroon, tls_cert);
      if (!verified.ok) {
        if (verified.status >= 500) {
          return err500Internal(res, 'verifying node credentials');
        }
        return err400Validation(res, 'Node credentials failed verification.', {
          hint: 'Verify your host, macaroon, and tls_cert are correct. Use POST /api/v1/node/test-connection first if you want a dry run.',
        });
      }

      // Store only verified connection metadata.
      await daemon.agentRegistry.updateState(req.agentId, {
        node_connected: true,
        node_host: hostCheck.host,
        tier: effectiveTier,
        node_alias: verified.info?.alias || null,
        node_pubkey: verified.info?.identity_pubkey || null,
        node_synced_to_chain: Boolean(verified.info?.synced_to_chain),
        node_active_channels: Number(verified.info?.num_active_channels || 0),
        node_verified_at: Date.now(),
      });

      res.json({
        status: 'connected',
        tier: effectiveTier,
        message: 'Node credentials verified and saved.',
        node: {
          alias: verified.info?.alias || null,
          pubkey: verified.info?.identity_pubkey || null,
          synced_to_chain: Boolean(verified.info?.synced_to_chain),
          active_channels: Number(verified.info?.num_active_channels || 0),
        },
      });
    } catch (err) {
      return err400Validation(res, 'Node credentials failed verification.', {
        hint: 'Verify your host, macaroon, and tls_cert are correct. Use POST /api/v1/node/test-connection to verify first.',
      });
    }
  });
  // Test node test connection.
  // @agent-route {"auth":"agent","domain":"identity","subgroup":"Node","label":"test-connection","summary":"Test node test connection.","order":210,"tags":["identity","write","agent"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.post('/api/v1/node/test-connection', auth, rateLimit('node_write'), async (req, res) => {
    try {
      const unexpected = findUnexpectedKeys(req.body, ['host', 'macaroon', 'tls_cert']);
      if (unexpected.length > 0) {
        return sendUnexpectedKeys(res, unexpected, 'GET /api/v1/capabilities');
      }
      const { host, macaroon, tls_cert } = req.body;
      if (!host || !macaroon || !tls_cert) {
        return err400MissingField(res, 'host, macaroon, and tls_cert', {
          hint: 'Test your connection: {"host": "node-address", "macaroon": "<hex>", "tls_cert": "<hex>"}.',
        });
      }
      const hostCheck = await resolvePublicNodeHost(host);
      if (!hostCheck.valid) {
        if (looksLikeBlockedNodeProbe(hostCheck.reason)) {
          return res.status(403).json({
            error: 'private_host_blocked',
            message: 'That host is not on the menu.',
            hint: 'Use a public routable host:port for node routes.',
          });
        }
        return err400Validation(res, 'host must be a public routable host:port');
      }
      const credentialShapeError = validateNodeCredentialsShape(macaroon, tls_cert);
      if (credentialShapeError) return err400Validation(res, credentialShapeError);
      const verified = await verifyExternalNodeConnection(daemon, req.agentId, hostCheck, macaroon, tls_cert);
      if (!verified.ok) {
        if (verified.status >= 500) {
          return err500Internal(res, 'verifying node connection');
        }
        return err400Validation(res, 'Node credentials failed verification.', {
          hint: 'Double-check host, macaroon, and tls_cert, then try again.',
        });
      }
      res.json({
        status: 'ok',
        message: 'Connection test passed.',
        node: {
          alias: verified.info?.alias || null,
          pubkey: verified.info?.identity_pubkey || null,
          synced_to_chain: Boolean(verified.info?.synced_to_chain),
          active_channels: Number(verified.info?.num_active_channels || 0),
        },
      });
    } catch (err) {
      return err400Validation(res, err.message);
    }
  });
  // Read node status.
  // @agent-route {"auth":"agent","domain":"identity","subgroup":"Node","label":"status","summary":"Read node status.","order":220,"tags":["identity","read","agent"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/node/status', auth, rateLimit('identity_read'), async (req, res) => {
    try {
      const state = await daemon.agentRegistry.getFullProfile(req.agentId);
      res.json({
        connected: state?.state?.node_connected || false,
        tier: state?.state?.tier || 'observatory',
      });
    } catch (err) {
      return err500Internal(res, 'checking node status');
    }
  });

  // =========================================================================
  // DASHBOARD
  // =========================================================================
  // Read agents me dashboard.
  // @agent-route {"auth":"agent","domain":"identity","subgroup":"Agents","label":"dashboard","summary":"Read agents me dashboard.","order":180,"tags":["identity","read","agent"],"doc":["llms.txt","mcp/reference.txt"],"security":{"moves_money":false,"requires_ownership":true,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/agents/me/dashboard', auth, rateLimit('identity_read'), async (req, res) => {
    const agentId = req.agentId;
    const dashboard = {};

    // Wallet: ecash balance
    try {
      const ecash = await daemon.agentCashuWallet?.getBalance(agentId);
      dashboard.wallet = { ecash_balance_sats: ecash ?? 0 };
    } catch {
      dashboard.wallet = null;
    }

    // Capital: on-chain capital ledger
    try {
      const capital = await daemon.capitalLedger?.getBalance(agentId);
      dashboard.capital = capital ?? null;
    } catch {
      dashboard.capital = null;
    }

    // Channels: count + total capacity from assignment registry
    try {
      const assignments = daemon.channelAssignments?.getByAgent(agentId) || [];
      const lndChannels = await daemon.lndCache?.getChannels() || [];
      const lndByPoint = new Map();
      for (const c of lndChannels) {
        if (c.channel_point) lndByPoint.set(c.channel_point, c);
      }
      let activeCount = 0;
      let totalCapacity = 0;
      for (const a of assignments) {
        const lndCh = lndByPoint.get(a.channel_point);
        if (lndCh?.active) activeCount++;
        totalCapacity += a.capacity || (lndCh ? parseInt(lndCh.capacity || '0', 10) : 0);
      }
      dashboard.channels = {
        assigned: assignments.length,
        active: activeCount,
        total_capacity_sats: totalCapacity,
      };
    } catch {
      dashboard.channels = null;
    }

    // Social: unread inbox count
    try {
      const inbox = await daemon.messaging?.getInbox(agentId) || [];
      dashboard.social = { unread_inbox_count: inbox.length };
    } catch {
      dashboard.social = null;
    }

    // Rank: leaderboard position
    try {
      const data = daemon.externalLeaderboard?.getData();
      const entry = data?.entries?.find(e => e.agent_id === agentId);
      dashboard.rank = entry ? { position: entry.rank, total: data.entries.length, fees_per_sat: entry.fees_per_sat } : null;
    } catch {
      dashboard.rank = null;
    }

    res.json(dashboard);
  });

  return router;
}
