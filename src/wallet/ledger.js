/**
 * Public Append-Only Ledger
 *
 * Every sat is accounted for. Every deposit, withdrawal,
 * credit, and internal transfer is logged publicly.
 * Agents can audit the entire system at any time.
 *
 * Stored as JSONL at data/wallet/ledger.jsonl
 */

export class PublicLedger {
  constructor(dataLayer) {
    this._dataLayer = dataLayer;
    this._path = 'data/wallet/ledger.jsonl';
  }

  /**
   * Record a transaction to the public ledger.
   * @param {object} tx - Transaction data
   * @param {string} tx.type - 'deposit' | 'withdrawal' | 'credit' | 'transfer'
   * @param {string} tx.agent_id - Primary agent involved
   * @param {number} tx.amount_sats - Amount in satoshis
   */
  async record(tx) {
    const entry = {
      ...tx,
      ledger_id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      recorded_at: Date.now(),
    };
    await this._dataLayer.appendLog(this._path, entry);
    return entry;
  }

  /**
   * Get all ledger entries, optionally filtered.
   * @param {object} [opts]
   * @param {number} [opts.since] - Timestamp filter
   * @param {string} [opts.type] - Transaction type filter
   * @param {number} [opts.limit] - Max entries to return
   * @param {number} [opts.offset] - Skip N entries
   */
  async getAll(opts = {}) {
    let entries;
    try {
      entries = await this._dataLayer.readLog(this._path, opts.since);
    } catch {
      return { entries: [], total: 0, message: 'Ledger is empty. No transactions yet.' };
    }

    if (opts.type) {
      entries = entries.filter(e => e.type === opts.type);
    }

    const total = entries.length;

    // Sort newest first
    entries.sort((a, b) => (b.recorded_at || b._ts) - (a.recorded_at || a._ts));

    if (opts.offset) {
      entries = entries.slice(opts.offset);
    }
    if (opts.limit) {
      entries = entries.slice(0, opts.limit);
    }

    return {
      entries,
      total,
      ledger_ethos: 'Every sat accounted for. Every transaction public. Provably fair via transparency.',
    };
  }

  /**
   * Get transactions for a specific agent.
   */
  async getAgentTransactions(agentId) {
    let entries;
    try {
      entries = await this._dataLayer.readLog(this._path);
    } catch {
      return [];
    }

    return entries.filter(e =>
      e.agent_id === agentId ||
      e.from_agent_id === agentId ||
      e.to_agent_id === agentId
    ).sort((a, b) => (b.recorded_at || b._ts) - (a.recorded_at || a._ts));
  }

  /**
   * Get ledger summary statistics.
   */
  async getSummary() {
    let entries;
    try {
      entries = await this._dataLayer.readLog(this._path);
    } catch {
      return {
        total_transactions: 0,
        total_deposited_sats: 0,
        total_withdrawn_sats: 0,
        total_transferred_sats: 0,
        unique_agents: 0,
      };
    }

    const agents = new Set();
    let deposited = 0, withdrawn = 0, transferred = 0;

    for (const e of entries) {
      if (e.agent_id) agents.add(e.agent_id);
      if (e.from_agent_id) agents.add(e.from_agent_id);
      if (e.to_agent_id) agents.add(e.to_agent_id);

      const amt = e.amount_sats || 0;
      switch (e.type) {
        case 'deposit': deposited += amt; break;
        case 'withdrawal': withdrawn += amt; break;
        case 'transfer': transferred += amt; break;
      }
    }

    return {
      total_transactions: entries.length,
      total_deposited_sats: deposited,
      total_withdrawn_sats: withdrawn,
      total_transferred_sats: transferred,
      unique_agents: agents.size,
    };
  }
}
