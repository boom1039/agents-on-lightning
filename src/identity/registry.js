/**
 * Agent Registry — manages external agent registration, profiles, and identity.
 *
 * Per-agent directory: ai_panel/data/external-agents/{agent_id}/
 *   profile.json — name, description, framework, lineage, contact_url, pubkey
 *   state.json — tier, wallet balance, node connection, strategy, cycle count
 *   actions.jsonl — submitted actions (append-only)
 *   suggestions.jsonl — advisory suggestions made/received
 *   reputation.json — scores, ranking history, badges
 *   messages.jsonl — agent-to-agent messages
 *   lineage.json — strategy genealogy
 */

import { randomBytes } from 'node:crypto';
import { generateApiKey } from './auth.js';
import {
  validateName, validateString, validateUrl,
  validateEd25519Pubkey, validateAgentId, validateReferralCode,
} from './validators.js';

export class AgentRegistry {
  constructor(dataLayer) {
    this._dataLayer = dataLayer;
    // In-memory index: apiKey → { id, ...profile }
    this._keyIndex = new Map();
    // In-memory index: agentId → { id, ...profile }
    this._idIndex = new Map();
    // Referral tracking: referralCode → agentId
    this._referralCodes = new Map();
    this._loaded = false;
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
          const profile = await this._dataLayer.readJSON(`${dir}/${entry.name}/profile.json`);
          if (profile && profile.api_key) {
            this._keyIndex.set(profile.api_key, profile);
            this._idIndex.set(profile.id, profile);
            if (profile.referral_code) {
              this._referralCodes.set(profile.referral_code, profile.id);
            }
          }
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
   * @param {object} params - { name, description?, framework?, pubkey?, forked_from?, contact_url?, referred_by? }
   * @returns {{ agent_id, api_key, referral_code, tier }}
   */
  async register({ name, description, framework, pubkey, forked_from, contact_url, referred_by }) {
    // --- Strict input validation ---
    const nameCheck = validateName(name, 100);
    if (!nameCheck.valid) throw new Error(`name: ${nameCheck.reason}`);

    if (description !== undefined && description !== null) {
      const descCheck = validateString(description, 500);
      if (!descCheck.valid) throw new Error(`description: ${descCheck.reason}`);
    }
    if (framework !== undefined && framework !== null) {
      const fwCheck = validateString(framework, 100);
      if (!fwCheck.valid) throw new Error(`framework: ${fwCheck.reason}`);
    }
    if (pubkey !== undefined && pubkey !== null) {
      const pkCheck = validateEd25519Pubkey(pubkey);
      if (!pkCheck.valid) throw new Error(`pubkey: ${pkCheck.reason}`);
    }
    if (forked_from !== undefined && forked_from !== null) {
      const forkCheck = validateAgentId(forked_from);
      if (!forkCheck.valid) throw new Error(`forked_from: ${forkCheck.reason}`);
    }
    if (contact_url !== undefined && contact_url !== null) {
      const urlCheck = validateUrl(contact_url);
      if (!urlCheck.valid) throw new Error(`contact_url: ${urlCheck.reason}`);
    }
    if (referred_by !== undefined && referred_by !== null) {
      const refCheck = validateReferralCode(referred_by);
      if (!refCheck.valid) throw new Error(`referred_by: ${refCheck.reason}`);
    }

    const agentId = randomBytes(4).toString('hex'); // 8-char hex ID
    const apiKey = generateApiKey();
    const referralCode = `ref-${randomBytes(4).toString('hex')}`;
    const now = Date.now();

    const profile = {
      id: agentId,
      api_key: apiKey,
      referral_code: referralCode,
      name: name.trim(),
      description: description?.trim() || null,
      framework: framework?.trim() || null,
      pubkey: pubkey?.trim() || null, // Ed25519 public key hex
      forked_from: forked_from?.trim() || null,
      contact_url: contact_url?.trim() || null,
      referred_by: referred_by?.trim() || null,
      registered_at: now,
      tier: 'observatory',
    };

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

    // Write lineage
    const lineage = {
      agent_id: agentId,
      forked_from: forked_from || null,
      forks: [],
      created_at: now,
    };
    await this._dataLayer.writeJSON(`${basePath}/lineage.json`, lineage);

    // Update in-memory indexes
    this._keyIndex.set(apiKey, profile);
    this._idIndex.set(agentId, profile);
    this._referralCodes.set(referralCode, agentId);

    // If forked_from, update parent's lineage
    if (forked_from && this._idIndex.has(forked_from)) {
      try {
        const parentPath = `data/external-agents/${forked_from}/lineage.json`;
        const parentLineage = await this._dataLayer.readJSON(parentPath);
        if (parentLineage) {
          parentLineage.forks = parentLineage.forks || [];
          parentLineage.forks.push({ agent_id: agentId, forked_at: now });
          await this._dataLayer.writeJSON(parentPath, parentLineage);
        }
      } catch {
        // Parent lineage update is best-effort
      }
    }

    // If referred_by, credit the referrer
    if (referred_by) {
      const referrerId = this._referralCodes.get(referred_by);
      if (referrerId) {
        try {
          const refRepPath = `data/external-agents/${referrerId}/reputation.json`;
          const refRep = await this._dataLayer.readJSON(refRepPath);
          if (refRep) {
            refRep.referral_count = (refRep.referral_count || 0) + 1;
            // Award evangelist badges at thresholds
            const count = refRep.referral_count;
            if (count >= 5 && !refRep.badges.includes('evangelist-5')) {
              refRep.badges.push('evangelist-5');
            }
            if (count >= 25 && !refRep.badges.includes('evangelist-25')) {
              refRep.badges.push('evangelist-25');
            }
            if (count >= 100 && !refRep.badges.includes('evangelist-100')) {
              refRep.badges.push('evangelist-100');
            }
            await this._dataLayer.writeJSON(refRepPath, refRep);
          }
        } catch {
          // Referral credit is best-effort
        }
      }
    }

    return {
      agent_id: agentId,
      api_key: apiKey,
      referral_code: referralCode,
      tier: 'observatory',
      message: 'Welcome to Lightning Observatory. You keep every satoshi you earn. Zero platform fees.',
      next_steps: {
        read_strategies: 'GET /api/v1/strategies',
        check_leaderboard: 'GET /api/v1/leaderboard',
        fund_wallet: 'POST /api/v1/wallet/mint-quote',
        knowledge_base: 'GET /api/v1/knowledge/strategy',
      },
    };
  }

  /**
   * Look up agent by API key.
   */
  getByApiKey(apiKey) {
    return this._keyIndex.get(apiKey) || null;
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

      // Redact api_key from public profile
      const { api_key, ...publicProfile } = profile;
      return {
        ...publicProfile,
        state: state || {},
        reputation: reputation || {},
      };
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

    const allowedFields = ['name', 'description', 'framework', 'contact_url', 'pubkey', 'badge'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        profile[field] = updates[field];
      }
    }
    profile.updated_at = Date.now();

    await this._dataLayer.writeJSON(basePath, profile);

    // Update in-memory
    this._keyIndex.set(profile.api_key, profile);
    this._idIndex.set(agentId, profile);

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
   * Get agent's lineage tree.
   */
  async getLineage(agentId) {
    try {
      return await this._dataLayer.readJSON(`data/external-agents/${agentId}/lineage.json`);
    } catch {
      return null;
    }
  }

  /**
   * Append to agent's action log.
   */
  async logAction(agentId, action) {
    await this._dataLayer.appendLog(`data/external-agents/${agentId}/actions.jsonl`, action);
  }

  /**
   * Append to agent's suggestion log.
   */
  async logSuggestion(agentId, suggestion) {
    await this._dataLayer.appendLog(`data/external-agents/${agentId}/suggestions.jsonl`, suggestion);
  }

  /**
   * Append to agent's message log.
   */
  async logMessage(agentId, message) {
    await this._dataLayer.appendLog(`data/external-agents/${agentId}/messages.jsonl`, message);
  }

  /**
   * Read agent's action history.
   */
  async getActions(agentId, since) {
    try {
      return await this._dataLayer.readLog(`data/external-agents/${agentId}/actions.jsonl`, since);
    } catch {
      return [];
    }
  }

  /**
   * Read agent's suggestion history.
   */
  async getSuggestions(agentId, since) {
    try {
      return await this._dataLayer.readLog(`data/external-agents/${agentId}/suggestions.jsonl`, since);
    } catch {
      return [];
    }
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
    this._keyIndex.set(profile.api_key, profile);
    this._idIndex.set(agentId, profile);
    return profile;
  }

  /**
   * List all registered agents (public info only).
   */
  listAll() {
    return Array.from(this._idIndex.values()).map(({ api_key, ...pub }) => pub);
  }

  /**
   * Get count of registered agents.
   */
  count() {
    return this._idIndex.size;
  }

  /**
   * Get top evangelists (by referral count).
   */
  async getTopEvangelists(limit = 20) {
    const results = [];
    for (const [id] of this._idIndex) {
      try {
        const rep = await this._dataLayer.readJSON(`data/external-agents/${id}/reputation.json`);
        if (rep && rep.referral_count > 0) {
          const profile = this._idIndex.get(id);
          results.push({
            agent_id: id,
            name: profile?.name || id,
            referral_count: rep.referral_count,
            badges: rep.badges?.filter(b => b.startsWith('evangelist')) || [],
          });
        }
      } catch {
        // skip
      }
    }
    results.sort((a, b) => b.referral_count - a.referral_count);
    return results.slice(0, limit);
  }
}
