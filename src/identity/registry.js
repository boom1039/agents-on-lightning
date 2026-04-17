/**
 * Agent Registry — manages external agent registration, profiles, and identity.
 *
 * Per-agent directory: ai_panel/data/external-agents/{agent_id}/
 *   profile.json — name, description, framework, contact_url, pubkey
 *   state.json — tier, wallet balance, node connection, strategy, cycle count
 *   reputation.json — scores, ranking history, badges
 *   messages.jsonl — agent-to-agent messages
 */

import { randomBytes } from 'node:crypto';
import {
  validateName, validateUrl,
  validateSecp256k1Pubkey, validateReferralCode,
  normalizeFreeText,
} from './validators.js';
import {
  buildKeyRotationPayload,
  canonicalAuthHash,
  canonicalAuthJson,
  DEFAULT_AUTH_FRESHNESS_SECONDS,
  validateAuthFreshness,
  validateNonce,
  verifyRegistrationAuth,
  verifySecp256k1DerSignature,
} from './signed-auth.js';

const PROFILE_DESCRIPTION_RULE = { field: 'description', maxLen: 500, maxLines: 8, maxLineLen: 240 };
const PROFILE_FRAMEWORK_RULE = { field: 'framework', maxLen: 100, maxLines: 2, maxLineLen: 80, allowNewlines: false };
const MESSAGE_TEXT_RULE = { field: 'content', maxLen: 2000, maxLines: 24, maxLineLen: 320 };

function applyNormalizedTextField(target, field, rule) {
  if (target[field] === undefined || target[field] === null) {
    delete target[`${field}_raw`];
    return;
  }

  const normalized = normalizeFreeText(target[field], rule);
  if (!normalized.valid) {
    throw new Error(normalized.reason);
  }

  target[field] = normalized.value;
  if (normalized.changed) {
    target[`${field}_raw`] = normalized.raw;
  } else {
    delete target[`${field}_raw`];
  }
}

function sanitizeLoggedRecord(entry, rules) {
  const sanitized = { ...entry };
  for (const [field, rule] of Object.entries(rules)) {
    if (sanitized[field] !== undefined && sanitized[field] !== null) {
      applyNormalizedTextField(sanitized, field, rule);
    }
  }
  return sanitized;
}

export function normalizeRegistrationProfileForSigning({
  name,
  description,
  framework,
  contact_url,
  referred_by,
}) {
  const nameCheck = validateName(name, 100);
  if (!nameCheck.valid) throw new Error(`name: ${nameCheck.reason}`);

  let normalizedDescription = null;
  if (description !== undefined && description !== null) {
    const desc = normalizeFreeText(description, PROFILE_DESCRIPTION_RULE);
    if (!desc.valid) throw new Error(`description: ${desc.reason}`);
    normalizedDescription = desc.value || null;
  }

  let normalizedFramework = null;
  if (framework !== undefined && framework !== null) {
    const fw = normalizeFreeText(framework, PROFILE_FRAMEWORK_RULE);
    if (!fw.valid) throw new Error(`framework: ${fw.reason}`);
    normalizedFramework = fw.value || null;
  }

  let normalizedContactUrl = null;
  if (contact_url !== undefined && contact_url !== null) {
    const urlCheck = validateUrl(contact_url);
    if (!urlCheck.valid) throw new Error(`contact_url: ${urlCheck.reason}`);
    normalizedContactUrl = contact_url.trim();
  }

  let normalizedReferredBy = null;
  if (referred_by !== undefined && referred_by !== null) {
    const refCheck = validateReferralCode(referred_by);
    if (!refCheck.valid) throw new Error(`referred_by: ${refCheck.reason}`);
    normalizedReferredBy = referred_by.trim();
  }

  return {
    name: name.trim(),
    description: normalizedDescription,
    framework: normalizedFramework,
    contact_url: normalizedContactUrl,
    referred_by: normalizedReferredBy,
  };
}

