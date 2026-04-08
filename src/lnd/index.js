import { NodeClient, LndError } from './client.js';
import { SnapshotNodeClient } from './snapshot-node-client.js';

const SCOPED_NODE_ROLES = new Set([
  'read',
  'invoice',
  'wallet',
  'withdraw',
  'operator',
  'open',
  'close',
  'rebalance',
  'swap',
  'policy',
]);

/**
 * Manages multiple LND NodeClient instances, keyed by name.
 *
 * Usage:
 *   const manager = new NodeManager();
 *   await manager.addNode('alpha', {
 *     host: 'node-rest-host',
 *     restPort: 8080,
 *     macaroonPath: '/path/to/node.macaroon',
 *     tlsCertPath: '/path/to/node.cert',
 *   });
 *   const info = await manager.getNode('alpha').getInfo();
 */
export class NodeManager {
  constructor() {
    /** @type {Map<string, NodeClient>} */
    this._nodes = new Map();

    /** @type {string|null} Name of the first node added */
    this._defaultName = null;
    this._scopedDefaultNodes = new Map();
  }

  _normalizeScope(role = 'read') {
    return SCOPED_NODE_ROLES.has(role) ? role : 'read';
  }

  async _connectClient(name, config) {
    const client = new NodeClient({ name, ...config });
    await client.init();

    const info = await this._probeClient(client, name, config);
    return { client, info };
  }

  async _probeClient(client, name, config, role = 'read') {
    try {
      if (role === 'invoice') {
        await client.listInvoices(0, 1, false);
        return { alias: name, identity_pubkey: null, num_active_channels: 0, num_peers: 0, synced_to_chain: true };
      }
      if (role === 'withdraw') {
        await client.getTransactions();
        return { alias: name, identity_pubkey: null, num_active_channels: 0, num_peers: 0, synced_to_chain: true };
      }
      return await client.getInfo();
    } catch (err) {
      const detail = err instanceof LndError
        ? `HTTP ${err.statusCode}: ${err.message}`
        : err.message;
      throw new Error(
        `Failed to connect to LND node "${name}" at ${config.host}:${config.restPort}: ${detail}`
      );
    }
  }

  async _initializeScopedDefaults(name, config, fallbackClient) {
    this._scopedDefaultNodes.clear();

    for (const role of SCOPED_NODE_ROLES) {
      const rolePath = config?.macaroonRoles?.[role];
      if (!rolePath || rolePath === config.macaroonPath) {
        this._scopedDefaultNodes.set(role, fallbackClient);
        continue;
      }

      try {
        const roleName = `${name}:${role}`;
        const roleConfig = {
          ...config,
          macaroonPath: rolePath,
        };
        const client = new NodeClient({ name: roleName, ...roleConfig });
        await client.init();
        await this._probeClient(client, roleName, roleConfig, role);
        this._scopedDefaultNodes.set(role, client);
        console.log(`[NodeManager] Scoped ${role} macaroon ready for "${name}"`);
      } catch (err) {
        console.warn(`[NodeManager] Scoped ${role} macaroon failed for "${name}" — blocking that role instead of widening access: ${err.message}`);
        this._scopedDefaultNodes.set(role, null);
      }
    }
  }

  /**
   * Creates a NodeClient, initializes it (loads certs + macaroon),
   * validates the connection by calling getInfo(), and registers it.
   *
   * @param {string} name - Unique name for this node (e.g. "alpha")
   * @param {Object} config - Node configuration
   * @param {string} config.host - LND REST hostname
   * @param {number} config.restPort - LND REST port
   * @param {string} config.macaroonPath - Absolute path to admin.macaroon
   * @param {string} config.tlsCertPath - Absolute path to tls.cert
   * @param {string} [config.lndDir] - LND data directory
   * @param {number} [config.rpcPort] - gRPC port (stored, not used by REST client)
   * @returns {Promise<NodeClient>} The initialized and validated client
   * @throws {Error} If connection validation fails
   */
  async addNode(name, config) {
    if (this._nodes.has(name)) {
      throw new Error(`Node "${name}" is already registered.`);
    }

    const { client, info } = await this._connectClient(name, config);

    const alias = info.alias || info.identity_pubkey?.slice(0, 12) || name;
    console.log(
      `[NodeManager] Connected to "${name}" (${alias}) — ` +
      `pubkey: ${info.identity_pubkey?.slice(0, 16)}..., ` +
      `channels: ${info.num_active_channels || 0} active, ` +
      `peers: ${info.num_peers || 0}, ` +
      `synced: ${info.synced_to_chain ? 'yes' : 'no'}`
    );

    this._nodes.set(name, client);

    if (this._defaultName === null) {
      this._defaultName = name;
      await this._initializeScopedDefaults(name, config, client);
    }

    return client;
  }

