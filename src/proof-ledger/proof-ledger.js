import Database from 'better-sqlite3';
import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as signData,
  verify as verifyData,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

import { getProjectRoot } from '../config.js';

export const PROOF_LEDGER_CANONICALIZATION_VERSION = 'aol-proof-v1';

export const PROOF_LEDGER_DEFAULT_DB_PATH = 'data/proof-ledger.sqlite';
export const PROOF_LEDGER_DEFAULT_KEY_PATH = resolve(
  homedir() || getProjectRoot(),
  '.agents-on-lightning',
  'proof-ledger-ed25519-private.pem',
);

export const PROOF_RECORD_TYPES = Object.freeze([
  'genesis',
  'money_event',
  'money_lifecycle',
  'liability_checkpoint',
  'reserve_snapshot',
  'reconciliation',
  'operator_adjustment',
  'key_rotation',
]);

export const MONEY_EVENT_STATUSES = Object.freeze([
  'created',
  'pending',
  'submitted',
  'confirmed',
  'settled',
  'failed',
  'refunded',
  'expired',
  'rejected',
  'unknown',
]);

export const AUTHORIZATION_METHODS = Object.freeze([
  'agent_signed_request',
  'agent_signed_instruction',
  'system_settlement',
  'routing_revenue',
  'refund',
  'operator_adjustment',
  'reserve_attestation',
  'liability_checkpoint',
  'key_rotation',
]);

export const VISIBILITY_SCOPES = Object.freeze([
  'public',
  'agent_private',
  'operator_private',
]);

export const MONEY_EVENT_TYPES = Object.freeze([
  'proof_ledger_started',
  'key_rotation_announced',
  'wallet_mint_quote_created',
  'wallet_mint_issued',
  'wallet_melt_quote_created',
  'wallet_melt_paid',
  'wallet_ecash_sent',
  'wallet_ecash_received',
  'wallet_ecash_pending_reclaimed',
  'wallet_ecash_proof_state_reconciled',
  'hub_deposit_invoice_created',
  'hub_deposit_settled',
  'hub_withdrawal_submitted',
  'hub_withdrawal_settled',
  'hub_withdrawal_refunded',
  'hub_internal_credit',
  'hub_transfer_debited',
  'hub_transfer_credited',
  'capital_deposit_address_created',
  'capital_deposit_detected',
  'capital_deposit_pending',
  'capital_deposit_confirmed',
  'capital_withdrawal_debited',
  'capital_withdrawal_broadcast',
  'capital_withdrawal_refunded',
  'capital_ecash_funding_credited',
  'lightning_capital_receive_preflight_rejected',
  'lightning_capital_receive_preflight_accepted',
  'lightning_capital_bridge_preflight_rejected',
  'lightning_capital_bridge_preflight_accepted',
  'lightning_capital_invoice_created',
  'lightning_capital_invoice_paid',
  'lightning_capital_bridge_started',
  'lightning_capital_wallet_fallback_started',
  'lightning_capital_bridge_broadcast',
  'lightning_capital_bridge_failed',
  'lightning_capital_recovery_required',
  'lightning_capital_onchain_pending',
  'lightning_capital_confirmed',
  'channel_open_instruction_accepted',
  'channel_open_capital_locked',
  'channel_open_submitted',
  'channel_open_failed_unlocked',
  'channel_open_active',
  'channel_assignment_created',
  'channel_assignment_revoked',
  'channel_close_instruction_accepted',
  'channel_close_pending',
  'channel_close_submitted',
  'channel_close_submission_unknown',
  'channel_close_failed_rolled_back',
  'channel_close_peer_initiated',
  'channel_close_untracked_reconciliation',
  'channel_close_settled',
  'channel_close_fee_recorded',
  'channel_routing_pnl_recorded',
  'channel_policy_updated',
  'channel_htlc_limits_updated',
  'rebalance_fee_estimated',
  'rebalance_fee_locked',
  'rebalance_submitted',
  'rebalance_succeeded_fee_settled',
  'rebalance_failed_fee_refunded',
  'swap_quote_created',
  'swap_submitted',
  'swap_direct_payout_debited',
  'swap_payout_broadcast',
  'swap_completed',
  'swap_failed_refunded',
  'routing_revenue_attributed',
  'routing_revenue_credited',
  'paid_service_charge_debited',
  'paid_service_fulfilled',
  'paid_service_refunded',
  'paid_service_refund_failed',
  'operator_adjustment',
  'liability_checkpoint_created',
  'reserve_snapshot_created',
  'reconciliation_completed',
]);

const PROOF_RECORD_TYPE_SET = new Set(PROOF_RECORD_TYPES);
const MONEY_EVENT_STATUS_SET = new Set(MONEY_EVENT_STATUSES);
const AUTHORIZATION_METHOD_SET = new Set(AUTHORIZATION_METHODS);
const VISIBILITY_SCOPE_SET = new Set(VISIBILITY_SCOPES);
const MONEY_EVENT_TYPE_SET = new Set(MONEY_EVENT_TYPES);

export const PROOF_LEDGER_ISSUER_DOMAINS = Object.freeze([
  'agentsonlightning.com',
  'agentsonbitcoin.com',
  'lightningobservatory.com',
]);

const DELTA_FIELDS = Object.freeze([
  'wallet_ecash_delta_sats',
  'wallet_hub_delta_sats',
  'capital_available_delta_sats',
  'capital_locked_delta_sats',
  'capital_pending_deposit_delta_sats',
  'capital_pending_close_delta_sats',
  'capital_service_spent_delta_sats',
  'routing_pnl_delta_sats',
]);

const BALANCE_FIELDS = Object.freeze([
  ['wallet_ecash_delta_sats', 'wallet_ecash_sats'],
  ['wallet_hub_delta_sats', 'wallet_hub_sats'],
  ['capital_available_delta_sats', 'capital_available_sats'],
  ['capital_locked_delta_sats', 'capital_locked_sats'],
  ['capital_pending_deposit_delta_sats', 'capital_pending_deposit_sats'],
  ['capital_pending_close_delta_sats', 'capital_pending_close_sats'],
  ['capital_service_spent_delta_sats', 'capital_service_spent_sats'],
  ['routing_pnl_delta_sats', 'routing_pnl_sats'],
]);