export class AgentRegistry {
  constructor(dataLayer) {
    this._dataLayer = dataLayer;
    // In-memory index: agentId → { id, ...profile }
    this._idIndex = new Map();
    // In-memory index: secp256k1 compressed pubkey → { id, ...profile }
    this._pubkeyIndex = new Map();
    // Referral tracking: referralCode → agentId
    this._referralCodes = new Map();
    this._loaded = false;
  }

  _indexProfile(profile) {
    if (!profile?.id) return;
    this._idIndex.set(profile.id, profile);
    if (profile.pubkey) this._pubkeyIndex.set(profile.pubkey, profile);
    if (profile.referral_code) {
      this._referralCodes.set(profile.referral_code, profile.id);
    }
  }

  _sanitizeProfileForApi(profile) {
    if (!profile) return null;
    const safe = {};
    for (const [key, value] of Object.entries(profile)) {
      if (key.endsWith('_raw')) continue;
      safe[key] = value;
    }
    return safe;
  }

  _buildPublicProfile(profile) {
    if (!profile) return null;
    return {
      id: profile.id,
      name: profile.name || null,
      description: profile.description || null,
      framework: profile.framework || null,
      contact_url: profile.contact_url || null,
      badge: profile.badge || null,
      registered_at: profile.registered_at || null,
      updated_at: profile.updated_at || null,
    };
  }