  /**
   * Creates a NodeClient from raw credentials (macaroon hex + TLS cert),
   * validates the connection, and registers it. Used for runtime "Plug Your
   * Node" connections — no file paths needed, credentials come from the browser.
   *
   * @param {string} name - Unique name for this node (e.g. "session-abc123")
   * @param {Object} creds
   * @param {string} creds.host - LND REST hostname or IP
   * @param {number} creds.restPort - LND REST port
   * @param {string} creds.macaroonHex - Macaroon as hex string
   * @param {string} creds.tlsCertBase64OrPem - TLS cert as base64 (DER) or PEM
   * @returns {Promise<{ client: NodeClient, info: Object }>} Client + getInfo result
   */
  async addNodeFromCredentials(name, { host, restPort, macaroonHex, tlsCertBase64OrPem }) {
    if (this._nodes.has(name)) {
      throw new Error(`Node "${name}" is already registered.`);
    }

    const client = new NodeClient({ name, host, restPort });
    client.initFromCredentials(macaroonHex, tlsCertBase64OrPem);

    // Validate by calling getInfo — fails fast if credentials are wrong
    let info;
    try {
      info = await client.getInfo();
    } catch (err) {
      const detail = err instanceof LndError
        ? `HTTP ${err.statusCode}: ${err.message}`
        : err.message;
      throw new Error(`Failed to connect to LND node at ${host}:${restPort}: ${detail}`);
    }

    const alias = info.alias || info.identity_pubkey?.slice(0, 12) || name;
    console.log(
      `[NodeManager] Runtime node "${name}" connected (${alias}) — ` +
      `pubkey: ${info.identity_pubkey?.slice(0, 16)}..., ` +
      `channels: ${info.num_active_channels || 0} active, ` +
      `synced: ${info.synced_to_chain ? 'yes' : 'no'}`
    );

    this._nodes.set(name, client);
    if (this._defaultName === null) {
      this._defaultName = name;
    }

    return { client, info };
  }

  /**
   * Returns a registered NodeClient by name.
   * @param {string} name
   * @returns {NodeClient}
   * @throws {Error} If no node with that name is registered
   */
  getNode(name) {
    const client = this._nodes.get(name);
    if (!client) {
      const available = [...this._nodes.keys()].join(', ') || '(none)';
      throw new Error(`Node "${name}" not found. Available: ${available}`);
    }
    return client;
  }

  /**
   * Returns all registered NodeClient instances as a Map.
   * @returns {Map<string, NodeClient>}
   */
  getAllNodes() {
    return new Map(this._nodes);
  }

  /**
   * Returns an array of all registered node names.
   * @returns {string[]}
   */
  getNodeNames() {
    return [...this._nodes.keys()];
  }

  /**
   * Returns the first node that was registered (the default node).
   * @returns {NodeClient}
   * @throws {Error} If no nodes are registered
   */
  getDefaultNode() {
    if (this._defaultName === null) {
      throw new Error('No nodes registered. Call addNode() first.');
    }
    return this._nodes.get(this._defaultName);
  }

  /**
   * Returns the default node or null if no nodes are registered.
   * Safe alternative to getDefaultNode() that never throws.
   * @returns {NodeClient|null}
   */
  getDefaultNodeOrNull() {
    if (this._defaultName === null) return null;
    return this._nodes.get(this._defaultName) || null;
  }

  getScopedDefaultNode(role = 'read') {
    const scope = this._normalizeScope(role);
    if (this._scopedDefaultNodes.has(scope)) {
      const client = this._scopedDefaultNodes.get(scope);
      if (!client) {
        throw new Error(`Scoped "${scope}" macaroon is unavailable.`);
      }
      return client;
    }
    return this.getDefaultNode();
  }

  getScopedDefaultNodeOrNull(role = 'read') {
    const scope = this._normalizeScope(role);
    if (this._scopedDefaultNodes.has(scope)) {
      return this._scopedDefaultNodes.get(scope) || null;
    }
    return this.getDefaultNodeOrNull();
  }

  /**
   * Returns true if at least one node is registered.
   * @returns {boolean}
   */
  hasNodes() {
    return this._nodes.size > 0;
  }

  /**
   * Checks if a node with the given name is registered.
   * @param {string} name
   * @returns {boolean}
   */
  hasNode(name) {
    return this._nodes.has(name);
  }

