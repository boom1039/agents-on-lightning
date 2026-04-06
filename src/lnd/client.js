import https from 'node:https';
import { readFile } from 'node:fs/promises';

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Error codes that warrant a retry
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
]);

function isTransientError(err) {
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (err.message && /socket hang up|network|timeout/i.test(err.message)) return true;
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeLndMessage(value, fallback = 'Unknown LND error') {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string' && value.message.trim()) return value.message;
    if (typeof value.error === 'string' && value.error.trim()) return value.error;
    try {
      return JSON.stringify(value);
    } catch {}
  }
  return fallback;
}

/**
 * Wraps a single LND node's REST API.
 *
 * LND REST docs: https://lightning.engineering/api-docs/api/lnd/rest-endpoints
 *
 * Usage:
 *   const client = new NodeClient({
 *     name: 'alpha',
 *     host: 'node-rest-host',
 *     restPort: 8080,
 *     macaroonPath: '/path/to/node.macaroon',
 *     tlsCertPath: '/path/to/node.cert',
 *   });
 *   await client.init();
 *   const info = await client.getInfo();
 */
export class NodeClient {
  /**
   * @param {Object} config
   * @param {string} config.name - Human-readable node name (e.g. "alpha")
   * @param {string} [config.lndDir] - LND data directory (informational)
   * @param {string} config.host - LND REST hostname
   * @param {number} config.restPort - LND REST port (default 8080)
   * @param {number} [config.rpcPort] - gRPC port (stored but unused by REST client)
   * @param {string} config.macaroonPath - Absolute path to admin.macaroon
   * @param {string} config.tlsCertPath - Absolute path to tls.cert
   */
  constructor(config) {
    this.name = config.name;
    // Use 127.0.0.1 instead of localhost to avoid IPv6 resolution issues
    // (LND typically listens on IPv4 only)
    this.host = config.host === 'localhost' ? '127.0.0.1' : (config.host || '127.0.0.1');
    this.restPort = config.restPort || 8080;
    this.rpcPort = config.rpcPort || 10009;
    this.lndDir = config.lndDir || null;
    this.macaroonPath = config.macaroonPath;
    this.tlsCertPath = config.tlsCertPath;

    // Set after init()
    this._macaroonHex = null;
    this._agent = null;
    this._initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Loads the TLS cert and macaroon from disk, creates the HTTPS agent.
   * Must be called before any API method.
   * Use this when credentials are stored as files (e.g. panel.yaml config).
   */
  async init() {
    const [certBuf, macaroonBuf] = await Promise.all([
      readFile(this.tlsCertPath),
      readFile(this.macaroonPath),
    ]);

    this._macaroonHex = macaroonBuf.toString('hex');

    this._agent = new https.Agent({
      ca: certBuf,               // Trust LND's self-signed certificate
      rejectUnauthorized: true,  // Still verify — just against the loaded CA
      keepAlive: true,
      keepAliveMsecs: 30_000,
    });

    this._initialized = true;
  }

  /**
   * Initialize from raw credentials instead of file paths.
   * Used for runtime "Plug Your Node" connections where the user provides
   * macaroon hex and TLS cert directly from the browser — no files on disk.
   *
   * @param {string} macaroonHex - Macaroon as hex string
   * @param {string} tlsCertBase64OrPem - TLS cert as base64 (DER) or PEM string
   */
  initFromCredentials(macaroonHex, tlsCertBase64OrPem) {
    this._macaroonHex = macaroonHex;

    // Accept both PEM (starts with -----BEGIN) and raw base64 (DER)
    let certBuf;
    if (tlsCertBase64OrPem.includes('-----BEGIN')) {
      certBuf = Buffer.from(tlsCertBase64OrPem, 'utf-8');
    } else {
      certBuf = Buffer.from(tlsCertBase64OrPem, 'base64');
    }

    this._agent = new https.Agent({
      ca: certBuf,
      rejectUnauthorized: true,
      keepAlive: true,
      keepAliveMsecs: 30_000,
    });

    this._initialized = true;
  }

  // ---------------------------------------------------------------------------
  // Low-level HTTP helpers
  // ---------------------------------------------------------------------------

  /**
   * Core HTTP request wrapper with retries, logging, and LND error parsing.
   *
   * @param {string} method - HTTP method
   * @param {string} path - URL path (e.g. "/v1/getinfo")
   * @param {Object} [query] - Query string parameters
   * @param {Object|null} [body] - JSON body for POST/PUT/DELETE
   * @returns {Promise<Object>} Parsed JSON response
   */
  async _request(method, path, query = null, body = null, requestOptions = {}) {
    if (!this._initialized) {
      throw new Error(`NodeClient "${this.name}" not initialized. Call init() first.`);
    }

    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const url = `${path}${qs}`;
    const jsonBody = body != null ? JSON.stringify(body) : null;

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.debug(
          `[lnd:${this.name}] Retry ${attempt}/${MAX_RETRIES} for ${method} ${url} after ${delay}ms`
        );
        await sleep(delay);
      }

      const start = performance.now();

      try {
        const result = await this._doRequest(method, url, jsonBody, requestOptions);
        const elapsed = (performance.now() - start).toFixed(1);
        console.debug(`[lnd:${this.name}] ${method} ${url} -> ${elapsed}ms`);
        return result;
      } catch (err) {
        lastError = err;
        const elapsed = (performance.now() - start).toFixed(1);

        // Only retry on transient network errors, not LND application errors
        if (isTransientError(err) && attempt < MAX_RETRIES) {
          console.debug(
            `[lnd:${this.name}] ${method} ${url} failed (${elapsed}ms): ${err.code || err.message} — will retry`
          );
          continue;
        }

        // Non-retryable or exhausted retries
        console.debug(
          `[lnd:${this.name}] ${method} ${url} FAILED (${elapsed}ms): ${err.message}`
        );
        throw err;
      }
    }