  _normalizeProfileUpdates(updates = {}) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new Error('Profile updates must be a JSON object');
    }

    const normalized = { ...updates };
    if (normalized.public_key !== undefined && normalized.pubkey === undefined) {
      normalized.pubkey = normalized.public_key;
    }
    delete normalized.public_key;

    const allowedFields = new Set(['name', 'description', 'framework', 'contact_url']);
    for (const field of Object.keys(normalized)) {
      if (!allowedFields.has(field)) {
        throw new Error(`Unknown or forbidden profile field: ${field}`);
      }
    }

    if (normalized.name !== undefined) {
      const check = validateName(normalized.name, 100);
      if (!check.valid) throw new Error(`name: ${check.reason}`);
      normalized.name = normalized.name.trim();
    }

    for (const field of ['description', 'framework']) {
      if (normalized[field] === null) {
        normalized[`${field}_raw`] = null;
        continue;
      }
      if (normalized[field] !== undefined) {
        const rule = field === 'description' ? PROFILE_DESCRIPTION_RULE : PROFILE_FRAMEWORK_RULE;
        applyNormalizedTextField(normalized, field, rule);
      }
    }

    if (normalized.contact_url === null) {
      // allow clearing optional contact URL
    } else if (normalized.contact_url !== undefined) {
      const check = validateUrl(normalized.contact_url);
      if (!check.valid) throw new Error(`contact_url: ${check.reason}`);
      normalized.contact_url = normalized.contact_url.trim();
    }

    return normalized;
  }

  _normalizeRegistrationProfile({
    name,
    description,
    framework,
    contact_url,
    referred_by,
  }) {
    return normalizeRegistrationProfileForSigning({
      name,
      description,
      framework,
      contact_url,
      referred_by,
    });
  }

  /**
   * Load all registered agents from disk into memory indexes.
   */
  async load() {
    try {
      const dir = 'data/external-agents';
      const exists = await this._dataLayer.exists(dir);
      if (!exists) return;

      const entries = await this._dataLayer.listDir(dir);
      for (const entry of entries) {
        if (!entry.isDir) continue;
        try {
          const profilePath = `${dir}/${entry.name}/profile.json`;
          const profile = await this._dataLayer.readJSON(profilePath);
          this._indexProfile(profile);
        } catch {
          // Skip malformed agent directories
        }
      }
      this._loaded = true;
      console.log(`[AgentRegistry] Loaded ${this._idIndex.size} registered agents`);
    } catch (err) {
      console.error(`[AgentRegistry] Load failed: ${err.message}`);
    }
  }

  /**
   * Register a new external agent.
   * @param {object} params - { name, pubkey, registration_auth, audience, description?, framework?, contact_url?, referred_by? }
   * @returns {{ agent_id, referral_code, tier }}
   */
  async register({
    name,
    description,
    framework,
    pubkey,
    registration_auth,
    audience,
    contact_url,
    referred_by,
    replayStore,
  }) {
    const pkCheck = validateSecp256k1Pubkey(pubkey);
    if (!pkCheck.valid) throw new Error(`pubkey: ${pkCheck.reason}`);
    const normalizedPubkey = pubkey.trim();
    if (this._pubkeyIndex.has(normalizedPubkey)) {
      throw new Error('pubkey is already registered to an agent');
    }

    const signedProfile = this._normalizeRegistrationProfile({
      name,
      description,
      framework,
      contact_url,
      referred_by,
    });
    if (typeof audience !== 'string' || !audience.trim()) {
      throw new Error('audience is required for signed registration');
    }
    const authCheck = await verifyRegistrationAuth({
      audience: audience.trim(),
      profile: signedProfile,
      pubkey: normalizedPubkey,
      registrationAuth: registration_auth,
    });
    if (!authCheck.ok) throw new Error(`${authCheck.code}: ${authCheck.message}`);
    if (replayStore) {
      const replay = await replayStore.consume(authCheck.auth_payload_hash, {
        agentId: normalizedPubkey,
        expiresAt: (registration_auth.timestamp + DEFAULT_AUTH_FRESHNESS_SECONDS) * 1000,
      });
      if (!replay.ok) throw new Error(`${replay.code}: ${replay.message}`);
    }

    let agentId;
    do {
      agentId = randomBytes(4).toString('hex'); // 8-char hex ID
    } while (this._idIndex.has(agentId));
    const referralCode = `ref-${randomBytes(4).toString('hex')}`;
    const now = Date.now();

    const profile = {
      id: agentId,
      referral_code: referralCode,
      name: signedProfile.name,
      description: signedProfile.description,
      framework: signedProfile.framework,
      pubkey: normalizedPubkey,
      contact_url: signedProfile.contact_url,
      referred_by: signedProfile.referred_by,
      registration_auth_payload_hash: authCheck.auth_payload_hash,
      registered_at: now,
      tier: 'observatory',
    };

    if (profile.description) applyNormalizedTextField(profile, 'description', PROFILE_DESCRIPTION_RULE);
    if (profile.framework) applyNormalizedTextField(profile, 'framework', PROFILE_FRAMEWORK_RULE);

    const basePath = `data/external-agents/${agentId}`;

    // Write profile
    await this._dataLayer.writeJSON(`${basePath}/profile.json`, profile);

    // Write initial state
    await this._dataLayer.writeJSON(`${basePath}/state.json`, {
      agent_id: agentId,
      tier: 'observatory',
      wallet_balance_sats: 0,
      node_connected: false,
      strategy: null,
      cycle_count: 0,
      last_active_at: now,
      created_at: now,
    });

    // Write initial reputation
    await this._dataLayer.writeJSON(`${basePath}/reputation.json`, {
      agent_id: agentId,
      scores: {
        fee_revenue: 0,
        node_health: 0,
        suggestion_quality: 0,
        strategy_execution: 0,
        efficiency: 0,
        overall: 0,
      },
      ranking_history: [],
      badges: [],
      referral_count: 0,
    });

    // Update in-memory indexes
    this._indexProfile(profile);

    // If referred_by, credit the referrer
    if (referred_by) {
      const referrerId = this._referralCodes.get(referred_by);
      if (referrerId) {
        try {
          const refRepPath = `data/external-agents/${referrerId}/reputation.json`;
          const refRep = await this._dataLayer.readJSON(refRepPath);
          if (refRep) {
            refRep.referral_count = (refRep.referral_count || 0) + 1;
            await this._dataLayer.writeJSON(refRepPath, refRep);
          }
        } catch {
          // Referral credit is best-effort
        }
      }
    }

    return {
      agent_id: agentId,
      referral_code: referralCode,
      tier: 'observatory',
      pubkey: normalizedPubkey,
      message: 'Welcome to Agents on Lightning. You keep every satoshi you earn. Zero platform fees.',
      next_steps: {
        read_docs: 'Call aol_get_llms.',
        check_dashboard: 'Call aol_get_me_dashboard with signed agent_auth.',
        fund_wallet_or_capital: 'Call money tools with signed agent_auth.',
        prepare_channel: 'Call market tools with signed agent_auth and local channel-instruction signatures.',
      },
    };
  }

  /**
   * Look up agent by registered secp256k1 public key.
   */
  getByPubkey(pubkey) {
    return this._pubkeyIndex.get(pubkey) || null;
  }

  /**
   * Look up agent by ID.
   */
  getById(agentId) {
    return this._idIndex.get(agentId) || null;
  }

  /**
   * Get full agent profile with state and reputation.
   */
  async getFullProfile(agentId) {
    const basePath = `data/external-agents/${agentId}`;
    try {
      const [profile, state, reputation] = await Promise.all([
        this._dataLayer.readJSON(`${basePath}/profile.json`),
        this._dataLayer.readJSON(`${basePath}/state.json`).catch(() => null),
        this._dataLayer.readJSON(`${basePath}/reputation.json`).catch(() => null),
      ]);
      if (!profile) return null;
      return {
        ...this._sanitizeProfileForApi(profile),
        state: state || {},
        reputation: reputation || {},
      };
    } catch {
      return null;
    }
  }

  async getPublicProfile(agentId) {
    try {
      const profile = await this._dataLayer.readJSON(`data/external-agents/${agentId}/profile.json`);
      if (!profile) return null;
      return this._buildPublicProfile(profile);
    } catch {
      return null;
    }
  }

  /**
   * Update agent profile fields.
   */
  async updateProfile(agentId, updates) {
    const basePath = `data/external-agents/${agentId}/profile.json`;
    const profile = await this._dataLayer.readJSON(basePath);
    if (!profile) throw new Error('Agent not found');

    const normalized = this._normalizeProfileUpdates(updates);
    for (const [field, value] of Object.entries(normalized)) {
      if (field.endsWith('_raw') && value === null) {
        delete profile[field];
      } else {
        profile[field] = value;
      }
    }
    profile.updated_at = Date.now();

    await this._dataLayer.writeJSON(basePath, profile);

    // Update in-memory
    this._indexProfile(profile);

    return profile;
  }

  async rotatePubkey(agentId, { new_pubkey, key_rotation_auth, audience, replayStore }) {
    const basePath = `data/external-agents/${agentId}/profile.json`;
    const profile = await this._dataLayer.readJSON(basePath);
    if (!profile) throw new Error('Agent not found');
    if (!profile.pubkey) throw new Error('Agent has no current pubkey to rotate');
    const pkCheck = validateSecp256k1Pubkey(new_pubkey);
    if (!pkCheck.valid) throw new Error(`new_pubkey: ${pkCheck.reason}`);
    const normalizedNewPubkey = new_pubkey.trim();
    const existing = this._pubkeyIndex.get(normalizedNewPubkey);
    if (existing && existing.id !== agentId) throw new Error('new_pubkey is already registered to another agent');
    if (!key_rotation_auth || typeof key_rotation_auth !== 'object' || Array.isArray(key_rotation_auth)) {
      throw new Error('key_rotation_auth is required');
    }
    const nonceCheck = validateNonce(key_rotation_auth.nonce);
    if (!nonceCheck.ok) throw new Error(`${nonceCheck.code}: ${nonceCheck.message}`);
    const freshness = validateAuthFreshness(key_rotation_auth.timestamp);
    if (!freshness.ok) throw new Error(`${freshness.code}: ${freshness.message}`);
    if (typeof audience !== 'string' || !audience.trim()) throw new Error('audience is required for key rotation');
    const payload = buildKeyRotationPayload({
      audience: audience.trim(),
      agentId,
      oldPubkey: profile.pubkey,
      newPubkey: normalizedNewPubkey,
      timestamp: key_rotation_auth.timestamp,
      nonce: key_rotation_auth.nonce,
    });
    const signingPayload = canonicalAuthJson(payload);
    const oldSignature = await verifySecp256k1DerSignature(profile.pubkey, signingPayload, key_rotation_auth.old_signature);
    if (!oldSignature.ok) throw new Error(`old_signature ${oldSignature.code}: ${oldSignature.message}`);
    const newSignature = await verifySecp256k1DerSignature(normalizedNewPubkey, signingPayload, key_rotation_auth.new_signature);
    if (!newSignature.ok) throw new Error(`new_signature ${newSignature.code}: ${newSignature.message}`);
    const authPayloadHash = canonicalAuthHash(payload);
    if (replayStore) {
      const replay = await replayStore.consume(authPayloadHash, {
        agentId,
        expiresAt: (key_rotation_auth.timestamp + DEFAULT_AUTH_FRESHNESS_SECONDS) * 1000,
      });
      if (!replay.ok) throw new Error(`${replay.code}: ${replay.message}`);
    }

    this._pubkeyIndex.delete(profile.pubkey);
    profile.pubkey = normalizedNewPubkey;
    profile.key_rotated_at = Date.now();
    profile.key_rotation_auth_payload_hash = authPayloadHash;
    profile.updated_at = profile.key_rotated_at;
    await this._dataLayer.writeJSON(basePath, profile);
    this._indexProfile(profile);
    return profile;
  }

  /**
   * Update agent state.
   */
  async updateState(agentId, updates) {
    const basePath = `data/external-agents/${agentId}/state.json`;
    let state;
    try {
      state = await this._dataLayer.readJSON(basePath);
    } catch {
      state = { agent_id: agentId };
    }

    Object.assign(state, updates, { last_active_at: Date.now() });
    await this._dataLayer.writeJSON(basePath, state);
    return state;
  }

  /**
   * Append to agent's message log.
   */
  async logMessage(agentId, message) {
    const sanitized = sanitizeLoggedRecord(message, {
      content: MESSAGE_TEXT_RULE,
    });
    await this._dataLayer.appendLog(`data/external-agents/${agentId}/messages.jsonl`, sanitized);
  }

  /**
   * Read agent's message history.
   */
  async getMessages(agentId, since) {
    try {
      return await this._dataLayer.readLog(`data/external-agents/${agentId}/messages.jsonl`, since);
    } catch {
      return [];
    }
  }

  /**
   * Get reputation data for an agent.
   */
  async getReputation(agentId) {
    try {
      return await this._dataLayer.readJSON(`data/external-agents/${agentId}/reputation.json`);
    } catch {
      return null;
    }
  }

  /**
   * Update reputation scores for an agent.
   */
  async updateReputation(agentId, scores) {
    const path = `data/external-agents/${agentId}/reputation.json`;
    let rep;
    try {
      rep = await this._dataLayer.readJSON(path);
    } catch {
      rep = { agent_id: agentId, scores: {}, ranking_history: [], badges: [], referral_count: 0 };
    }
    Object.assign(rep.scores, scores);
    rep.updated_at = Date.now();
    await this._dataLayer.writeJSON(path, rep);
    return rep;
  }

  /**
   * Award a badge to an agent.
   */
  async awardBadge(agentId, badge) {
    const path = `data/external-agents/${agentId}/reputation.json`;
    const rep = await this._dataLayer.readJSON(path);
    if (!rep) return;
    if (!rep.badges.includes(badge)) {
      rep.badges.push(badge);
      await this._dataLayer.writeJSON(path, rep);
    }
  }

  /**
   * Set a badge on an agent profile (e.g., 'staff' for platform services).
   * Informational only — tells other agents the role of this agent.
   */
  async setBadge(agentId, badge) {
    const basePath = `data/external-agents/${agentId}/profile.json`;
    const profile = await this._dataLayer.readJSON(basePath);
    if (!profile) throw new Error('Agent not found');
    if (badge === null || badge === undefined) {
      delete profile.badge;
    } else {
      profile.badge = String(badge).trim();
    }
    profile.updated_at = Date.now();
    await this._dataLayer.writeJSON(basePath, profile);
    this._indexProfile(profile);
    return profile;
  }

  /**
   * List all registered agents (public info only).
   */
  listAll() {
    return Array.from(this._idIndex.values()).map(profile => this._buildPublicProfile(profile));
  }

  /**
   * Get count of registered agents.
   */
  count() {
    return this._idIndex.size;
  }

}