  /**
   * Returns channel list for a named node. Delegates to the underlying client's
   * listChannels(). Used by ContextBuilder to pull live/snapshot channel data.
   *
   * @param {string} name - Node name
   * @returns {Promise<object[]>} Array of channel objects
   */
  async getChannels(name) {
    const client = this.getNode(name);
    if (!client) return [];
    try {
      const result = await client.listChannels();
      const list = result?.channels || (Array.isArray(result) ? result : []);
      return list;
    } catch (err) {
      console.warn(`[NodeManager] getChannels(${name}) failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Returns forwarding history for a named node. Delegates to the underlying
   * client's forwardingHistory(). Used by ContextBuilder to pull live/snapshot
   * forwarding data.
   *
   * @param {string} name - Node name
   * @param {number} [sinceMs] - Only return events after this timestamp (unused by snapshot client)
   * @returns {Promise<object[]>} Array of forwarding event objects
   */
  async getForwardingHistory(name, sinceMs) {
    const client = this.getNode(name);
    if (!client) return [];
    try {
      const result = await client.forwardingHistory();
      return result?.forwarding_events || [];
    } catch (err) {
      console.warn(`[NodeManager] getForwardingHistory(${name}) failed: ${err.message}`);
      return [];
    }
  }

  async getPayments(name) {
    const client = this.getNode(name);
    if (!client) return [];
    try {
      const result = await client.listPayments();
      return result?.payments || (Array.isArray(result) ? result : []);
    } catch (err) {
      console.warn(`[NodeManager] getPayments(${name}) failed: ${err.message}`);
      return [];
    }
  }

  async getInvoices(name) {
    const client = this.getNode(name);
    if (!client) return [];
    try {
      const result = await client.listInvoices();
      return result?.invoices || (Array.isArray(result) ? result : []);
    } catch (err) {
      console.warn(`[NodeManager] getInvoices(${name}) failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Registers a SnapshotNodeClient from browser-pushed LNC snapshot data.
   * If a SnapshotNodeClient already exists under this name, updates it in place.
   * If a live NodeClient exists under this name, throws — won't overwrite live connections.
   *
   * @param {string} name - Name for this snapshot client (e.g. "lnc-snapshot")
   * @param {Object} snapshotData - Snapshot data from the browser (S.channels, S.nodes, etc.)
   * @returns {SnapshotNodeClient} The created or updated client
   */
  addNodeFromSnapshot(name, snapshotData) {
    const existing = this._nodes.get(name);

    if (existing) {
      if (existing.isSnapshot) {
        // Update existing SnapshotNodeClient in place
        existing.updateSnapshot(snapshotData);
        console.log(`[NodeManager] Updated snapshot for "${name}" — ${Object.keys(snapshotData).length} fields`);
        return existing;
      }
      throw new Error(`Node "${name}" is a live connection — cannot overwrite with snapshot data.`);
    }

    const client = new SnapshotNodeClient(name, snapshotData);
    this._nodes.set(name, client);

    if (this._defaultName === null) {
      this._defaultName = name;
    }

    console.log(`[NodeManager] Registered snapshot client "${name}" — ${Object.keys(snapshotData).length} fields`);
    return client;
  }

  /**
   * Removes a snapshot node. Only removes if the registered client is a SnapshotNodeClient.
   * Won't accidentally remove a live gRPC NodeClient.
   *
   * @param {string} name - Name of the snapshot client to remove
   * @returns {boolean} True if removed, false if not found or not a snapshot
   */
  removeSnapshotNode(name) {
    const existing = this._nodes.get(name);
    if (!existing || !existing.isSnapshot) return false;
    return this.removeNode(name);
  }

  /**
   * Removes a registered node. Does not close any connections (HTTP is stateless).
   * @param {string} name
   * @returns {boolean} True if the node was removed
   */
  removeNode(name) {
    const removed = this._nodes.delete(name);
    if (removed && this._defaultName === name) {
      // Promote the next node to default, or null if empty
      const first = this._nodes.keys().next();
      this._defaultName = first.done ? null : first.value;
      this._scopedDefaultNodes.clear();
      if (this._defaultName) {
        const nextDefault = this._nodes.get(this._defaultName) || null;
        for (const role of SCOPED_NODE_ROLES) this._scopedDefaultNodes.set(role, nextDefault);
      }
    }
    return removed;
  }

  /**
   * Creates a NodeManager and registers nodes from a config object.
   * Compatible with the config shape from src/config.js (config.nodes).
   *
   * @param {Object} nodesConfig - Map of name -> node config objects
   * @returns {Promise<NodeManager>} Fully initialized manager
   *
   * @example
   *   const config = await loadConfig();
   *   const manager = await NodeManager.fromConfig(config.nodes);
   */
  static async fromConfig(nodesConfig) {
    const manager = new NodeManager();
    const entries = Object.entries(nodesConfig);

    if (entries.length === 0) {
      console.warn('[NodeManager] No nodes defined in config.');
      return manager;
    }

    // Connect to all nodes in parallel
    const results = await Promise.allSettled(
      entries.map(([name, nodeConfig]) => manager.addNode(name, nodeConfig))
    );

    // Report any failures
    const failures = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const [name] = entries[i];
        failures.push({ name, error: results[i].reason });
        console.error(
          `[NodeManager] Failed to connect to "${name}": ${results[i].reason.message}`
        );
      }
    }

    if (failures.length === entries.length) {
      throw new Error(
        `Failed to connect to all ${entries.length} configured nodes. ` +
        `Check LND is running and credentials are correct.`
      );
    }

    if (failures.length > 0) {
      console.warn(
        `[NodeManager] Connected to ${entries.length - failures.length}/${entries.length} nodes. ` +
        `Failed: ${failures.map(f => f.name).join(', ')}`
      );
    }

    return manager;
  }
}

export { NodeClient, LndError, SnapshotNodeClient };
