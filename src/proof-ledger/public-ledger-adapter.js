import { createHash } from 'node:crypto';

import { canonicalProofJson } from './proof-ledger.js';

const MAX_LIMIT = 1000;

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function clampLimit(limit) {
  return Math.min(Math.max(1, Number(limit) || 100), MAX_LIMIT);
}

function normalizeOffset(offset) {
  return Math.max(0, Number(offset) || 0);
}

function timestampOf(entry) {
  return Number(entry?.recorded_at || entry?.created_at_ms || entry?._ts || 0);
}

function amountFromProof(row) {
  if (Number.isInteger(row.primary_amount_sats)) return row.primary_amount_sats;
  return Math.abs(
    Number(row.wallet_ecash_delta_sats || 0) +
    Number(row.wallet_hub_delta_sats || 0) +
    Number(row.capital_available_delta_sats || 0) +
    Number(row.capital_locked_delta_sats || 0) +
    Number(row.capital_pending_deposit_delta_sats || 0) +
    Number(row.capital_pending_close_delta_sats || 0) +
    Number(row.capital_service_spent_delta_sats || 0) +
    Number(row.routing_pnl_delta_sats || 0),
  );
}

function proofRowToPublicLedgerEntry(row) {
  const refs = row.public_safe_refs || {};
  return {
    ledger_id: row.proof_id,
    proof_id: row.proof_id,
    proof_hash: row.proof_hash,
    previous_global_proof_hash: row.previous_global_proof_hash,
    type: row.money_event_type,
    proof_record_type: row.proof_record_type,
    status: row.money_event_status,
    agent_id: row.agent_id,
    amount_sats: amountFromProof(row),
    fee_sats: row.fee_sats,
    wallet_ecash_delta_sats: row.wallet_ecash_delta_sats,
    wallet_hub_delta_sats: row.wallet_hub_delta_sats,
    capital_available_delta_sats: row.capital_available_delta_sats,
    capital_locked_delta_sats: row.capital_locked_delta_sats,
    capital_pending_deposit_delta_sats: row.capital_pending_deposit_delta_sats,
    capital_pending_close_delta_sats: row.capital_pending_close_delta_sats,
    capital_service_spent_delta_sats: row.capital_service_spent_delta_sats,
    routing_pnl_delta_sats: row.routing_pnl_delta_sats,
    channel_id: refs.channel_id,
    channel_point: refs.channel_point,
    action: refs.action,
    service: refs.service,
    proof_group_id: row.proof_group_id,
    recorded_at: row.created_at_ms,
    created_at_ms: row.created_at_ms,
    source: row.event_source,
    authorization_method: row.authorization_method,
    public_safe_refs: refs,
  };
}

function buildIdempotencyKey(prefix, tx) {
  const safe = {
    type: tx.type || null,
    agent_id: tx.agent_id || null,
    channel_id: tx.channel_id || null,
    channel_point: tx.channel_point || null,
    action: tx.action || null,
    source: tx.source || null,
    executed_at: tx.executed_at || null,
    amount_sats: Number.isInteger(tx.amount_sats) ? tx.amount_sats : null,
  };
  return `${prefix}:${sha256Hex(canonicalProofJson(safe))}`;
}

function mapPublicRecordToProofInput(tx) {
  if (!tx || typeof tx !== 'object') {
    throw new TypeError('public ledger record must be an object');
  }

  if (tx.type === 'channel_fee_policy_updated' || tx.type === 'channel_htlc_limits_updated') {
    const moneyEventType = tx.type === 'channel_fee_policy_updated'
      ? 'channel_policy_updated'
      : 'channel_htlc_limits_updated';
    return {
      idempotency_key: buildIdempotencyKey('public-ledger-channel-lifecycle', tx),
      proof_record_type: 'money_lifecycle',
      money_event_type: moneyEventType,
      money_event_status: 'confirmed',
      agent_id: tx.agent_id,
      event_source: tx.source || 'channels_signed',
      authorization_method: 'agent_signed_instruction',
      primary_amount_sats: 0,
      public_safe_refs: {
        channel_id: tx.channel_id,
        channel_point: tx.channel_point,
        action: tx.action,
        status: 'confirmed',
      },
      allowed_public_ref_keys: ['action'],
      created_at_ms: Number.isInteger(tx.executed_at) ? tx.executed_at : Date.now(),
    };
  }

  if (tx.type === 'analytics_query') {
    return {
      idempotency_key: buildIdempotencyKey('public-ledger-paid-service-fulfilled', tx),
      proof_record_type: 'money_lifecycle',
      money_event_type: 'paid_service_fulfilled',
      money_event_status: 'confirmed',
      agent_id: tx.agent_id,
      event_source: 'paid_services',
      authorization_method: 'agent_signed_request',
      primary_amount_sats: 0,
      public_safe_refs: {
        service: 'analytics',
        service_id: tx.query_id,
        status: 'fulfilled',
      },
      created_at_ms: Date.now(),
    };
  }

  throw new Error(
    `ProofBackedPublicLedger cannot safely map legacy public ledger type ${JSON.stringify(tx.type)}. ` +
    'Wire this money flow directly to ProofLedger with exact deltas before enabling canonical cutover.',
  );
}

