/**
 * Agent Cashu Seed Manager
 *
 * Manages a master BIP39-compatible seed for deterministic Cashu wallet
 * operation (NUT-09/NUT-13). Each agent gets a unique seed derived via
 * HMAC-SHA256(masterSeed, agentId).
 *
 * Master seed stored at ~/.lightning-beam/cashu-master-seed.hex — OUTSIDE
 * the project data/ directory so it survives data wipes.
 */

import { randomBytes, createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export class AgentCashuSeedManager {
  constructor(seedPath) {
    this._seedPath = seedPath;
    this._masterSeed = null; // Buffer
  }

  async initialize() {
    try {
      const hex = (await readFile(this._seedPath, 'utf-8')).trim();
      this._masterSeed = Buffer.from(hex, 'hex');
      if (this._masterSeed.length !== 32) {
        throw new Error(`Invalid seed length: ${this._masterSeed.length} bytes (expected 32)`);
      }
      console.log(`[AgentCashuWallet] Master seed loaded from ${this._seedPath}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // First startup — generate new master seed
        this._masterSeed = randomBytes(32);
        await mkdir(dirname(this._seedPath), { recursive: true });
        await writeFile(this._seedPath, this._masterSeed.toString('hex') + '\n', 'utf-8');
        await chmod(this._seedPath, 0o600);
        console.log(
          `[AgentCashuWallet] \u26a0 MASTER SEED GENERATED \u2014 back up ${this._seedPath} ` +
          `to a safe location. This seed is the ONLY way to recover agent ecash balances if data is lost.`,
        );
      } else {
        throw err;
      }
    }
  }

  /**
   * Derive a per-agent 32-byte seed via HMAC-SHA256(masterSeed, agentId).
   * Returns Uint8Array suitable for cashu-ts bip39seed parameter.
   */
  deriveAgentSeed(agentId) {
    if (!this._masterSeed) throw new Error('Seed manager not initialized');
    const hmac = createHmac('sha256', this._masterSeed);
    hmac.update(agentId);
    return new Uint8Array(hmac.digest());
  }

  /** Return the master seed as hex for backup display. */
  getMasterSeedHex() {
    if (!this._masterSeed) throw new Error('Seed manager not initialized');
    return this._masterSeed.toString('hex');
  }
}
