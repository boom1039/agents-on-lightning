/**
 * Agent Cashu Proof Store
 *
 * Pure persistence layer for per-agent ecash proofs.
 * Proofs stored at data/external-agents/{agentId}/cashu-proofs.json
 *
 * No mutex — the wallet operations module owns all locking.
 * Uses DataLayer.writeJSON() for atomic writes (tmp+rename).
 */

export class AgentCashuProofStore {
  constructor(dataLayer) {
    this._dataLayer = dataLayer;
  }

  _proofPath(agentId) {
    return `data/external-agents/${agentId}/cashu-proofs.json`;
  }

  async loadProofs(agentId) {
    try {
      return await this._dataLayer.readJSON(this._proofPath(agentId));
    } catch {
      return [];
    }
  }

  async saveProofs(agentId, proofs) {
    await this._dataLayer.writeJSON(this._proofPath(agentId), proofs);
  }

  getBalance(agentId) {
    return this.loadProofs(agentId).then(
      proofs => proofs.reduce((sum, p) => sum + (p.amount || 0), 0),
    );
  }

  // ---------------------------------------------------------------------------
  // Counter persistence (deterministic mode, NUT-09/NUT-13)
  // ---------------------------------------------------------------------------

  _counterPath(agentId) {
    return `data/external-agents/${agentId}/cashu-counter.json`;
  }

  async loadCounter(agentId) {
    try {
      return await this._dataLayer.readJSON(this._counterPath(agentId));
    } catch {
      return {};
    }
  }

  async saveCounter(agentId, counters) {
    await this._dataLayer.writeJSON(this._counterPath(agentId), counters);
  }

  // ---------------------------------------------------------------------------
  // Pending send persistence (sent-token recovery)
  // ---------------------------------------------------------------------------

  _pendingSendPath(agentId) {
    return `data/external-agents/${agentId}/cashu-pending-sends.json`;
  }

  async loadPendingSends(agentId) {
    try {
      return await this._dataLayer.readJSON(this._pendingSendPath(agentId));
    } catch {
      return [];
    }
  }

  async savePendingSends(agentId, sends) {
    await this._dataLayer.writeJSON(this._pendingSendPath(agentId), sends);
  }

  async addPendingSend(agentId, entry) {
    const sends = await this.loadPendingSends(agentId);
    sends.push({ ...entry, created_at: Date.now() });
    await this.savePendingSends(agentId, sends);
  }
}
