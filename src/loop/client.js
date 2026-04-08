import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;

function cleanText(value) {
  return String(value || '').trim();
}

function buildErrorMessage(err) {
  const stderr = cleanText(err?.stderr);
  const stdout = cleanText(err?.stdout);
  const message = cleanText(err?.message);
  return stderr || stdout || message || 'Loop command failed';
}

function extractSwapId(text) {
  const match = /swap id[:\s]+([0-9a-f]{8,})/i.exec(String(text || ''));
  return match ? match[1] : null;
}

function extractBitcoinAddress(text) {
  const match = /\b(bc1[a-z0-9]{20,}|[13][a-km-zA-HJ-NP-Z1-9]{25,62})\b/.exec(String(text || ''));
  return match ? match[1] : null;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class LoopClient {
  constructor(config = {}) {
    this.command = config.command || 'loop';
    this.rpcServer = config.rpcServer || null;
    this.network = config.network || null;
    this.loopDir = config.loopDir || null;
    this.tlsCertPath = config.tlsCertPath || null;
    this.macaroonPath = config.macaroonPath || null;
    this.timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.maxBuffer = Number.isFinite(config.maxBuffer) && config.maxBuffer > 0
      ? config.maxBuffer
      : DEFAULT_MAX_BUFFER;
  }

  _baseArgs() {
    const args = [];
    if (this.rpcServer) args.push('--rpcserver', this.rpcServer);
    if (this.network) args.push('--network', this.network);
    if (this.loopDir) args.push('--loopdir', this.loopDir);
    if (this.tlsCertPath) args.push('--tlscertpath', this.tlsCertPath);
    if (this.macaroonPath) args.push('--macaroonpath', this.macaroonPath);
    return args;
  }

  async _run(args, options = {}) {
    const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : this.timeoutMs;
    try {
      const { stdout = '', stderr = '' } = await execFileAsync(
        this.command,
        [...this._baseArgs(), ...args],
        {
          timeout,
          maxBuffer: this.maxBuffer,
        },
      );
      return {
        stdout: cleanText(stdout),
        stderr: cleanText(stderr),
      };
    } catch (err) {
      throw new Error(buildErrorMessage(err));
    }
  }

  async quoteOut(amountSats, options = {}) {
    const args = ['quote', 'out'];
    if (options.fast) args.push('--fast');
    if (Number.isInteger(options.confTarget) && options.confTarget > 0) {
      args.push('--conf_target', String(options.confTarget));
    }
    args.push(String(amountSats));
    return this._run(args);
  }

  async startLoopOut({ amountSats, destinationAddress, label, confTarget, maxSwapRoutingFeeSats, fast = false }) {
    const args = ['out', '--force', '--amt', String(amountSats)];
    if (destinationAddress) args.push('--addr', destinationAddress);
    if (label) args.push('--label', label);
    if (Number.isInteger(confTarget) && confTarget > 0) {
      args.push('--conf_target', String(confTarget));
    }
    if (Number.isInteger(maxSwapRoutingFeeSats) && maxSwapRoutingFeeSats >= 0) {
      args.push('--max_swap_routing_fee', String(maxSwapRoutingFeeSats));
    }
    if (fast) args.push('--fast');
    const result = await this._run(args, { timeoutMs: Math.max(this.timeoutMs, 120_000) });
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
    return {
      ...result,
      swapId: extractSwapId(combined),
      depositAddress: extractBitcoinAddress(combined),
    };
  }

  async listSwaps() {
    const result = await this._run(['listswaps']);
    return parseJson(result.stdout) || { swaps: [] };
  }

  async getSwapInfo(swapId) {
    const result = await this._run(['swapinfo', swapId]);
    return parseJson(result.stdout);
  }
}
