/**
 * Paid Analytics Gateway — Channel Market Plan K
 *
 * Manages the full lifecycle of paid ClickHouse analytics queries:
 *   1. Agent browses the query catalog (getCatalog)
 *   2. Agent requests a quote for a specific query (getQuote)
 *   3. Agent executes the query — Cashu ecash is debited atomically,
 *      Python child process runs the ClickHouse query, result returned (execute)
 *   4. If the Python process fails after payment, ecash is refunded automatically
 *
 * Architecture: Express (auth + payment + rate limiting) spawns Python scripts
 * as child processes. No separate FastAPI service, no new port, no new plist.
 *
 * The Python entry point is ln_research/analytics_api/run_query.py which
 * routes to per-query modules in ln_research/analytics_api/queries/.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire } from '../identity/mutex.js';
import { logWalletOperation } from '../identity/audit-log.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to the Python query runner
const ANALYTICS_SCRIPT_DIR = resolve(__dirname, '..', '..', '..', 'ln_research', 'analytics_api');
const RUN_QUERY_SCRIPT = resolve(ANALYTICS_SCRIPT_DIR, 'run_query.py');

// Use Homebrew python3 — launchd PATH only has /usr/bin which lacks pip packages
const PYTHON3 = '/opt/homebrew/bin/python3';

// Concurrency: max 3 concurrent analytics Python processes
const MAX_CONCURRENT_QUERIES = 3;

// Timeout for Python child processes (30 seconds)
const QUERY_TIMEOUT_MS = 30_000;

// Max stdout buffer (5 MB — analytics results can be large)
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Query Catalog — the 7 pre-built parameterized queries
// ---------------------------------------------------------------------------

const QUERY_CATALOG = [
  {
    query_id: 'node_profile',
    description: 'Full node profile with capacity, channels, fee policies, network type, and OSINT intelligence.',
    parameters: [
      { name: 'pubkey', type: 'string', required: true, description: '33-byte hex compressed public key of the node' },
    ],
    price_sats: 1,
    learn: 'A node profile reveals the full public identity of a Lightning node — its capacity, channel count, fee policies, network type (clearnet/tor/hybrid), and any OSINT intelligence gathered from 16+ sources. Use this to evaluate a potential peer before opening a channel.',
  },
  {
    query_id: 'peer_candidates',
    description: 'Top peer candidates ranked by routing potential for a given budget. Uses capacity, connectivity, fee competitiveness, and uptime.',
    parameters: [
      { name: 'budget_sats', type: 'integer', required: true, description: 'Channel open budget in satoshis (min 20000)' },
      { name: 'limit', type: 'integer', required: false, description: 'Max results to return (default 20, max 100)' },
    ],
    price_sats: 10,
    learn: 'Peer candidates are ranked by a composite score of routing potential: how many payments might flow through a channel to this peer, based on their connectivity, fee competitiveness, uptime, and position in the network graph. Higher scores mean more routing revenue potential.',
  },
  {
    query_id: 'fee_landscape',
    description: 'Fee rates for all channels connected to a specific node. Shows the competitive fee environment around a peer.',
    parameters: [
      { name: 'peer_pubkey', type: 'string', required: true, description: '33-byte hex compressed public key of the peer node' },
    ],
    price_sats: 5,
    learn: 'The fee landscape shows every channel connected to a node and what fees they charge. If you open a channel to this peer, you will be competing with these fee rates for routing traffic. Set your fees competitively relative to this landscape.',
  },
  {
    query_id: 'network_stats',
    description: 'Network-wide aggregates: total nodes, channels, capacity, average fees, event velocity, and growth trends.',
    parameters: [],
    price_sats: 1,
    learn: 'Network stats give you the macro view of the Lightning Network — total capacity locked in channels, number of active nodes, average fee rates, and recent growth trends. Use this to calibrate your channel strategy against the overall market.',
  },
  {
    query_id: 'channel_history',
    description: 'Open/close history and fee update timeline for a specific channel identified by channel point.',
    parameters: [
      { name: 'channel_point', type: 'string', required: true, description: 'Channel funding outpoint (txid:vout format)' },
    ],
    price_sats: 5,
    learn: 'Channel history shows the full lifecycle of a channel: when it was opened, every fee policy update, any disable/enable toggles, and when (if) it was closed. Force closes are marked separately. Use this to evaluate the stability and management quality of a peer\'s channels.',
  },
  {
    query_id: 'routing_demand',
    description: 'Estimated routing demand between two nodes based on historical forwarding patterns and network topology.',
    parameters: [
      { name: 'source_pubkey', type: 'string', required: true, description: 'Source node public key' },
      { name: 'dest_pubkey', type: 'string', required: true, description: 'Destination node public key' },
    ],
    price_sats: 20,
    learn: 'Routing demand estimates how many payments are likely to flow between two nodes based on their positions in the network graph, historical forwarding patterns through nearby channels, and payment corridor analysis. Higher demand = more potential routing revenue if you position yourself on the path.',
  },
  {
    query_id: 'node_reliability',
    description: 'Uptime estimate, channel disable/enable flap rate, force-close history, and stability score for a node.',
    parameters: [
      { name: 'pubkey', type: 'string', required: true, description: '33-byte hex compressed public key of the node' },
    ],
    price_sats: 10,
    learn: 'Node reliability measures how stable a peer is: uptime (estimated from channel enable/disable events), flap rate (how often their channels toggle), force-close count, and average channel lifespan. Unreliable peers waste your capital in force-closed channels and route fewer payments.',
  },
];

// Index for fast lookup
const _catalogIndex = new Map(QUERY_CATALOG.map(q => [q.query_id, q]));

// ---------------------------------------------------------------------------
// AnalyticsGateway class
// ---------------------------------------------------------------------------

export class AnalyticsGateway {
  /**
   * @param {object} opts
   * @param {import('../wallet/agent-cashu-wallet-operations.js').AgentCashuWalletOperations} opts.walletOps
   * @param {import('../data-layer.js').DataLayer} opts.dataLayer
   * @param {import('../wallet/ledger.js').PublicLedger} opts.ledger
   */
  constructor({ walletOps, dataLayer, ledger }) {
    this._walletOps = walletOps;
    this._dataLayer = dataLayer;
    this._ledger = ledger;
    this._activeQueries = 0;
    this._totalExecuted = 0;
    this._totalRevenueSats = 0;
    this._historyPath = 'data/analytics/query-history.jsonl';
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return the full query catalog with descriptions, parameters, and pricing.
   */
  getCatalog() {
    return {
      queries: QUERY_CATALOG.map(q => ({
        query_id: q.query_id,
        description: q.description,
        parameters: q.parameters,
        price_sats: q.price_sats,
      })),
      payment_method: 'Cashu ecash (automatically debited from your wallet balance)',
      pricing_ethos: 'Transparent, deterministic pricing. Same query always costs the same. No hidden fees.',
    };
  }

  /**
   * Get a price quote for a specific query. Validates parameters.
   * Returns the exact price that will be charged.
   *
   * @param {string} queryId - One of the catalog query IDs
   * @param {object} params - Query-specific parameters
   * @returns {{ query_id, price_sats, parameters_valid, description }}
   */
  getQuote(queryId, params = {}) {
    const query = _catalogIndex.get(queryId);
    if (!query) {
      const err = new Error(`Unknown query_id: ${queryId}. Use GET /api/v1/analytics/catalog to see available queries.`);
      err.statusCode = 400;
      throw err;
    }

    // Validate required parameters
    const validationErrors = this._validateParams(query, params);
    if (validationErrors.length > 0) {
      const err = new Error(`Parameter validation failed: ${validationErrors.join('; ')}`);
      err.statusCode = 400;
      err.validation_errors = validationErrors;
      throw err;
    }

    return {
      query_id: query.query_id,
      description: query.description,
      price_sats: query.price_sats,
      parameters_valid: true,
      parameters: params,
      learn: 'This quote is valid immediately. Call POST /api/v1/analytics/execute with the same query_id and params to run it. Your Cashu wallet will be debited exactly the quoted amount.',
    };
  }

  /**
   * Execute a paid analytics query.
   *
   * Payment atomicity:
   *   1. Validate params
   *   2. Check balance sufficient
   *   3. Debit Cashu wallet (sendEcash — creates an internal token)
   *   4. Spawn Python child process
   *   5. If Python fails → refund by receiving the token back
   *   6. If Python succeeds → log to ledger, return results
   *
   * @param {string} agentId - Authenticated agent ID
   * @param {string} queryId - Query catalog ID
   * @param {object} params - Query parameters
   * @returns {{ query_id, price_sats, results, learn, execution_ms }}
   */
  async execute(agentId, queryId, params = {}) {
    const query = _catalogIndex.get(queryId);
    if (!query) {
      const err = new Error(`Unknown query_id: ${queryId}. Use GET /api/v1/analytics/catalog to see available queries.`);
      err.statusCode = 400;
      throw err;
    }

    // Validate parameters
    const validationErrors = this._validateParams(query, params);
    if (validationErrors.length > 0) {
      const err = new Error(`Parameter validation failed: ${validationErrors.join('; ')}`);
      err.statusCode = 400;
      err.validation_errors = validationErrors;
      throw err;
    }

    // Check concurrency limit
    if (this._activeQueries >= MAX_CONCURRENT_QUERIES) {
      const err = new Error('Analytics service busy. Maximum concurrent queries reached. Try again in a few seconds.');
      err.statusCode = 503;
      throw err;
    }

    // Per-agent mutex: prevents double-spend race on balance check + debit
    const unlock = await acquire(`analytics:${agentId}`);
    try {
      // Check wallet balance before attempting debit
      const balance = await this._walletOps.getBalance(agentId);
      if (balance < query.price_sats) {
        const err = new Error(
          `Insufficient balance. Query costs ${query.price_sats} sats, your balance is ${balance} sats. ` +
          `Deposit more ecash via POST /api/v1/wallet/mint/quote.`
        );
        err.statusCode = 402;
        throw err;
      }

      // Debit Cashu wallet — creates an internal ecash token
      let paymentToken = null;
      try {
        const sendResult = await this._walletOps.sendEcash(agentId, query.price_sats);
        paymentToken = sendResult.token;
      } catch (err) {
        // Payment failed — agent does not pay
        const wrapped = new Error(`Payment failed: ${err.message}`);
        wrapped.statusCode = 402;
        throw wrapped;
      }

      // Reserve concurrency slot synchronously before any await
      this._activeQueries++;
      const t0 = Date.now();

      try {
        const results = await this._spawnQuery(queryId, params);
        const executionMs = Date.now() - t0;

        // Payment succeeded, query succeeded — record in ledger
        this._totalExecuted++;
        this._totalRevenueSats += query.price_sats;

        await this._ledger.record({
          type: 'analytics_query',
          agent_id: agentId,
          amount_sats: query.price_sats,
          query_id: queryId,
          execution_ms: executionMs,
        });

        // Log to query history
        await this._logQuery(agentId, queryId, params, query.price_sats, executionMs, true);

        logWalletOperation(agentId, 'analytics_query', query.price_sats, true);

        return {
          query_id: queryId,
          price_sats: query.price_sats,
          results,
          execution_ms: executionMs,
          learn: query.learn,
        };
      } catch (queryErr) {
        const executionMs = Date.now() - t0;

        // Query failed after payment — REFUND
        let refundSuccess = false;
        try {
          await this._walletOps.receiveEcash(agentId, paymentToken);
          refundSuccess = true;
          logWalletOperation(agentId, 'analytics_refund', query.price_sats, true);
        } catch (refundErr) {
          console.error(
            `[AnalyticsGateway] CRITICAL: Refund failed for agent ${agentId}, ` +
            `query ${queryId}, amount ${query.price_sats} sats. ` +
            `Token: ${paymentToken?.slice(0, 40)}... Error: ${refundErr.message}`
          );
          logWalletOperation(agentId, 'analytics_refund', query.price_sats, false);
        }

        // Log failed query
        await this._logQuery(agentId, queryId, params, 0, executionMs, false, queryErr.message);

        const msg = refundSuccess
          ? `Query execution failed (payment refunded): ${queryErr.message}`
          : `Query execution failed. REFUND FAILED — ${query.price_sats} sats may be lost. Contact support. Error: ${queryErr.message}`;
        const wrapped = new Error(msg);
        wrapped.statusCode = queryErr.message.includes('timed out') ? 504 : 503;
        wrapped.refunded = refundSuccess;
        throw wrapped;
      } finally {
        this._activeQueries--;
      }
    } finally {
      unlock();
    }
  }

  /**
   * Get query execution history for an agent.
   *
   * @param {string} agentId
   * @param {{ limit?: number, since?: number }} opts
   * @returns {{ queries: object[], total: number }}
   */
  async getHistory(agentId, opts = {}) {
    const limit = Math.min(opts.limit || 50, 500);
    let entries;
    try {
      entries = await this._dataLayer.readLog(this._historyPath, opts.since);
    } catch {
      return { queries: [], total: 0 };
    }

    // Filter to this agent
    entries = entries.filter(e => e.agent_id === agentId);
    const total = entries.length;

    // Sort newest first, apply limit
    entries.sort((a, b) => (b._ts || 0) - (a._ts || 0));
    entries = entries.slice(0, limit);

    return { queries: entries, total };
  }

  /**
   * Get gateway operational status.
   */
  getStatus() {
    return {
      active_queries: this._activeQueries,
      max_concurrent: MAX_CONCURRENT_QUERIES,
      total_executed: this._totalExecuted,
      total_revenue_sats: this._totalRevenueSats,
      catalog_size: QUERY_CATALOG.length,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Validate query parameters against the catalog definition.
   * Returns array of error strings (empty = valid).
   */
  _validateParams(query, params) {
    const errors = [];

    for (const paramDef of query.parameters) {
      const value = params[paramDef.name];

      // Check required
      if (paramDef.required && (value === undefined || value === null || value === '')) {
        errors.push(`Missing required parameter: ${paramDef.name}`);
        continue;
      }

      if (value === undefined || value === null) continue;

      // Type validation
      switch (paramDef.type) {
        case 'string':
          if (typeof value !== 'string') {
            errors.push(`${paramDef.name} must be a string`);
          } else if (paramDef.name.includes('pubkey')) {
            // Pubkey validation: 66 hex chars
            if (!/^[0-9a-fA-F]{66}$/.test(value)) {
              errors.push(`${paramDef.name} must be a 66-character hex public key`);
            }
          } else if (paramDef.name === 'channel_point') {
            // channel_point: txid:vout
            if (!/^[0-9a-fA-F]{64}:\d+$/.test(value)) {
              errors.push(`${paramDef.name} must be in txid:vout format (64 hex chars : number)`);
            }
          }
          break;

        case 'integer': {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed < 0) {
            errors.push(`${paramDef.name} must be a non-negative integer`);
          }
          // Budget minimum
          if (paramDef.name === 'budget_sats' && parsed < 20000) {
            errors.push(`${paramDef.name} must be at least 20000 sats`);
          }
          // Limit maximum
          if (paramDef.name === 'limit' && parsed > 100) {
            errors.push(`${paramDef.name} must be at most 100`);
          }
          break;
        }
      }
    }

    // Reject unknown parameters (defense against injection via extra params)
    const knownNames = new Set(query.parameters.map(p => p.name));
    for (const key of Object.keys(params)) {
      if (!knownNames.has(key)) {
        errors.push(`Unknown parameter: ${key}`);
      }
    }

    return errors;
  }

  /**
   * Spawn Python child process to execute a query.
   * Passes query_id and params as CLI arguments (no shell interpolation).
   *
   * @param {string} queryId
   * @param {object} params
   * @returns {object} Parsed JSON result from Python stdout
   */
  async _spawnQuery(queryId, params) {
    // Build CLI args: run_query.py <query_id> --param1 value1 --param2 value2
    const args = [RUN_QUERY_SCRIPT, queryId];
    for (const [key, value] of Object.entries(params)) {
      args.push(`--${key}`, String(value));
    }

    try {
      const { stdout, stderr } = await execFileAsync(PYTHON3, args, {
        timeout: QUERY_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        cwd: ANALYTICS_SCRIPT_DIR,
      });

      if (stderr && stderr.trim()) {
        console.warn(`[AnalyticsGateway] Python stderr for ${queryId}: ${stderr.trim().slice(0, 200)}`);
      }

      // Parse JSON result from stdout
      const trimmed = stdout.trim();
      if (!trimmed) {
        throw new Error('Query returned empty result');
      }

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (parseErr) {
        throw new Error(`Query returned invalid JSON: ${trimmed.slice(0, 200)}`);
      }

      // Check for error reported by the Python script
      if (parsed.error) {
        throw new Error(`Query error: ${parsed.error}`);
      }

      return parsed;
    } catch (err) {
      if (err.killed) {
        throw new Error(`Query timed out after ${QUERY_TIMEOUT_MS / 1000} seconds`);
      }
      if (err.code === 'ENOENT') {
        throw new Error('Python3 not found. Analytics service unavailable.');
      }
      throw err;
    }
  }

  /**
   * Log a query execution to the history file.
   */
  async _logQuery(agentId, queryId, params, priceSats, executionMs, success, error = null) {
    try {
      await this._dataLayer.appendLog(this._historyPath, {
        agent_id: agentId,
        query_id: queryId,
        params,
        price_sats: priceSats,
        execution_ms: executionMs,
        success,
        error: error || null,
      });
    } catch {
      // Best-effort logging — never fail the query because of a log write
    }
  }
}