const CAPITAL_ACTIVITY_EVENT_TYPES = Object.freeze([
  'capital_deposit_address_created',
  'capital_deposit_detected',
  'capital_deposit_pending',
  'capital_deposit_confirmed',
  'capital_withdrawal_debited',
  'capital_withdrawal_broadcast',
  'capital_withdrawal_refunded',
  'capital_ecash_funding_credited',
  'lightning_capital_receive_preflight_rejected',
  'lightning_capital_receive_preflight_accepted',
  'lightning_capital_bridge_preflight_rejected',
  'lightning_capital_bridge_preflight_accepted',
  'lightning_capital_invoice_created',
  'lightning_capital_invoice_paid',
  'lightning_capital_bridge_started',
  'lightning_capital_wallet_fallback_started',
  'lightning_capital_bridge_broadcast',
  'lightning_capital_bridge_failed',
  'lightning_capital_recovery_required',
  'lightning_capital_onchain_pending',
  'lightning_capital_confirmed',
  'channel_open_instruction_accepted',
  'channel_open_capital_locked',
  'channel_open_submitted',
  'channel_open_failed_unlocked',
  'channel_open_active',
  'channel_assignment_created',
  'channel_assignment_revoked',
  'channel_close_instruction_accepted',
  'channel_close_pending',
  'channel_close_submitted',
  'channel_close_submission_unknown',
  'channel_close_failed_rolled_back',
  'channel_close_peer_initiated',
  'channel_close_untracked_reconciliation',
  'channel_close_settled',
  'channel_close_fee_recorded',
  'channel_routing_pnl_recorded',
  'channel_policy_updated',
  'channel_htlc_limits_updated',
  'rebalance_fee_estimated',
  'rebalance_fee_locked',
  'rebalance_submitted',
  'rebalance_succeeded_fee_settled',
  'rebalance_failed_fee_refunded',
  'swap_quote_created',
  'swap_submitted',
  'swap_direct_payout_debited',
  'swap_payout_broadcast',
  'swap_completed',
  'swap_failed_refunded',
  'routing_revenue_attributed',
  'routing_revenue_credited',
  'paid_service_charge_debited',
  'paid_service_fulfilled',
  'paid_service_refunded',
  'paid_service_refund_failed',
]);

const CALLER_FORBIDDEN_FIELDS = Object.freeze([
  'global_sequence',
  'agent_proof_sequence',
  'balance_snapshot_before_json',
  'balance_snapshot_after_json',
  'previous_global_proof_hash',
  'previous_agent_proof_hash',
  'proof_hash',
  'canonical_proof_json',
  'platform_signature',
  'signing_key_id',
]);

const DEFAULT_PUBLIC_SAFE_REF_KEYS = Object.freeze([
  'agent_id',
  'alliance_id',
  'amount_sats',
  'asset',
  'block_height',
  'capital_bucket',
  'capital_available_sats',
  'capital_locked_sats',
  'capital_pending_close_sats',
  'capital_pending_deposit_sats',
  'capital_service_spent_sats',
  'chan_id',
  'channel_id',
  'channel_point',
  'checkpoint_created_at_ms',
  'checkpointed_global_proof_hash',
  'checkpointed_through_global_sequence',
  'confirmation_count',
  'domains',
  'event_source',
  'evidence_type',
  'fee_sats',
  'gross_amount_sats',
  'instruction_hash',
  'key_id',
  'liability_totals_by_bucket',
  'money_event_status',
  'money_event_type',
  'net_amount_sats',
  'outpoint',
  'peer_pubkey',
  'policy_id',
  'primary_amount_sats',
  'proof_group_id',
  'proof_id',
  'provider',
  'provider_name',
  'public_key_fingerprint',
  'reason',
  'reconciliation_status',
  'required_confirmations',
  'reserve_source_name',
  'reserve_source_type',
  'reserve_evidence_refs',
  'reserve_sufficient',
  'reserve_totals_by_source',
  'routing_pnl_sats',
  'scope',
  'service',
  'service_id',
  'status',
  'swap_id',
  'total_liability_sats',
  'total_reserve_sats',
  'total_tracked_sats',
  'tournament_id',
  'txid',
  'vout',
  'wallet_ecash_sats',
  'wallet_hub_sats',
]);