    throw lastError;
  }

  /**
   * Single HTTP request (no retry logic).
   */
  _doRequest(method, url, jsonBody, requestOptions = {}) {
    return new Promise((resolve, reject) => {
      const timeoutMs = Number.isFinite(requestOptions.timeoutMs) && requestOptions.timeoutMs > 0
        ? requestOptions.timeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
      const options = {
        hostname: this.host,
        port: this.restPort,
        path: url,
        method,
        agent: this._agent,
        headers: {
          'Grpc-Metadata-macaroon': this._macaroonHex,
        },
        timeout: timeoutMs,
      };

      if (jsonBody != null) {
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(jsonBody);
      }

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');

          // LND returns 200 for success, various 4xx/5xx for errors
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(raw.length > 0 ? JSON.parse(raw) : {});
            } catch (parseErr) {
              reject(new LndError(
                `Failed to parse LND response: ${parseErr.message}`,
                res.statusCode,
                raw
              ));
            }
          } else {
            // Parse LND's error body: { "error": "...", "message": "...", "code": N }
            let lndMsg = raw;
            let lndCode = null;
            try {
              const errBody = JSON.parse(raw);
              lndMsg = normalizeLndMessage(errBody.message, '') || normalizeLndMessage(errBody.error, '') || raw;
              lndCode = errBody.code || null;
            } catch {
              // raw text is fine as the error message
            }
            reject(new LndError(lndMsg, res.statusCode, raw, lndCode));
          }
        });
      });

      req.on('error', reject);

      req.on('timeout', () => {
        req.destroy();
        const err = new Error(`Request timed out: ${method} ${url}`);
        err.code = 'ETIMEDOUT';
        reject(err);
      });

      if (jsonBody != null) {
        req.write(jsonBody);
      }

      req.end();
    });
  }

  // Convenience wrappers
  _get(path, query, requestOptions) {
    return this._request('GET', path, query, null, requestOptions);
  }

  _post(path, body, requestOptions) {
    return this._request('POST', path, null, body, requestOptions);
  }

  _delete(path, query, requestOptions) {
    return this._request('DELETE', path, query, null, requestOptions);
  }

  // ---------------------------------------------------------------------------
  // General / Node info
  // ---------------------------------------------------------------------------

  /** Returns general information about the LND node. */
  getInfo() {
    return this._get('/v1/getinfo');
  }

  /** Returns stats about the known channel graph. */
  getNetworkInfo() {
    return this._get('/v1/graph/info');
  }

  // ---------------------------------------------------------------------------
  // Channels
  // ---------------------------------------------------------------------------

  /** Lists all open channels. */
  listChannels() {
    return this._get('/v1/channels');
  }

  /** Lists all pending (opening/closing/force-closing) channels. */
  pendingChannels() {
    return this._get('/v1/channels/pending');
  }

  /** Lists all closed channels. */
  closedChannels() {
    return this._get('/v1/channels/closed');
  }

  /** Returns the total channel balance (local + remote). */
  channelBalance() {
    return this._get('/v1/balance/channels');
  }

  // ---------------------------------------------------------------------------
  // Wallet
  // ---------------------------------------------------------------------------

  /** Returns the on-chain wallet balance. */
  walletBalance() {
    return this._get('/v1/balance/blockchain');
  }

  /** Generates a new on-chain Bitcoin address (p2wkh). */
  newAddress(type = 'WITNESS_PUBKEY_HASH') {
    return this._get(`/v1/newaddress?type=${type}`);
  }

  /** Returns on-chain transactions, each with num_confirmations already computed. */
  getTransactions(startHeight = 0, endHeight = -1) {
    return this._get('/v1/transactions', { start_height: startHeight, end_height: endHeight });
  }

  // ---------------------------------------------------------------------------
  // Graph queries
  // ---------------------------------------------------------------------------

  /**
   * Returns info about a specific node on the network graph.
   * @param {string} pubKey - 33-byte hex public key
   */
  getNodeInfo(pubKey) {
    return this._get(`/v1/graph/node/${pubKey}`);
  }

  /**
   * Returns info about a specific channel edge.
   * @param {string} chanId - Channel ID (uint64 as string)
   */
  getChanInfo(chanId) {
    return this._get(`/v1/graph/edge/${chanId}`);
  }

  /**
   * Returns the full network graph (can be large).
   * Consider using with include_unannounced=false for smaller responses.
   */
  describeGraph(includeUnannounced = false) {
    return this._get('/v1/graph', {
      include_unannounced: includeUnannounced,
    });
  }

  // ---------------------------------------------------------------------------
  // Forwarding / Payment history
  // ---------------------------------------------------------------------------

  /**
   * Returns forwarding events for the node.
   * @param {number} startTime - Unix timestamp (seconds)
   * @param {number} endTime - Unix timestamp (seconds)
   * @param {number} [indexOffset=0] - Pagination offset
   * @param {number} [maxEvents=1000] - Max events to return
   */
  forwardingHistory(startTime, endTime, indexOffset = 0, maxEvents = 1000) {
    return this._post('/v1/switch', {
      start_time: String(startTime),
      end_time: String(endTime),
      index_offset: indexOffset,
      num_max_events: maxEvents,
    });
  }

  /**
   * Lists outgoing payments.
   * @param {number} [indexOffset=0]
   * @param {number} [maxPayments=100]
   * @param {boolean} [includeIncomplete=false]
   */
  listPayments(indexOffset = 0, maxPayments = 100, includeIncomplete = false) {
    return this._get('/v1/payments', {
      index_offset: indexOffset,
      max_payments: maxPayments,
      include_incomplete: includeIncomplete,
    });
  }

  /**
   * Lists invoices (incoming payment requests).
   * @param {number} [indexOffset=0]
   * @param {number} [numMaxInvoices=100]
   * @param {boolean} [pendingOnly=false]
   */
  listInvoices(indexOffset = 0, numMaxInvoices = 100, pendingOnly = false) {
    return this._get('/v1/invoices', {
      index_offset: indexOffset,
      num_max_invoices: numMaxInvoices,
      pending_only: pendingOnly,
    });
  }

  /**
   * Creates a new Lightning invoice (addinvoice).
   * @param {number} value - Amount in sats
   * @param {string} [memo=''] - Invoice memo / description
   * @param {number} [expiry=3600] - Expiry in seconds
   * @returns {Promise<{payment_request: string, r_hash: string, add_index: string}>}
   */
  addInvoice(value, memo = '', expiry = 3600) {
    return this._post('/v1/invoices', {
      value: String(value),
      memo,
      expiry: String(expiry),
      private: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Channel lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Opens a channel with a remote peer.
   * @param {string} pubKey - Remote node public key
   * @param {number} localFundingAmount - Sats to commit from local wallet
   * @param {number} [pushSat=0] - Sats to push to the remote side initially
   * @param {Object} [opts={}] - Additional open-channel options
   * @param {number} [opts.satPerVbyte] - Fee rate in sat/vbyte
   * @param {boolean} [opts.private] - Whether the channel should be private
   * @param {number} [opts.minHtlcMsat] - Minimum HTLC size in msat
   * @param {number} [opts.baseFeeMsat] - Initial base fee in millisatoshis
   * @param {number} [opts.feeRatePpm] - Initial fee rate in ppm
   * @param {number} [opts.remoteCsvDelay] - CSV delay for remote party
   * @param {number} [opts.minConfs] - Minimum confirmations for funding UTXO
   * @param {boolean} [opts.spendUnconfirmed] - Allow spending unconfirmed outputs
   */
  openChannel(pubKey, localFundingAmount, pushSat = 0, opts = {}) {
    const body = {
      node_pubkey_string: pubKey,
      local_funding_amount: String(localFundingAmount),
      push_sat: String(pushSat),
    };

    if (opts.satPerVbyte != null) body.sat_per_vbyte = String(opts.satPerVbyte);
    if (opts.private != null) body.private = opts.private;
    if (opts.minHtlcMsat != null) body.min_htlc_msat = String(opts.minHtlcMsat);
    if (opts.baseFeeMsat != null) {
      body.base_fee = String(opts.baseFeeMsat);
      body.use_base_fee = true;
    }
    if (opts.feeRatePpm != null) {
      body.fee_rate = String(opts.feeRatePpm);
      body.use_fee_rate = true;
    }
    if (opts.remoteCsvDelay != null) body.remote_csv_delay = opts.remoteCsvDelay;
    if (opts.minConfs != null) body.min_confs = opts.minConfs;
    if (opts.spendUnconfirmed != null) body.spend_unconfirmed = opts.spendUnconfirmed;

    return this._post('/v1/channels', body, { timeoutMs: opts.timeoutMs });
  }

  /**
   * Closes a channel.
   * @param {string} channelPoint - "funding_txid:output_index"
   * @param {boolean} [force=false] - Force close (unilateral)
   * @param {number} [satPerVbyte] - Fee rate for the closing transaction
   */
  closeChannel(channelPoint, force = false, satPerVbyte = null, requestOptions = {}) {
    const [fundingTxid, outputIndex] = channelPoint.split(':');
    if (!fundingTxid || outputIndex == null) {
      throw new Error(`Invalid channel point: "${channelPoint}". Expected "txid:index".`);
    }

    const query = { force };
    if (satPerVbyte != null) query.sat_per_vbyte = satPerVbyte;

    // LND REST uses the URL-safe base64 variant of txid bytes by default,
    // but also accepts the hex txid via the funding_txid_str query param
    // alongside the output_index in the URL path.
    return this._delete(
      `/v1/channels/${fundingTxid}/${outputIndex}`,
      query,
      requestOptions,
    );
  }

  // ---------------------------------------------------------------------------
  // Fee management
  // ---------------------------------------------------------------------------

  /**
   * Updates the fee policy for a specific channel or all channels.
   * @param {string|null} channelPoint - "txid:index" or null for global update
   * @param {number} baseFeeMsat - Base fee in millisatoshis
   * @param {number} feeRatePpm - Fee rate in parts per million
   * @param {number} timeLockDelta - CLTV delta
   * @param {number} [maxHtlcMsat] - Maximum HTLC size in msat
   * @param {number} [minHtlcMsat] - Minimum HTLC size in msat (effective)
   */
  updateChannelPolicy(channelPoint, baseFeeMsat, feeRatePpm, timeLockDelta, maxHtlcMsat = null, minHtlcMsat = null) {
    const body = {
      base_fee_msat: String(baseFeeMsat),
      fee_rate_ppm: String(feeRatePpm),
      time_lock_delta: timeLockDelta,
    };

    if (channelPoint) {
      const [fundingTxid, outputIndex] = channelPoint.split(':');
      body.chan_point = {
        funding_txid_str: fundingTxid,
        output_index: Number(outputIndex),
      };
    } else {
      body.global = true;
    }

    if (maxHtlcMsat != null) body.max_htlc_msat = String(maxHtlcMsat);
    if (minHtlcMsat != null) body.min_htlc_msat_specified = true;
    if (minHtlcMsat != null) body.min_htlc_msat = String(minHtlcMsat);

    return this._post('/v1/chanpolicy', body);
  }

  /** Returns a report of all current fee settings per channel. */
  feeReport() {
    return this._get('/v1/fees');
  }

  // ---------------------------------------------------------------------------
  // Payments / Routing
  // ---------------------------------------------------------------------------

  /**
   * Sends a payment using a BOLT11 payment request.
   * This is the synchronous (blocking) send — waits for resolution.
   * @param {string} paymentRequest - BOLT11 encoded payment request
   * @param {number} [timeoutSeconds=60] - Payment timeout
   * @param {number} [feeLimitSat] - Maximum fee in sats
   */
  sendPayment(paymentRequest, timeoutSeconds = 60, feeLimitSat = null) {
    const body = {
      payment_request: paymentRequest,
      timeout_seconds: timeoutSeconds,
    };
    if (feeLimitSat != null) {
      body.fee_limit = { fixed: String(feeLimitSat) };
    }
    return this._post('/v1/channels/transactions', body, {
      timeoutMs: Math.max(DEFAULT_REQUEST_TIMEOUT_MS, (timeoutSeconds * 1000) + 5_000),
    });
  }

  /**
   * Queries for a possible route to a destination node.
   * @param {string} pubKey - Destination public key
   * @param {number} amt - Amount in satoshis
   * @param {Object} [opts={}] - Additional query options
   * @param {number} [opts.finalCltvDelta] - Final CLTV delta
   * @param {number} [opts.feeLimit] - Fee limit in sats
   * @param {string[]} [opts.ignoredNodes] - Pub keys to exclude
   * @param {number} [opts.numRoutes] - Maximum routes to return (deprecated in newer LND)
   */
  queryRoutes(pubKey, amt, opts = {}) {
    const basePath = `/v1/graph/routes/${encodeURIComponent(pubKey)}/${amt}`;

    // Build query params. URLSearchParams.append handles repeated keys for
    // array parameters like ignored_nodes.
    const qs = new URLSearchParams();

    if (opts.finalCltvDelta != null) qs.set('final_cltv_delta', opts.finalCltvDelta);
    if (opts.feeLimit != null) qs.set('fee_limit.fixed', opts.feeLimit);
    if (opts.numRoutes != null) qs.set('num_routes', opts.numRoutes);

    if (opts.ignoredNodes && opts.ignoredNodes.length > 0) {
      for (const node of opts.ignoredNodes) {
        qs.append('ignored_nodes', node);
      }
    }

    const qsStr = qs.toString();
    const fullPath = qsStr ? `${basePath}?${qsStr}` : basePath;
    return this._request('GET', fullPath);
  }

  // ---------------------------------------------------------------------------
  // Peers
  // ---------------------------------------------------------------------------

  /**
   * Connects to a remote peer.
   * @param {string} pubKey - Remote node public key
   * @param {string} host - "ip:port" of the remote node
   * @param {boolean} [perm=false] - Whether the connection is persistent
   */
  connectPeer(pubKey, host, perm = false) {
    return this._post('/v1/peers', {
      addr: {
        pubkey: pubKey,
        host,
      },
      perm,
    });
  }

  /** Lists all currently connected peers. */
  listPeers() {
    return this._get('/v1/peers');
  }

  // ---------------------------------------------------------------------------
  // ChainKit — Bitcoin Layer 1 block data via LND's chainrpc
  // ---------------------------------------------------------------------------

  /**
   * Returns the block hash for a given block height.
   * Uses LND's ChainKit (chainrpc) which proxies to the connected bitcoind.
   * @param {number} blockHeight - Block height to look up
   * @returns {Promise<{block_hash: string}>} Block hash as hex string
   */
  getBlockHash(blockHeight) {
    return this._get(`/v2/chainkit/blockhash`, {
      block_height: blockHeight,
    });
  }

  /**
   * Returns raw block bytes for a given block hash.
   * The raw_block field is base64-encoded.
   * @param {string} blockHash - Block hash as hex string (from getBlockHash)
   * @returns {Promise<{raw_block: string}>} Base64-encoded raw block bytes
   */
  getBlock(blockHash) {
    return this._get(`/v2/chainkit/block`, {
      block_hash: blockHash,
    });
  }

  /**
   * Returns raw block header bytes (80 bytes) for a given block hash.
   * Much cheaper than getBlock() — avoids downloading multi-MB full blocks.
   * The raw_block_header field is base64-encoded.
   * @param {string} blockHash - Block hash as base64 string (from getBlockHash)
   * @returns {Promise<{raw_block_header: string}>} Base64-encoded 80-byte header
   */
  getBlockHeader(blockHash) {
    return this._get(`/v2/chainkit/blockheader`, {
      block_hash: blockHash,
    });
  }

  /**
   * Returns the best (latest) block hash and height.
   * @returns {Promise<{block_hash: string, block_height: number}>}
   */
  getBestBlock() {
    return this._get('/v2/chainkit/bestblock');
  }

  // ---------------------------------------------------------------------------
  // REST Streaming (long-lived connections)
  // ---------------------------------------------------------------------------

  /**
   * Opens a long-lived REST stream to an LND endpoint.
   * LND streams return newline-delimited JSON objects wrapped in {"result": {...}}.
   *
   * @param {string} path - URL path (e.g. "/v1/graph/subscribe")
   * @param {function(Object): void} onEvent - Called for each parsed event
   * @param {function(Error): void} [onError] - Called on stream error
   * @returns {{ close: function(): void, closed: Promise<void> }} Stream handle
   */
  openStream(path, onEvent, onError) {
    if (!this._initialized) {
      throw new Error(`NodeClient "${this.name}" not initialized. Call init() first.`);
    }

    let req = null;
    let closed = false;

    const closeHandle = () => {
      closed = true;
      if (req) {
        try { req.destroy(); } catch { /* ignore */ }
      }
    };

    const closedPromise = new Promise((resolveStream, rejectStream) => {
      const options = {
        hostname: this.host,
        port: this.restPort,
        path,
        method: 'GET',
        agent: this._agent,
        headers: {
          'Grpc-Metadata-macaroon': this._macaroonHex,
        },
        // No timeout — streams are meant to stay open indefinitely
      };

      req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            const err = new LndError(
              `Stream ${path} returned ${res.statusCode}: ${raw}`,
              res.statusCode,
              raw,
            );
            if (onError) onError(err);
            rejectStream(err);
          });
          return;
        }

        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString();

          // LND streams send newline-delimited JSON
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep incomplete last line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const parsed = JSON.parse(trimmed);
              // LND wraps stream events in {"result": {...}}
              const event = parsed.result || parsed;
              onEvent(event);
            } catch (parseErr) {
              console.debug(
                `[lnd:${this.name}] Stream ${path} parse error: ${parseErr.message}`,
              );
            }
          }
        });

        res.on('end', () => {
          if (!closed) {
            const err = new Error(`Stream ${path} ended unexpectedly`);
            if (onError) onError(err);
          }
          resolveStream();
        });

        res.on('error', (err) => {
          if (!closed) {
            if (onError) onError(err);
          }
          rejectStream(err);
        });
      });

      req.on('error', (err) => {
        if (!closed) {
          if (onError) onError(err);
        }
        rejectStream(err);
      });

      req.end();
    });

    return {
      close: closeHandle,
      closed: closedPromise.catch(() => {}), // Suppress unhandled rejection
    };
  }

  /**
   * Opens a POST-initiated stream to an LND endpoint.
   * Used for endpoints like /v2/router/send that accept a POST body
   * and return chunked newline-delimited JSON with status updates.
   *
   * Reads until a terminal status (SUCCEEDED or FAILED) and resolves
   * with the final event.
   *
   * @param {string} path - URL path (e.g. "/v2/router/send")
   * @param {Object} body - JSON body to POST
   * @returns {Promise<Object>} Final event with terminal status
   */
  postStream(path, body, opts = {}) {
    if (!this._initialized) {
      throw new Error(`NodeClient "${this.name}" not initialized. Call init() first.`);
    }

    const jsonBody = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : 120_000;
      const options = {
        hostname: this.host,
        port: this.restPort,
        path,
        method: 'POST',
        agent: this._agent,
        headers: {
          'Grpc-Metadata-macaroon': this._macaroonHex,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(jsonBody),
        },
        // Long timeout for payment resolution (payments can take minutes)
        timeout: timeoutMs,
      };

      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            reject(new LndError(
              `POST stream ${path} returned ${res.statusCode}: ${raw}`,
              res.statusCode,
              raw,
            ));
          });
          return;
        }

        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString();

          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep incomplete last line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const parsed = JSON.parse(trimmed);
              const event = parsed.result || parsed;

              // Check for terminal status
              if (event.status === 'SUCCEEDED' || event.status === 'FAILED') {
                req.destroy(); // Done — close connection
                resolve(event);
                return;
              }
            } catch (parseErr) {
              console.debug(
                `[lnd:${this.name}] POST stream ${path} parse error: ${parseErr.message}`,
              );
            }
          }
        });

        res.on('end', () => {
          // If stream ended without terminal status, check remaining buffer
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim());
              const event = parsed.result || parsed;
              resolve(event);
              return;
            } catch { /* fall through */ }
          }
          reject(new Error(`POST stream ${path} ended without terminal status`));
        });

        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        const err = new Error(`POST stream ${path} timed out`);
        err.code = 'ETIMEDOUT';
        reject(err);
      });

      req.write(jsonBody);
      req.end();
    });
  }

  /**
   * Sends a payment via the v2 router (streaming).
   * Returns a Promise that resolves with the terminal payment status.
   *
   * POST /v2/router/send — returns chunked status updates:
   *   IN_FLIGHT → SUCCEEDED (with fee_sat, payment_preimage)
   *   IN_FLIGHT → FAILED (with failure_reason)
   *
   * @param {Object} params
   * @param {string} params.payment_request - BOLT11 payment request
   * @param {number} [params.timeout_seconds=60]
   * @param {number} [params.fee_limit_sat] - Max fee in sats
   * @param {string} [params.outgoing_chan_id] - Force outgoing channel
   * @param {boolean} [params.allow_self_payment=false]
   * @returns {Promise<Object>} Terminal event with status, fee_sat, etc.
   */
  sendPaymentV2({ payment_request, timeout_seconds = 60, fee_limit_sat, outgoing_chan_id, allow_self_payment = false }) {
    const body = {
      payment_request,
      timeout_seconds,
      allow_self_payment,
    };
    if (fee_limit_sat != null) body.fee_limit_sat = String(fee_limit_sat);
    if (outgoing_chan_id) body.outgoing_chan_id = outgoing_chan_id;

    return this.postStream('/v2/router/send', body, {
      timeoutMs: Math.max(120_000, (timeout_seconds * 1000) + 5_000),
    });
  }

  /**
   * Tracks an in-flight payment by hash (streaming GET).
   * Used for crash recovery — checks the final status of a payment
   * that was initiated before a restart.
   *
   * GET /v2/router/track/{payment_hash} — streams status updates.
   *
   * @param {string} paymentHash - Payment hash (hex)
   * @returns {Promise<Object>} Terminal event with status
   */
  trackPaymentV2(paymentHash) {
    return new Promise((resolve, reject) => {
      const handle = this.openStream(
        `/v2/router/track/${paymentHash}`,
        (event) => {
          if (event.status === 'SUCCEEDED' || event.status === 'FAILED') {
            handle.close();
            resolve(event);
          }
        },
        (err) => reject(err),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Subscriptions (polling-based)
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to new/settled invoices by polling.
   * Returns an async generator that yields invoice objects.
   *
   * @param {number} [pollIntervalMs=5000] - Polling interval
   * @param {number} [settleIndexStart=0] - Start from this settle index
   * @yields {Object} Invoice objects as they are settled
   */
  async *subscribeInvoices(pollIntervalMs = 5000, settleIndexStart = 0) {
    let addIndex = 0;

    // Get current highest indices to avoid replaying history
    if (settleIndexStart === 0) {
      try {
        const initial = await this.listInvoices(0, 1);
        if (initial.last_index_offset) {
          addIndex = Number(initial.last_index_offset);
        }
      } catch {
        // Start from 0 if we can't get the initial offset
      }
    }

    while (true) {
      try {
        const result = await this.listInvoices(addIndex, 100);
        const invoices = result.invoices || [];

        for (const inv of invoices) {
          const invAddIndex = Number(inv.add_index || 0);
          if (invAddIndex > addIndex) {
            addIndex = invAddIndex;
            yield inv;
          }
        }
      } catch (err) {
        console.error(`[lnd:${this.name}] subscribeInvoices poll error: ${err.message}`);
      }

      await sleep(pollIntervalMs);
    }
  }

  /**
   * Subscribes to peer connection/disconnection events by polling listPeers.
   * Yields { type: 'connected' | 'disconnected', pubKey, address } objects.
   *
   * @param {number} [pollIntervalMs=10000] - Polling interval
   * @yields {Object} Peer event objects
   */
  async *subscribePeerEvents(pollIntervalMs = 10000) {
    let knownPeers = new Map(); // pubkey -> peer object

    // Seed with current peers
    try {
      const initial = await this.listPeers();
      for (const peer of (initial.peers || [])) {
        knownPeers.set(peer.pub_key, peer);
      }
    } catch {
      // Start empty
    }

    while (true) {
      await sleep(pollIntervalMs);

      try {
        const result = await this.listPeers();
        const currentPeers = new Map();

        for (const peer of (result.peers || [])) {
          currentPeers.set(peer.pub_key, peer);

          if (!knownPeers.has(peer.pub_key)) {
            yield {
              type: 'connected',
              pubKey: peer.pub_key,
              address: peer.address,
            };
          }
        }

        for (const [pubKey, peer] of knownPeers) {
          if (!currentPeers.has(pubKey)) {
            yield {
              type: 'disconnected',
              pubKey,
              address: peer.address,
            };
          }
        }

        knownPeers = currentPeers;
      } catch (err) {
        console.error(`[lnd:${this.name}] subscribePeerEvents poll error: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /** String representation for logging. */
  toString() {
    return `NodeClient<${this.name}@${this.host}:${this.restPort}>`;
  }
}

/**
 * Custom error class for LND API errors with status code and response body.
 */
export class LndError extends Error {
  /**
   * @param {string} message - Error message
   * @param {number} statusCode - HTTP status code
   * @param {string} responseBody - Raw response body
   * @param {number|null} lndCode - LND gRPC status code (if present)
   */
  constructor(message, statusCode, responseBody, lndCode = null) {
    super(message);
    this.name = 'LndError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.lndCode = lndCode;
  }
}
