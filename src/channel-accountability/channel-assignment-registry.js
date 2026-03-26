const ASSIGNMENTS_PATH = 'data/channel-accountability/assignments.json';

/**
 * Maps channel_point → agent_id with optional fee constraints.
 * Persisted as atomic JSON writes. Audit-logged on assign/revoke.
 */
export class ChannelAssignmentRegistry {
  constructor(dataLayer, auditLog) {
    this._dataLayer = dataLayer;
    this._auditLog = auditLog;
    // Keyed by chan_id (uint64 string)
    this._assignments = new Map();
    // Secondary index: channel_point → chan_id
    this._pointIndex = new Map();
  }

  async load() {
    try {
      const data = await this._dataLayer.readJSON(ASSIGNMENTS_PATH);
      if (data && typeof data === 'object') {
        for (const [chanId, entry] of Object.entries(data)) {
          this._assignments.set(chanId, entry);
          if (entry.channel_point) {
            this._pointIndex.set(entry.channel_point, chanId);
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT' && !err.message?.includes('ENOENT')) {
        throw err;
      }
      // No file yet — fresh start
    }
    console.log(`[ChannelAssignmentRegistry] Loaded ${this._assignments.size} assignments`);
  }

  async _persist() {
    const obj = Object.fromEntries(this._assignments);
    await this._dataLayer.writeJSON(ASSIGNMENTS_PATH, obj);
  }

  /**
   * Assign a channel to an agent.
   * @param {string} chanId - uint64 decimal string from LND
   * @param {string} channelPoint - "txid:output_index"
   * @param {string} agentId
   * @param {object} meta - { remote_pubkey, capacity }
   * @param {object} [constraints] - { min_base_fee_msat, max_base_fee_msat, min_fee_rate_ppm, max_fee_rate_ppm, cooldown_minutes }
   */
  async assign(chanId, channelPoint, agentId, meta = {}, constraints = null) {
    // Duplicate prevention: channel already assigned?
    if (this._assignments.has(chanId)) {
      const existing = this._assignments.get(chanId);
      const err = new Error(`Channel already assigned to agent ${existing.agent_id}`);
      err.status = 409;
      err.existing_agent_id = existing.agent_id;
      throw err;
    }

    const entry = {
      chan_id: chanId,
      channel_point: channelPoint,
      agent_id: agentId,
      remote_pubkey: meta.remote_pubkey || null,
      capacity: meta.capacity || null,
      constraints: constraints || null,
      assigned_at: Date.now(),
    };

    this._assignments.set(chanId, entry);
    this._pointIndex.set(channelPoint, chanId);
    await this._persist();

    await this._auditLog.append({
      type: 'channel_assigned',
      chan_id: chanId,
      channel_point: channelPoint,
      agent_id: agentId,
      remote_pubkey: meta.remote_pubkey || null,
      constraints: constraints || null,
    });

    return entry;
  }

  async revoke(chanId) {
    let entry = this._assignments.get(chanId);
    // Also allow revoke by channel_point (txid:vout)
    if (!entry && this._pointIndex.has(chanId)) {
      chanId = this._pointIndex.get(chanId);
      entry = this._assignments.get(chanId);
    }
    if (!entry) {
      const err = new Error('Channel not assigned');
      err.status = 404;
      throw err;
    }

    this._assignments.delete(chanId);
    if (entry.channel_point) {
      this._pointIndex.delete(entry.channel_point);
    }
    await this._persist();

    await this._auditLog.append({
      type: 'channel_assignment_revoked',
      chan_id: chanId,
      channel_point: entry.channel_point,
      agent_id: entry.agent_id,
    });

    return entry;
  }

  getAssignment(chanId) {
    return this._assignments.get(chanId) || null;
  }

  getAssignmentByPoint(channelPoint) {
    const chanId = this._pointIndex.get(channelPoint);
    if (!chanId) return null;
    return this._assignments.get(chanId) || null;
  }

  getByAgent(agentId) {
    const results = [];
    for (const entry of this._assignments.values()) {
      if (entry.agent_id === agentId) results.push(entry);
    }
    return results;
  }

  getAssignedChannelPoints() {
    return new Set(this._pointIndex.keys());
  }

  getChanIdByPoint(channelPoint) {
    return this._pointIndex.get(channelPoint) || null;
  }

  getAllAssignments() {
    return Array.from(this._assignments.values());
  }

  count() {
    return this._assignments.size;
  }
}
