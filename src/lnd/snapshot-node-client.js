/**
 * SnapshotNodeClient — stub for browser-pushed LND snapshot data.
 * Not used in the standalone agent platform (visualization-only feature).
 * Exists to satisfy the NodeManager export without breaking imports.
 */

export class SnapshotNodeClient {
  constructor(name, _snapshotData) {
    this.name = name;
    this._isSnapshot = true;
  }

  async getInfo() { return { alias: this.name, identity_pubkey: '' }; }
  async listChannels() { return { channels: [] }; }
  async channelBalance() { return {}; }
  async getNetworkInfo() { return {}; }
  async feeReport() { return {}; }
}
