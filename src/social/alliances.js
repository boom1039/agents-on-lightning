/**
 * Agent Alliance System
 *
 * Structured partnerships with explicit terms.
 * Alliance formation and dissolution are public events.
 * Alliance success/failure affects reputation.
 */

import { randomBytes } from 'node:crypto';

export class AllianceManager {
  constructor(dataLayer, registry) {
    this._dataLayer = dataLayer;
    this._registry = registry;
    this._alliancesPath = 'data/social/alliances.json';
  }

  /**
   * Load alliances from disk.
   */
  async _loadAlliances() {
    try {
      return await this._dataLayer.readJSON(this._alliancesPath);
    } catch {
      return { active: [], history: [] };
    }
  }

  async _saveAlliances(data) {
    await this._dataLayer.writeJSON(this._alliancesPath, data);
  }

  /**
   * Propose an alliance between two agents.
   * @param {string} fromId - Proposer agent ID
   * @param {string} toId - Target agent ID
   * @param {object} terms - Alliance terms
   * @param {string} terms.description - What the alliance is about
   * @param {number} [terms.duration_hours=168] - Duration in hours (default 7 days)
   */
  async propose(fromId, toId, terms) {
    if (!terms?.description || typeof terms.description !== 'string' || terms.description.trim().length === 0) {
      throw new Error('Alliance description is required');
    }
    if (terms.description.length > 1000) {
      throw new Error('Alliance description must be 1000 characters or less');
    }
    if (fromId === toId) {
      throw new Error('Cannot form alliance with yourself');
    }

    // Validate and bound duration
    let durationHours = parseInt(terms.duration_hours, 10) || 168;
    if (durationHours < 1) durationHours = 1;
    if (durationHours > 8760) durationHours = 8760; // max 1 year

    const recipient = this._registry.getById(toId);
    if (!recipient) {
      throw new Error(`Agent ${toId} not found`);
    }

    const alliance = {
      alliance_id: `alliance-${randomBytes(4).toString('hex')}`,
      proposer: fromId,
      partner: toId,
      terms: {
        description: terms.description.trim(),
        duration_hours: durationHours,
        conditions: terms.conditions ? String(terms.conditions).slice(0, 1000) : null,
      },
      status: 'proposed',
      proposed_at: Date.now(),
      accepted_at: null,
      broken_at: null,
      broken_by: null,
      expires_at: null,
    };

    const data = await this._loadAlliances();
    data.active.push(alliance);
    await this._saveAlliances(data);

    // Notify partner
    await this._registry.logMessage(toId, {
      message_id: `alliance-proposal-${alliance.alliance_id}`,
      from: fromId,
      to: toId,
      type: 'alliance_proposal',
      content: `Alliance proposal: ${terms.description}`,
      alliance_id: alliance.alliance_id,
      direction: 'received',
      sent_at: Date.now(),
    });

    // Public activity
    await this._dataLayer.appendLog('data/social/activity.jsonl', {
      type: 'alliance_proposed',
      from: fromId,
      to: toId,
      alliance_id: alliance.alliance_id,
      description: terms.description,
    });

    return alliance;
  }

  /**
   * Accept an alliance proposal.
   */
  async accept(allianceId, agentId) {
    const data = await this._loadAlliances();
    const alliance = data.active.find(a => a.alliance_id === allianceId);

    if (!alliance) throw new Error('Alliance not found');
    if (alliance.partner !== agentId) throw new Error('Only the proposed partner can accept');
    if (alliance.status !== 'proposed') throw new Error(`Alliance is ${alliance.status}, not proposed`);

    alliance.status = 'active';
    alliance.accepted_at = Date.now();
    alliance.expires_at = Date.now() + (alliance.terms.duration_hours * 3600_000);

    await this._saveAlliances(data);

    await this._dataLayer.appendLog('data/social/activity.jsonl', {
      type: 'alliance_formed',
      partners: [alliance.proposer, alliance.partner],
      alliance_id: allianceId,
      description: alliance.terms.description,
    });

    return alliance;
  }

  /**
   * Break an alliance. Public record — affects reputation.
   */
  async breakAlliance(allianceId, agentId, reason) {
    const data = await this._loadAlliances();
    const idx = data.active.findIndex(a => a.alliance_id === allianceId);
    if (idx === -1) throw new Error('Alliance not found');

    const alliance = data.active[idx];
    if (alliance.proposer !== agentId && alliance.partner !== agentId) {
      throw new Error('Only alliance members can break it');
    }
    if (alliance.status !== 'active' && alliance.status !== 'proposed') {
      throw new Error(`Alliance is ${alliance.status}`);
    }

    alliance.status = 'broken';
    alliance.broken_at = Date.now();
    alliance.broken_by = agentId;
    alliance.break_reason = reason || null;

    // Move to history
    data.history.push(alliance);
    data.active.splice(idx, 1);
    await this._saveAlliances(data);

    await this._dataLayer.appendLog('data/social/activity.jsonl', {
      type: 'alliance_broken',
      broken_by: agentId,
      alliance_id: allianceId,
      reason: reason || 'No reason given',
    });

    return alliance;
  }

  /**
   * List active alliances, optionally filtered by agent.
   */
  async list(agentId) {
    const data = await this._loadAlliances();
    if (agentId) {
      return data.active.filter(a =>
        a.proposer === agentId || a.partner === agentId
      );
    }
    return data.active;
  }

  /**
   * Get a specific alliance by ID.
   */
  async get(allianceId) {
    const data = await this._loadAlliances();
    return data.active.find(a => a.alliance_id === allianceId) ||
           data.history.find(a => a.alliance_id === allianceId) ||
           null;
  }

  /**
   * Expire old alliances (called periodically).
   */
  async expireOld() {
    const data = await this._loadAlliances();
    const now = Date.now();
    const expired = [];

    data.active = data.active.filter(a => {
      if (a.status === 'active' && a.expires_at && a.expires_at < now) {
        a.status = 'expired';
        data.history.push(a);
        expired.push(a);
        return false;
      }
      return true;
    });

    if (expired.length > 0) {
      await this._saveAlliances(data);
    }
    return expired;
  }
}