const GENESIS_IDEMPOTENCY_KEY = 'proof-ledger-genesis-v1';
const GENESIS_NOTE =
  'The Proof Ledger starts here. Prior ledger/accounting files contain operator test activity only. ' +
  'They are archived and are not part of the public production proof chain. ' +
  'All production money proofs after this point derive from proof_ledger.';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS proof_ledger (
  global_sequence INTEGER PRIMARY KEY,
  proof_id TEXT NOT NULL UNIQUE,
  proof_group_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,

  proof_record_type TEXT NOT NULL CHECK (
    proof_record_type IN (
      'genesis',
      'money_event',
      'money_lifecycle',
      'liability_checkpoint',
      'reserve_snapshot',
      'reconciliation',
      'operator_adjustment',
      'key_rotation'
    )
  ),
  money_event_type TEXT NOT NULL,
  money_event_status TEXT NOT NULL CHECK (
    money_event_status IN (
      'created',
      'pending',
      'submitted',
      'confirmed',
      'settled',
      'failed',
      'refunded',
      'expired',
      'rejected',
      'unknown'
    )
  ),

  agent_id TEXT,
  agent_proof_sequence INTEGER,

  event_source TEXT NOT NULL,
  authorization_method TEXT NOT NULL CHECK (
    authorization_method IN (
      'agent_signed_request',
      'agent_signed_instruction',
      'system_settlement',
      'routing_revenue',
      'refund',
      'operator_adjustment',
      'reserve_attestation',
      'liability_checkpoint',
      'key_rotation'
    )
  ),

  primary_amount_sats INTEGER,
  gross_amount_sats INTEGER,
  fee_sats INTEGER,
  net_amount_sats INTEGER,
  asset TEXT NOT NULL DEFAULT 'BTC',

  wallet_ecash_delta_sats INTEGER NOT NULL DEFAULT 0,
  wallet_hub_delta_sats INTEGER NOT NULL DEFAULT 0,
  capital_available_delta_sats INTEGER NOT NULL DEFAULT 0,
  capital_locked_delta_sats INTEGER NOT NULL DEFAULT 0,
  capital_pending_deposit_delta_sats INTEGER NOT NULL DEFAULT 0,
  capital_pending_close_delta_sats INTEGER NOT NULL DEFAULT 0,
  capital_service_spent_delta_sats INTEGER NOT NULL DEFAULT 0,
  routing_pnl_delta_sats INTEGER NOT NULL DEFAULT 0,

  balance_snapshot_before_json TEXT NOT NULL,
  balance_snapshot_after_json TEXT NOT NULL,
  public_safe_refs_json TEXT NOT NULL,

  visibility_scope TEXT NOT NULL DEFAULT 'public' CHECK (
    visibility_scope IN ('public', 'agent_private', 'operator_private')
  ),

  issuer_domains_json TEXT NOT NULL,
  signing_key_id TEXT NOT NULL,
  canonicalization_version TEXT NOT NULL DEFAULT 'aol-proof-v1',

  previous_global_proof_hash TEXT,
  previous_agent_proof_hash TEXT,
  proof_hash TEXT NOT NULL UNIQUE,

  canonical_proof_json TEXT NOT NULL,
  platform_signature TEXT NOT NULL,

  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_proof_ledger_agent_sequence
ON proof_ledger (agent_id, agent_proof_sequence)
WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proof_ledger_created_at
ON proof_ledger (created_at_ms);

CREATE INDEX IF NOT EXISTS idx_proof_ledger_record_type_event
ON proof_ledger (proof_record_type, money_event_type);

CREATE INDEX IF NOT EXISTS idx_proof_ledger_group
ON proof_ledger (proof_group_id);

CREATE INDEX IF NOT EXISTS idx_proof_ledger_agent_created
ON proof_ledger (agent_id, created_at_ms);
`;

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sha256Base64Url(data) {
  return createHash('sha256').update(data).digest('base64url');
}

function expandHome(inputPath) {
  if (typeof inputPath === 'string' && inputPath.startsWith('~/')) {
    return resolve(homedir() || '/', inputPath.slice(2));
  }
  return inputPath;
}

function resolveDbPath(dbPath) {
  const selected = expandHome(dbPath || process.env.AOL_PROOF_LEDGER_DB_PATH || PROOF_LEDGER_DEFAULT_DB_PATH);
  return resolve(getProjectRoot(), selected);
}

function resolveKeyPath(keyPath) {
  return resolve(expandHome(keyPath || process.env.AOL_PROOF_LEDGER_KEY_PATH || PROOF_LEDGER_DEFAULT_KEY_PATH));
}

function isProductionRuntime() {
  return process.env.NODE_ENV === 'production' || process.env.AOL_PRODUCTION === '1';
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertCanonicalJsonValue(value, path = '$') {
  if (value === null) return;
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Canonical JSON rejects non-finite number at ${path}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`Canonical JSON rejects unsafe or fractional number at ${path}`);
    }
    return;
  }
  if (typeof value === 'undefined') {
    throw new TypeError(`Canonical JSON rejects undefined at ${path}`);
  }
  if (typeof value === 'bigint') {
    throw new TypeError(`Canonical JSON rejects BigInt at ${path}`);
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Canonical JSON rejects ${typeof value} at ${path}`);
  }
  if (value instanceof Date) {
    throw new TypeError(`Canonical JSON rejects Date at ${path}`);
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError(`Canonical JSON rejects binary value at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCanonicalJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`Canonical JSON rejects non-plain object at ${path}`);
  }
  for (const [key, nested] of Object.entries(value)) {
    assertCanonicalJsonValue(nested, `${path}.${key}`);
  }
}

export function canonicalProofJson(value) {
  assertCanonicalJsonValue(value);

  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalProofJson(item)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalProofJson(value[key])}`).join(',')}}`;
}

function normalizeInteger(value, field, { nullable = false, defaultValue = undefined } = {}) {
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    if (nullable) return null;
  }
  if (value === null && nullable) return null;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  return value;
}

function normalizeOptionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

function normalizeRequiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertEnum(value, allowed, field) {
  if (!allowed.has(value)) {
    throw new TypeError(`${field} has unsupported value ${JSON.stringify(value)}`);
  }
  return value;
}

function assertNoForbiddenCallerFields(input) {
  for (const field of CALLER_FORBIDDEN_FIELDS) {
    if (Object.hasOwn(input, field)) {
      throw new TypeError(`${field} is computed by ProofLedger and cannot be supplied by callers`);
    }
  }
}

function sanitizePublicRefs(value, allowedKeys) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizePublicRefs(item, allowedKeys))
      .filter((item) => item !== undefined);
  }
  if (!isPlainObject(value)) return null;

  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!allowedKeys.has(key)) continue;
    const sanitized = sanitizePublicRefs(nested, allowedKeys);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

function loadOrCreateSigningKey({ keyPath, allowGenerateKey }) {
  const resolvedKeyPath = resolveKeyPath(keyPath);
  let privatePem;

  if (existsSync(resolvedKeyPath)) {
    privatePem = readFileSync(resolvedKeyPath, 'utf8');
  } else {
    if (!allowGenerateKey) {
      throw new Error(
        `Proof Ledger signing key is required at ${resolvedKeyPath}; ` +
        'set AOL_PROOF_LEDGER_KEY_PATH or provision the key before production start',
      );
    }
    mkdirSync(dirname(resolvedKeyPath), { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    writeFileSync(resolvedKeyPath, privatePem, { mode: 0o600 });
    chmodSync(resolvedKeyPath, 0o600);
  }

  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublicKey = Buffer.from(publicKeyDer).subarray(-32);
  const rawPublicKeyBase64Url = rawPublicKey.toString('base64url');
  const signingKeyId = `ed25519:${sha256Base64Url(rawPublicKey)}`;

  return {
    keyPath: resolvedKeyPath,
    privateKey,
    publicKey,
    publicKeyPem,
    rawPublicKeyBase64Url,
    signingKeyId,
  };
}

function parseJsonField(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeProofRow(row) {
  if (!row) return null;
  return {
    ...row,
    balance_snapshot_before: parseJsonField(row.balance_snapshot_before_json, null),
    balance_snapshot_after: parseJsonField(row.balance_snapshot_after_json, null),
    public_safe_refs: parseJsonField(row.public_safe_refs_json, null),
    issuer_domains: parseJsonField(row.issuer_domains_json, []),
    canonical_proof: parseJsonField(row.canonical_proof_json, null),
  };
}

function buildBalanceSnapshot({ scope, agentId, rawSums }) {
  const snapshot = {
    scope,
    agent_id: agentId || null,
    asset: 'BTC',
  };

  let totalTracked = 0;
  for (const [deltaField, balanceField] of BALANCE_FIELDS) {
    const value = Number(rawSums?.[deltaField] || 0);
    snapshot[balanceField] = value;
    totalTracked += value;
  }
  snapshot.total_tracked_sats = totalTracked;

  return snapshot;
}

function applyDeltasToSnapshot(snapshot, deltas) {
  const next = { ...snapshot };
  let totalTracked = 0;
  for (const [deltaField, balanceField] of BALANCE_FIELDS) {
    next[balanceField] = Number(next[balanceField] || 0) + Number(deltas[deltaField] || 0);
    totalTracked += next[balanceField];
  }
  next.total_tracked_sats = totalTracked;
  return next;
}

function normalizeReserveTotalsBySource(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) {
    throw new TypeError('reserveTotalsBySource must be an object or array');
  }
  return Object.entries(value).map(([sourceName, sourceValue]) => {
    if (typeof sourceValue === 'number') {
      return {
        reserve_source_name: sourceName,
        amount_sats: sourceValue,
      };
    }
    if (isPlainObject(sourceValue)) {
      return {
        reserve_source_name: sourceName,
        ...sourceValue,
      };
    }
    throw new TypeError('reserveTotalsBySource values must be integers or plain objects');
  });
}

function buildInsertSql() {
  const columns = [
    'global_sequence',
    'proof_id',
    'proof_group_id',
    'idempotency_key',
    'proof_record_type',
    'money_event_type',
    'money_event_status',
    'agent_id',
    'agent_proof_sequence',
    'event_source',
    'authorization_method',
    'primary_amount_sats',
    'gross_amount_sats',
    'fee_sats',
    'net_amount_sats',
    'asset',
    ...DELTA_FIELDS,
    'balance_snapshot_before_json',
    'balance_snapshot_after_json',
    'public_safe_refs_json',
    'visibility_scope',
    'issuer_domains_json',
    'signing_key_id',
    'canonicalization_version',
    'previous_global_proof_hash',
    'previous_agent_proof_hash',
    'proof_hash',
    'canonical_proof_json',
    'platform_signature',
    'created_at_ms',
  ];
  return `
    INSERT INTO proof_ledger (${columns.join(', ')})
    VALUES (${columns.map((column) => `@${column}`).join(', ')})
  `;
}

export class ProofLedger {
  constructor(options = {}) {
    this.dbPath = resolveDbPath(options.dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });

    const allowGenerateKey = options.allowGenerateKey ?? !isProductionRuntime();
    this.signing = loadOrCreateSigningKey({
      keyPath: options.keyPath,
      allowGenerateKey,
    });

    this.issuerDomains = Object.freeze([...(options.issuerDomains || PROOF_LEDGER_ISSUER_DOMAINS)]);
    canonicalProofJson(this.issuerDomains);

    this.db = options.db || new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA_SQL);

    this._appendLock = Promise.resolve();
    this._insert = this.db.prepare(buildInsertSql());
  }

  close() {
    this.db.close();
  }

  getPublicKeyInfo() {
    return {
      signing_key_id: this.signing.signingKeyId,
      public_key_pem: this.signing.publicKeyPem,
      public_key_raw_base64url: this.signing.rawPublicKeyBase64Url,
      issuer_domains: [...this.issuerDomains],
      canonicalization_version: PROOF_LEDGER_CANONICALIZATION_VERSION,
    };
  }

  async ensureGenesisProof() {
    if (this.getLatestGlobalProof()) {
      return null;
    }
    return this.createGenesisProof();
  }

  async createGenesisProof() {
    return this.appendProof({
      idempotency_key: GENESIS_IDEMPOTENCY_KEY,
      proof_record_type: 'genesis',
      money_event_type: 'proof_ledger_started',
      money_event_status: 'confirmed',
      event_source: 'proof_ledger',
      authorization_method: 'operator_adjustment',
      public_safe_refs: {
        note: GENESIS_NOTE,
        domains: [...this.issuerDomains],
      },
      allowed_public_ref_keys: ['note', 'domains'],
    });
  }

  async createLiabilityCheckpoint({ createdAtMs = Date.now() } = {}) {
    const latestGlobal = this.getLatestGlobalProof();
    const latestCheckpoint = this.getLatestProofByRecordType('liability_checkpoint');
    if (latestCheckpoint && latestGlobal?.proof_id === latestCheckpoint.proof_id) {
      return latestCheckpoint;
    }

    const liabilityTotals = this.getLiabilityTotals();
    const checkpointedSequence = Number(latestGlobal?.global_sequence || 0);
    const checkpointedHash = latestGlobal?.proof_hash || null;
    return this.appendProof({
      idempotency_key: `liability-checkpoint:${checkpointedSequence}:${checkpointedHash || 'empty'}`,
      proof_record_type: 'liability_checkpoint',
      money_event_type: 'liability_checkpoint_created',
      money_event_status: 'confirmed',
      event_source: 'proof_ledger',
      authorization_method: 'liability_checkpoint',
      primary_amount_sats: liabilityTotals.total_tracked_sats,
      public_safe_refs: {
        checkpointed_through_global_sequence: checkpointedSequence,
        checkpointed_global_proof_hash: checkpointedHash,
        checkpoint_created_at_ms: createdAtMs,
        liability_totals_by_bucket: liabilityTotals,
        total_liability_sats: liabilityTotals.total_tracked_sats,
        domains: [...this.issuerDomains],
      },
      created_at_ms: createdAtMs,
    });
  }

  async createReserveSnapshot({
    reserveTotalsBySource,
    reserveEvidenceRefs = [],
    reserveSufficient = null,
    createdAtMs = Date.now(),
  } = {}) {
    const normalizedReserveTotals = normalizeReserveTotalsBySource(reserveTotalsBySource);
    canonicalProofJson(normalizedReserveTotals);
    canonicalProofJson(reserveEvidenceRefs || []);
    if (reserveSufficient !== null && typeof reserveSufficient !== 'boolean') {
      throw new TypeError('reserveSufficient must be a boolean or null');
    }

    const latestGlobal = this.getLatestGlobalProof();
    const latestReserve = this.getLatestProofByRecordType('reserve_snapshot');
    if (
      latestReserve
      && latestGlobal?.proof_id === latestReserve.proof_id
      && canonicalProofJson(latestReserve.public_safe_refs?.reserve_totals_by_source || [])
        === canonicalProofJson(normalizedReserveTotals)
      && canonicalProofJson(latestReserve.public_safe_refs?.reserve_evidence_refs || [])
        === canonicalProofJson(reserveEvidenceRefs || [])
      && (latestReserve.public_safe_refs?.reserve_sufficient ?? null) === reserveSufficient
    ) {
      return latestReserve;
    }

    const checkpointedSequence = Number(latestGlobal?.global_sequence || 0);
    const checkpointedHash = latestGlobal?.proof_hash || null;
    const publicRefs = {
      checkpointed_through_global_sequence: checkpointedSequence,
      checkpointed_global_proof_hash: checkpointedHash,
      checkpoint_created_at_ms: createdAtMs,
      reserve_totals_by_source: normalizedReserveTotals,
      reserve_evidence_refs: reserveEvidenceRefs || [],
      total_reserve_sats: normalizedReserveTotals.reduce(
        (sum, entry) => sum + Number(entry.amount_sats || 0),
        0,
      ),
      reserve_sufficient: reserveSufficient,
      domains: [...this.issuerDomains],
    };
    const snapshotFingerprint = sha256Hex(canonicalProofJson(publicRefs));

    return this.appendProof({
      idempotency_key: `reserve-snapshot:${checkpointedSequence}:${snapshotFingerprint}`,
      proof_record_type: 'reserve_snapshot',
      money_event_type: 'reserve_snapshot_created',
      money_event_status: 'confirmed',
      event_source: 'proof_ledger',
      authorization_method: 'reserve_attestation',
      primary_amount_sats: publicRefs.total_reserve_sats,
      public_safe_refs: publicRefs,
      created_at_ms: createdAtMs,
    });
  }

  async createReconciliationProof({
    reconciliationStatus,
    reserveSufficient = null,
    createdAtMs = Date.now(),
  } = {}) {
    const normalizedStatus = normalizeRequiredString(reconciliationStatus, 'reconciliationStatus');
    if (reserveSufficient !== null && typeof reserveSufficient !== 'boolean') {
      throw new TypeError('reserveSufficient must be a boolean or null');
    }

    const latestGlobal = this.getLatestGlobalProof();
    const latestReconciliation = this.getLatestProofByRecordType('reconciliation');
    if (
      latestReconciliation
      && latestGlobal?.proof_id === latestReconciliation.proof_id
      && latestReconciliation.public_safe_refs?.reconciliation_status === normalizedStatus
      && (latestReconciliation.public_safe_refs?.reserve_sufficient ?? null) === reserveSufficient
    ) {
      return latestReconciliation;
    }

    const liabilityTotals = this.getLiabilityTotals();
    const latestReserve = this.getLatestProofByRecordType('reserve_snapshot');
    const checkpointedSequence = Number(latestGlobal?.global_sequence || 0);
    const checkpointedHash = latestGlobal?.proof_hash || null;
    const publicRefs = {
      checkpointed_through_global_sequence: checkpointedSequence,
      checkpointed_global_proof_hash: checkpointedHash,
      checkpoint_created_at_ms: createdAtMs,
      liability_totals_by_bucket: liabilityTotals,
      total_liability_sats: liabilityTotals.total_tracked_sats,
      reserve_totals_by_source: latestReserve?.public_safe_refs?.reserve_totals_by_source || null,
      reserve_evidence_refs: latestReserve?.public_safe_refs?.reserve_evidence_refs || [],
      total_reserve_sats: Number(latestReserve?.public_safe_refs?.total_reserve_sats || 0),
      reserve_sufficient: reserveSufficient,
      reconciliation_status: normalizedStatus,
      domains: [...this.issuerDomains],
    };
    const reconciliationFingerprint = sha256Hex(canonicalProofJson(publicRefs));

    return this.appendProof({
      idempotency_key: `reconciliation:${checkpointedSequence}:${reconciliationFingerprint}`,
      proof_record_type: 'reconciliation',
      money_event_type: 'reconciliation_completed',
      money_event_status: 'confirmed',
      event_source: 'proof_ledger',
      authorization_method: 'reserve_attestation',
      primary_amount_sats: publicRefs.total_liability_sats,
      public_safe_refs: publicRefs,
      created_at_ms: createdAtMs,
    });
  }

  async appendProof(input) {
    return this.appendProofGroup([input]).then((rows) => rows[0]);
  }

  async appendProofGroup(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new TypeError('appendProofGroup requires at least one proof input');
    }
    return this._withAppendLock(() => this._appendProofGroupLocked(inputs));
  }

  async _withAppendLock(work) {
    const previous = this._appendLock;
    let release;
    this._appendLock = new Promise((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return work();
    } finally {
      release();
    }
  }

  _appendProofGroupLocked(inputs) {
    const transaction = this.db.transaction((proofInputs) => {
      const normalizedInputs = proofInputs.map((input) => this._normalizeAppendInput(input));
      const existing = normalizedInputs
        .map((input) => this.getProofByIdempotencyKey(input.idempotency_key))
        .filter(Boolean);

      if (existing.length === normalizedInputs.length) {
        return existing;
      }
      if (existing.length > 0) {
        throw new Error('PROOF_GROUP_IDEMPOTENCY_CONFLICT');
      }

      const rows = [];
      for (const input of normalizedInputs) {
        rows.push(this._insertOne(input));
      }
      return rows;
    });

    return transaction(inputs);
  }

  _normalizeAppendInput(input) {
    if (!isPlainObject(input)) {
      throw new TypeError('Proof append input must be a plain object');
    }
    assertNoForbiddenCallerFields(input);

    const proofRecordType = assertEnum(
      normalizeRequiredString(input.proof_record_type, 'proof_record_type'),
      PROOF_RECORD_TYPE_SET,
      'proof_record_type',
    );
    const moneyEventType = normalizeRequiredString(input.money_event_type, 'money_event_type');
    if (!MONEY_EVENT_TYPE_SET.has(moneyEventType)) {
      throw new TypeError(`money_event_type has unsupported value ${JSON.stringify(moneyEventType)}`);
    }

    const deltas = {};
    for (const field of DELTA_FIELDS) {
      deltas[field] = normalizeInteger(input[field], field, { defaultValue: 0 });
    }

    const allowedRefKeys = new Set([
      ...DEFAULT_PUBLIC_SAFE_REF_KEYS,
      ...(Array.isArray(input.allowed_public_ref_keys) ? input.allowed_public_ref_keys : []),
    ]);
    const publicSafeRefs = sanitizePublicRefs(input.public_safe_refs || {}, allowedRefKeys) || {};
    canonicalProofJson(publicSafeRefs);

    const normalized = {
      proof_id: normalizeOptionalString(input.proof_id, 'proof_id'),
      proof_group_id: normalizeOptionalString(input.proof_group_id, 'proof_group_id'),
      idempotency_key: normalizeRequiredString(input.idempotency_key, 'idempotency_key'),
      proof_record_type: proofRecordType,
      money_event_type: moneyEventType,
      money_event_status: assertEnum(
        normalizeRequiredString(input.money_event_status, 'money_event_status'),
        MONEY_EVENT_STATUS_SET,
        'money_event_status',
      ),
      agent_id: normalizeOptionalString(input.agent_id, 'agent_id'),
      event_source: normalizeRequiredString(input.event_source, 'event_source'),
      authorization_method: assertEnum(
        normalizeRequiredString(input.authorization_method, 'authorization_method'),
        AUTHORIZATION_METHOD_SET,
        'authorization_method',
      ),
      primary_amount_sats: normalizeInteger(input.primary_amount_sats, 'primary_amount_sats', { nullable: true }),
      gross_amount_sats: normalizeInteger(input.gross_amount_sats, 'gross_amount_sats', { nullable: true }),
      fee_sats: normalizeInteger(input.fee_sats, 'fee_sats', { nullable: true }),
      net_amount_sats: normalizeInteger(input.net_amount_sats, 'net_amount_sats', { nullable: true }),
      asset: input.asset === undefined ? 'BTC' : normalizeRequiredString(input.asset, 'asset'),
      visibility_scope: assertEnum(
        input.visibility_scope === undefined ? 'public' : normalizeRequiredString(input.visibility_scope, 'visibility_scope'),
        VISIBILITY_SCOPE_SET,
        'visibility_scope',
      ),
      public_safe_refs: publicSafeRefs,
      created_at_ms: normalizeInteger(input.created_at_ms, 'created_at_ms', { defaultValue: Date.now() }),
      ...deltas,
    };

    return normalized;
  }

  _insertOne(input) {
    const latestGlobal = this.getLatestGlobalProof();
    const latestAgent = input.agent_id ? this.getLatestAgentProof(input.agent_id) : null;
    const globalSequence = Number(latestGlobal?.global_sequence || 0) + 1;
    const agentProofSequence = input.agent_id
      ? Number(latestAgent?.agent_proof_sequence || 0) + 1
      : null;

    const before = input.agent_id
      ? this.getAgentBalance(input.agent_id)
      : this.getLiabilityTotals();
    const after = applyDeltasToSnapshot(before, input);

    const baseRow = {
      global_sequence: globalSequence,
      proof_id: input.proof_id || `proof-${globalSequence}-${sha256Hex(`${input.idempotency_key}:${input.created_at_ms}`).slice(0, 16)}`,
      proof_group_id: input.proof_group_id,
      idempotency_key: input.idempotency_key,
      proof_record_type: input.proof_record_type,
      money_event_type: input.money_event_type,
      money_event_status: input.money_event_status,
      agent_id: input.agent_id,
      agent_proof_sequence: agentProofSequence,
      event_source: input.event_source,
      authorization_method: input.authorization_method,
      primary_amount_sats: input.primary_amount_sats,
      gross_amount_sats: input.gross_amount_sats,
      fee_sats: input.fee_sats,
      net_amount_sats: input.net_amount_sats,
      asset: input.asset,
      wallet_ecash_delta_sats: input.wallet_ecash_delta_sats,
      wallet_hub_delta_sats: input.wallet_hub_delta_sats,
      capital_available_delta_sats: input.capital_available_delta_sats,
      capital_locked_delta_sats: input.capital_locked_delta_sats,
      capital_pending_deposit_delta_sats: input.capital_pending_deposit_delta_sats,
      capital_pending_close_delta_sats: input.capital_pending_close_delta_sats,
      capital_service_spent_delta_sats: input.capital_service_spent_delta_sats,
      routing_pnl_delta_sats: input.routing_pnl_delta_sats,
      balance_snapshot_before_json: canonicalProofJson(before),
      balance_snapshot_after_json: canonicalProofJson(after),
      public_safe_refs_json: canonicalProofJson(input.public_safe_refs),
      visibility_scope: input.visibility_scope,
      issuer_domains_json: canonicalProofJson([...this.issuerDomains]),
      signing_key_id: this.signing.signingKeyId,
      canonicalization_version: PROOF_LEDGER_CANONICALIZATION_VERSION,
      previous_global_proof_hash: latestGlobal?.proof_hash || null,
      previous_agent_proof_hash: latestAgent?.proof_hash || null,
      created_at_ms: input.created_at_ms,
    };

    const canonicalPayload = this.buildCanonicalPayload(baseRow);
    const canonicalJson = canonicalProofJson(canonicalPayload);
    const proofHash = sha256Hex(canonicalJson);
    const signature = signData(null, Buffer.from(canonicalJson, 'utf8'), this.signing.privateKey).toString('base64url');

    const row = {
      ...baseRow,
      proof_hash: proofHash,
      canonical_proof_json: canonicalJson,
      platform_signature: signature,
    };
    this._insert.run(row);
    return normalizeProofRow(row);
  }

  buildCanonicalPayload(row) {
    const {
      proof_hash: _proofHash,
      canonical_proof_json: _canonicalProofJson,
      platform_signature: _platformSignature,
      balance_snapshot_before: _balanceSnapshotBefore,
      balance_snapshot_after: _balanceSnapshotAfter,
      public_safe_refs: _publicSafeRefs,
      issuer_domains: _issuerDomains,
      canonical_proof: _canonicalProof,
      ...payload
    } = row;
    return payload;
  }

  getLatestGlobalProof() {
    return normalizeProofRow(
      this.db.prepare('SELECT * FROM proof_ledger ORDER BY global_sequence DESC LIMIT 1').get(),
    );
  }

  getLatestAgentProof(agentId) {
    return normalizeProofRow(
      this.db
        .prepare('SELECT * FROM proof_ledger WHERE agent_id = ? ORDER BY agent_proof_sequence DESC LIMIT 1')
        .get(agentId),
    );
  }

  getLatestProofByRecordType(proofRecordType) {
    return normalizeProofRow(
      this.db
        .prepare('SELECT * FROM proof_ledger WHERE proof_record_type = ? ORDER BY global_sequence DESC LIMIT 1')
        .get(proofRecordType),
    );
  }

  getProofById(proofId) {
    return normalizeProofRow(
      this.db.prepare('SELECT * FROM proof_ledger WHERE proof_id = ?').get(proofId),
    );
  }

  getProofByHash(proofHash) {
    return normalizeProofRow(
      this.db.prepare('SELECT * FROM proof_ledger WHERE proof_hash = ?').get(proofHash),
    );
  }

  getProofByIdempotencyKey(idempotencyKey) {
    return normalizeProofRow(
      this.db.prepare('SELECT * FROM proof_ledger WHERE idempotency_key = ?').get(idempotencyKey),
    );
  }

  buildProofBundle(proofId, { agentId = null } = {}) {
    const proof = this.getProofById(proofId);
    if (!proof) return null;
    if (agentId && proof.agent_id !== agentId) return null;
    return {
      bundle_version: 'aol-proof-bundle-v1',
      source_of_truth: 'proof_ledger',
      proof,
      previous_global_proof: proof.previous_global_proof_hash
        ? this.getProofByHash(proof.previous_global_proof_hash)
        : null,
      previous_agent_proof: proof.previous_agent_proof_hash
        ? this.getProofByHash(proof.previous_agent_proof_hash)
        : null,
      latest_global_proof: this.getLatestGlobalProof(),
      latest_agent_proof: proof.agent_id ? this.getLatestAgentProof(proof.agent_id) : null,
      latest_liability_checkpoint: this.getLatestProofByRecordType('liability_checkpoint'),
      latest_reserve_snapshot: this.getLatestProofByRecordType('reserve_snapshot'),
      public_key: this.getPublicKeyInfo(),
      verification: this.verifyProof(proof),
      global_chain: this.verifyChain(),
      agent_chain: proof.agent_id ? this.verifyChain({ agentId: proof.agent_id }) : null,
      instructions: [
        'Recompute canonical_proof_json from the proof row fields except proof_hash, canonical_proof_json, and platform_signature.',
        'Hash canonical_proof_json with SHA-256 and compare it to proof_hash.',
        'Verify platform_signature with the published Ed25519 public key.',
        'Check previous_global_proof_hash and previous_agent_proof_hash against the included prior proofs.',
        'Recompute balances from deltas if you need independent liability verification.',
      ],
    };
  }

  listProofs({ limit = 100, offset = 0, agentId = null } = {}) {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 100), 1000);
    const safeOffset = Math.max(0, Number(offset) || 0);
    if (agentId) {
      return this.db
        .prepare('SELECT * FROM proof_ledger WHERE agent_id = ? ORDER BY global_sequence DESC LIMIT ? OFFSET ?')
        .all(agentId, safeLimit, safeOffset)
        .map(normalizeProofRow);
    }
    return this.db
      .prepare('SELECT * FROM proof_ledger ORDER BY global_sequence DESC LIMIT ? OFFSET ?')
      .all(safeLimit, safeOffset)
      .map(normalizeProofRow);
  }

  countProofs({ agentId = null, moneyEventType = null, proofRecordType = null } = {}) {
    const clauses = [];
    const params = [];
    if (agentId) {
      clauses.push('agent_id = ?');
      params.push(agentId);
    }
    if (moneyEventType) {
      clauses.push('money_event_type = ?');
      params.push(moneyEventType);
    }
    if (proofRecordType) {
      clauses.push('proof_record_type = ?');
      params.push(proofRecordType);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return Number(this.db.prepare(`SELECT COUNT(*) AS total FROM proof_ledger ${where}`).get(...params)?.total || 0);
  }

  listAgentIds() {
    return this.db
      .prepare('SELECT DISTINCT agent_id FROM proof_ledger WHERE agent_id IS NOT NULL ORDER BY agent_id ASC')
      .all()
      .map((row) => row.agent_id);
  }

  getAgentBalance(agentId) {
    const select = this.db.prepare(`
      SELECT
        COALESCE(SUM(wallet_ecash_delta_sats), 0) AS wallet_ecash_delta_sats,
        COALESCE(SUM(wallet_hub_delta_sats), 0) AS wallet_hub_delta_sats,
        COALESCE(SUM(capital_available_delta_sats), 0) AS capital_available_delta_sats,
        COALESCE(SUM(capital_locked_delta_sats), 0) AS capital_locked_delta_sats,
        COALESCE(SUM(capital_pending_deposit_delta_sats), 0) AS capital_pending_deposit_delta_sats,
        COALESCE(SUM(capital_pending_close_delta_sats), 0) AS capital_pending_close_delta_sats,
        COALESCE(SUM(capital_service_spent_delta_sats), 0) AS capital_service_spent_delta_sats,
        COALESCE(SUM(routing_pnl_delta_sats), 0) AS routing_pnl_delta_sats
      FROM proof_ledger
      WHERE agent_id = ?
    `);
    return buildBalanceSnapshot({
      scope: 'agent',
      agentId,
      rawSums: select.get(agentId),
    });
  }

  getLiabilityTotals() {
    const select = this.db.prepare(`
      SELECT
        COALESCE(SUM(wallet_ecash_delta_sats), 0) AS wallet_ecash_delta_sats,
        COALESCE(SUM(wallet_hub_delta_sats), 0) AS wallet_hub_delta_sats,
        COALESCE(SUM(capital_available_delta_sats), 0) AS capital_available_delta_sats,
        COALESCE(SUM(capital_locked_delta_sats), 0) AS capital_locked_delta_sats,
        COALESCE(SUM(capital_pending_deposit_delta_sats), 0) AS capital_pending_deposit_delta_sats,
        COALESCE(SUM(capital_pending_close_delta_sats), 0) AS capital_pending_close_delta_sats,
        COALESCE(SUM(capital_service_spent_delta_sats), 0) AS capital_service_spent_delta_sats,
        COALESCE(SUM(routing_pnl_delta_sats), 0) AS routing_pnl_delta_sats
      FROM proof_ledger
      WHERE agent_id IS NOT NULL
    `);
    return buildBalanceSnapshot({
      scope: 'platform_liabilities',
      agentId: null,
      rawSums: select.get(),
    });
  }

  getCapitalBalance(agentId) {
    const balance = this.getAgentBalance(agentId);
    const totals = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN money_event_type IN (
          'capital_deposit_pending',
          'lightning_capital_onchain_pending'
        ) THEN COALESCE(primary_amount_sats, 0) ELSE 0 END), 0) AS total_deposited,
        COALESCE(SUM(CASE WHEN money_event_type = 'capital_withdrawal_debited'
          THEN COALESCE(primary_amount_sats, 0)
          WHEN money_event_type = 'swap_direct_payout_debited'
          THEN COALESCE(primary_amount_sats, 0)
          WHEN money_event_type IN ('capital_withdrawal_refunded', 'swap_failed_refunded')
          THEN -COALESCE(primary_amount_sats, 0)
          ELSE 0 END), 0) AS total_withdrawn,
        COALESCE(SUM(CASE WHEN money_event_type = 'routing_revenue_credited'
          THEN COALESCE(primary_amount_sats, 0) ELSE 0 END), 0) AS total_revenue_credited,
        COALESCE(SUM(CASE WHEN money_event_type = 'capital_ecash_funding_credited'
          THEN COALESCE(primary_amount_sats, 0) ELSE 0 END), 0) AS total_ecash_funded
      FROM proof_ledger
      WHERE agent_id = ?
    `).get(agentId);

    return {
      available: balance.capital_available_sats,
      locked: balance.capital_locked_sats,
      pending_deposit: balance.capital_pending_deposit_sats,
      pending_close: balance.capital_pending_close_sats,
      total_deposited: Number(totals?.total_deposited || 0),
      total_withdrawn: Number(totals?.total_withdrawn || 0),
      total_revenue_credited: Number(totals?.total_revenue_credited || 0),
      total_ecash_funded: Number(totals?.total_ecash_funded || 0),
      total_service_spent: balance.capital_service_spent_sats,
      total_routing_pnl: balance.routing_pnl_sats,
      source_of_truth: 'proof_ledger',
    };
  }

  getAllCapitalBalances() {
    const results = {};
    for (const agentId of this.listAgentIds()) {
      results[agentId] = this.getCapitalBalance(agentId);
    }
    return results;
  }

  listCapitalActivity({ agentId = null, limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 1000);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const placeholders = CAPITAL_ACTIVITY_EVENT_TYPES.map(() => '?').join(', ');
    const params = [...CAPITAL_ACTIVITY_EVENT_TYPES];
    const clauses = [`money_event_type IN (${placeholders})`];
    if (agentId) {
      clauses.push('agent_id = ?');
      params.push(agentId);
    }
    params.push(safeLimit, safeOffset);

    return this.db
      .prepare(`
        SELECT *
        FROM proof_ledger
        WHERE ${clauses.join(' AND ')}
        ORDER BY global_sequence DESC
        LIMIT ?
        OFFSET ?
      `)
      .all(...params)
      .map(normalizeProofRow);
  }

  countCapitalActivity({ agentId = null } = {}) {
    const placeholders = CAPITAL_ACTIVITY_EVENT_TYPES.map(() => '?').join(', ');
    const params = [...CAPITAL_ACTIVITY_EVENT_TYPES];
    const clauses = [`money_event_type IN (${placeholders})`];
    if (agentId) {
      clauses.push('agent_id = ?');
      params.push(agentId);
    }

    return Number(this.db
      .prepare(`
        SELECT COUNT(*) AS total
        FROM proof_ledger
        WHERE ${clauses.join(' AND ')}
      `)
      .get(...params)?.total || 0);
  }

  verifyProof(rowOrProofId) {
    const row = typeof rowOrProofId === 'string' ? this.getProofById(rowOrProofId) : normalizeProofRow(rowOrProofId);
    if (!row) {
      return { valid: false, errors: ['proof not found'] };
    }

    const errors = [];
    let canonicalJson;
    try {
      canonicalJson = canonicalProofJson(this.buildCanonicalPayload(row));
    } catch (err) {
      errors.push(`canonicalization failed: ${err.message}`);
    }

    if (canonicalJson && canonicalJson !== row.canonical_proof_json) {
      errors.push('canonical_proof_json mismatch');
    }

    if (canonicalJson) {
      const proofHash = sha256Hex(canonicalJson);
      if (proofHash !== row.proof_hash) {
        errors.push('proof_hash mismatch');
      }

      const signature = Buffer.from(row.platform_signature, 'base64url');
      const signatureValid = verifyData(
        null,
        Buffer.from(canonicalJson, 'utf8'),
        this.signing.publicKey,
        signature,
      );
      if (!signatureValid) {
        errors.push('platform_signature invalid');
      }
    }

    return {
      valid: errors.length === 0,
      proof_id: row.proof_id,
      proof_hash: row.proof_hash,
      errors,
    };
  }

  verifyChain({ agentId = null } = {}) {
    const rows = agentId
      ? this.db
        .prepare('SELECT * FROM proof_ledger WHERE agent_id = ? ORDER BY agent_proof_sequence ASC')
        .all(agentId)
      : this.db
        .prepare('SELECT * FROM proof_ledger ORDER BY global_sequence ASC')
        .all();

    const errors = [];
    let previousHash = null;
    let expectedSequence = agentId ? 1 : 1;

    for (const rawRow of rows) {
      const row = normalizeProofRow(rawRow);
      const proofCheck = this.verifyProof(row);
      if (!proofCheck.valid) {
        errors.push({ proof_id: row.proof_id, errors: proofCheck.errors });
      }

      const actualSequence = agentId ? row.agent_proof_sequence : row.global_sequence;
      if (actualSequence !== expectedSequence) {
        errors.push({
          proof_id: row.proof_id,
          issue: agentId ? 'agent_proof_sequence mismatch' : 'global_sequence mismatch',
          expected: expectedSequence,
          actual: actualSequence,
        });
      }

      const linkField = agentId ? row.previous_agent_proof_hash : row.previous_global_proof_hash;
      if (linkField !== previousHash) {
        errors.push({
          proof_id: row.proof_id,
          issue: agentId ? 'previous_agent_proof_hash mismatch' : 'previous_global_proof_hash mismatch',
          expected: previousHash,
          actual: linkField,
        });
      }

      previousHash = row.proof_hash;
      expectedSequence += 1;
    }

    return {
      valid: errors.length === 0,
      checked: rows.length,
      agent_id: agentId,
      latest_hash: previousHash,
      errors,
    };
  }
}

export function isKnownMoneyEventType(moneyEventType) {
  return MONEY_EVENT_TYPE_SET.has(moneyEventType);
}
