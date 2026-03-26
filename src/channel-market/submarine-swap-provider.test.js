/**
 * Submarine Swap Provider — Unit tests with mocked Boltz API.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SubmarineSwapProvider } from './submarine-swap-provider.js';
import { mockDataLayer, mockAuditLog, mockCapitalLedger, mockMutex, mockNodeManager } from './test-mock-factories.js';

const SWAP_LND_DEFAULTS = {
  sendPayment: async () => ({ payment_preimage: 'abc123preimage', payment_hash: 'hash456', payment_error: '' }),
  listChannels: async () => ({ channels: [{ local_balance: '5000000', remote_balance: '5000000' }] }),
};

function swapNodeManager(overrides = {}) {
  return mockNodeManager({ ...SWAP_LND_DEFAULTS, ...overrides });
}

// Mock global fetch for Boltz API
let fetchMock = null;

function installFetchMock(handler) {
  fetchMock = handler;
  globalThis._originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (fetchMock) return fetchMock(url, opts);
    return globalThis._originalFetch(url, opts);
  };
}

function restoreFetch() {
  if (globalThis._originalFetch) {
    globalThis.fetch = globalThis._originalFetch;
    delete globalThis._originalFetch;
  }
  fetchMock = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubmarineSwapProvider', () => {
  const AGENT_ID = 'test-agent-1';
  const ONCHAIN_ADDRESS = 'bc1qtest123456789';

  afterEach(() => {
    restoreFetch();
  });

  function makeProvider(overrides = {}) {
    return new SubmarineSwapProvider({
      capitalLedger: overrides.capitalLedger || mockCapitalLedger(),
      nodeManager: overrides.nodeManager || swapNodeManager(),
      dataLayer: mockDataLayer(),
      auditLog: mockAuditLog(),
      mutex: mockMutex(),
    });
  }

  it('rejects swap below minimum', async () => {
    const provider = makeProvider();
    await provider.load();

    const result = await provider.createSwap(AGENT_ID, {
      amount_sats: 10_000,
      onchain_address: ONCHAIN_ADDRESS,
    });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('between'));
  });

  it('rejects swap above maximum', async () => {
    const provider = makeProvider();
    await provider.load();

    const result = await provider.createSwap(AGENT_ID, {
      amount_sats: 10_000_000,
      onchain_address: ONCHAIN_ADDRESS,
    });
    assert.equal(result.success, false);
  });

  it('rejects missing onchain_address', async () => {
    const provider = makeProvider();
    await provider.load();

    const result = await provider.createSwap(AGENT_ID, { amount_sats: 100_000 });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('onchain_address'));
  });

  it('creates swap with valid params (mocked Boltz)', async () => {
    installFetchMock(async (url, opts) => {
      if (opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            id: 'boltz-swap-123',
            invoice: 'lnbc100000...',
            lockupAddress: 'bc1qboltzlockup...',
            onchainAmount: 99_500,
            timeoutBlockHeight: 900_000,
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const provider = makeProvider();
    await provider.load();

    const result = await provider.createSwap(AGENT_ID, {
      amount_sats: 100_000,
      onchain_address: ONCHAIN_ADDRESS,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'invoice_paid');
    assert.ok(result.swap_id);
  });

  it('handles Lightning payment failure', async () => {
    installFetchMock(async (url, opts) => {
      if (opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            id: 'boltz-swap-fail',
            invoice: 'lnbc100000...',
            lockupAddress: 'bc1qboltzlockup...',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const provider = makeProvider({
      nodeManager: swapNodeManager({
        sendPayment: async () => ({ payment_preimage: '', payment_hash: '', payment_error: 'no route found' }),
      }),
    });
    await provider.load();

    const result = await provider.createSwap(AGENT_ID, {
      amount_sats: 100_000,
      onchain_address: ONCHAIN_ADDRESS,
    });

    assert.equal(result.success, false);
    assert.ok(result.error.includes('no route found'));
  });

  it('enforces concurrent swap limit', async () => {
    let callCount = 0;
    installFetchMock(async (url, opts) => {
      if (opts?.method === 'POST') {
        callCount++;
        return {
          ok: true,
          json: async () => ({
            id: `boltz-limit-${callCount}-${Date.now()}`,
            invoice: 'lnbc100000...',
            lockupAddress: 'bc1q...',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const provider = makeProvider();
    await provider.load();

    // Create 3 swaps (max)
    for (let i = 0; i < 3; i++) {
      await provider.createSwap(AGENT_ID, {
        amount_sats: 100_000,
        onchain_address: ONCHAIN_ADDRESS,
      });
    }

    // 4th should be rejected
    const result = await provider.createSwap(AGENT_ID, {
      amount_sats: 100_000,
      onchain_address: ONCHAIN_ADDRESS,
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 429);
  });

  it('returns swap history for agent', async () => {
    installFetchMock(async (url, opts) => {
      if (opts?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            id: 'boltz-hist-1',
            invoice: 'lnbc...',
            lockupAddress: 'bc1q...',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const provider = makeProvider();
    await provider.load();

    await provider.createSwap(AGENT_ID, {
      amount_sats: 100_000,
      onchain_address: ONCHAIN_ADDRESS,
    });

    const history = provider.getSwapHistory(AGENT_ID);
    assert.equal(history.length, 1);
    assert.equal(history[0].agent_id, AGENT_ID);
    // Should not expose claim_private_key
    assert.equal(history[0].claim_private_key, undefined);
  });

  it('returns null for unknown swap status', () => {
    const provider = makeProvider();
    assert.equal(provider.getSwapStatus('nonexistent'), null);
  });
});