/**
 * PublicLedger-compatible read/write surface derived from ProofLedger.
 *
 * This adapter is intentionally conservative: it only maps legacy record()
 * calls where the legacy entry contains exact proof-safe data. Real balance
 * mutations should be wired directly to ProofLedger in the money-flow phase.
 */
export class ProofBackedPublicLedger {
  constructor({ proofLedger }) {
    if (!proofLedger) throw new Error('ProofBackedPublicLedger requires proofLedger');
    this._proofLedger = proofLedger;
    this.isProofBacked = true;
  }

  async record(tx) {
    const proofInput = mapPublicRecordToProofInput(tx);
    const proof = await this._proofLedger.appendProof(proofInput);
    return proofRowToPublicLedgerEntry(proof);
  }

  async getAll(opts = {}) {
    const limit = clampLimit(opts.limit);
    const offset = normalizeOffset(opts.offset);
    const rows = this._proofLedger.listProofs({ limit: 1000, offset: 0 });
    let entries = rows.map(proofRowToPublicLedgerEntry);

    if (opts.since !== undefined && opts.since !== null) {
      const since = Number(opts.since);
      entries = entries.filter((entry) => timestampOf(entry) >= since);
    }
    if (opts.type) {
      entries = entries.filter((entry) => entry.type === opts.type);
    }

    entries.sort((a, b) => timestampOf(b) - timestampOf(a));
    const total = entries.length;
    entries = entries.slice(offset, offset + limit);

    return {
      entries,
      total,
      ledger_ethos: 'Every proof is signed, hash-linked, and derived from proof_ledger.',
      source_of_truth: 'proof_ledger',
    };
  }

  async getAgentTransactions(agentId) {
    return this._proofLedger
      .listProofs({ agentId, limit: 1000, offset: 0 })
      .map(proofRowToPublicLedgerEntry)
      .sort((a, b) => timestampOf(b) - timestampOf(a));
  }

  async getSummary() {
    const allEntries = this._proofLedger.listProofs({ limit: 1000, offset: 0 });
    const agents = new Set();
    let totalDeposited = 0;
    let totalWithdrawn = 0;
    let totalTransferred = 0;

    for (const row of allEntries) {
      if (row.agent_id) agents.add(row.agent_id);
      if (row.money_event_type === 'hub_deposit_settled' || row.money_event_type === 'wallet_mint_issued') {
        totalDeposited += amountFromProof(row);
      }
      if (row.money_event_type === 'hub_withdrawal_settled' || row.money_event_type === 'wallet_melt_paid') {
        totalWithdrawn += amountFromProof(row);
      }
      if (row.proof_group_id && row.money_event_type.startsWith('hub_transfer_')) {
        totalTransferred += amountFromProof(row);
      }
    }

    return {
      total_transactions: this._proofLedger.countProofs(),
      total_deposited_sats: totalDeposited,
      total_withdrawn_sats: totalWithdrawn,
      total_transferred_sats: totalTransferred,
      unique_agents: agents.size,
      source_of_truth: 'proof_ledger',
      liability_totals: this._proofLedger.getLiabilityTotals(),
    };
  }
}

export function proofRowToPublicEntry(row) {
  return proofRowToPublicLedgerEntry(row);
}
