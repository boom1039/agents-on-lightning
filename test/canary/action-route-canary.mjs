#!/usr/bin/env node

import { loadSavedAgent, signInstruction, authHeaders } from './saved-agent.mjs';

const BASE_URL = (process.env.AOL_CANARY_BASE_URL || 'http://127.0.0.1:3302').replace(/\/+$/, '');
const TIMEOUT_MS = Number.parseInt(process.env.AOL_CANARY_TIMEOUT_MS || '20000', 10);
const OPEN_PEER_PUBKEY = `${process.env.AOL_CANARY_OPEN_PEER_PUBKEY || ''}`.trim();
const OPEN_AMOUNT_SATS = Number.parseInt(process.env.AOL_CANARY_OPEN_AMOUNT_SATS || '100000', 10);
const REBALANCE_AMOUNT_SATS = Number.parseInt(process.env.AOL_CANARY_REBALANCE_AMOUNT_SATS || '10000', 10);
const SWAP_QUOTE_AMOUNT_SATS = Number.parseInt(process.env.AOL_CANARY_SWAP_QUOTE_AMOUNT_SATS || '100000', 10);
const ALLOW_REAL_CLOSE = process.env.AOL_CANARY_ALLOW_REAL_CLOSE === '1';
const ALLOW_REAL_SWAP = process.env.AOL_CANARY_ALLOW_REAL_SWAP === '1';
const SWAP_ONCHAIN_ADDRESS = `${process.env.AOL_CANARY_SWAP_ONCHAIN_ADDRESS || ''}`.trim();
const SWAP_AMOUNT_SATS = Number.parseInt(process.env.AOL_CANARY_SWAP_AMOUNT_SATS || '100000', 10);

async function fetchJson(path, {
  method = 'GET',
  headers = {},
  body,
} = {}) {
  const response = await fetch(new URL(path, `${BASE_URL}/`), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    ok: response.ok,
    status: response.status,
    data,
    text,
  };
}

function step(name, result, extra = {}) {
  return {
    step: name,
    status: result?.status ?? null,
    ok: Boolean(result?.ok),
    message: result?.data?.message || result?.data?.error || null,
    failed_at: result?.data?.failed_at || null,
    skipped: false,
    ...extra,
  };
}

function skipped(name, reason) {
  return {
    step: name,
    skipped: true,
    reason,
  };
}

async function putPubkey(savedAgent) {
  if (!savedAgent.pubkey) return { skipped: true };
  return fetchJson('/api/v1/agents/me', {
    method: 'PUT',
    headers: {
      ...authHeaders(savedAgent),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pubkey: savedAgent.pubkey }),
  });
}

async function signedPost(savedAgent, path, instruction) {
  const signature = await signInstruction(savedAgent, instruction);
  return fetchJson(path, {
    method: 'POST',
    headers: {
      ...authHeaders(savedAgent),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ instruction, signature }),
  });
}

function makePolicyInstruction(savedAgent, chanId) {
  return {
    action: 'set_fee_policy',
    agent_id: savedAgent.agent_id,
    channel_id: chanId,
    params: {
      base_fee_msat: 0,
      fee_rate_ppm: 1,
    },
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function makeOpenInstruction(savedAgent, peerPubkey) {
  return {
    action: 'channel_open',
    agent_id: savedAgent.agent_id,
    params: {
      local_funding_amount_sats: OPEN_AMOUNT_SATS,
      peer_pubkey: peerPubkey,
    },
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function makeCloseInstruction(savedAgent, channelPoint) {
  return {
    action: 'channel_close',
    agent_id: savedAgent.agent_id,
    params: {
      channel_point: channelPoint,
    },
    timestamp: Math.floor(Date.now() / 1000),
  };
}

async function main() {
  const savedAgent = await loadSavedAgent();
  const steps = [];

  const pubkeyResult = await putPubkey(savedAgent);
  steps.push(pubkeyResult.skipped ? skipped('ensure_pubkey', 'saved agent has no pubkey') : step('ensure_pubkey', pubkeyResult));

  const channelsMine = await fetchJson('/api/v1/channels/mine', {
    headers: authHeaders(savedAgent),
  });
  steps.push(step('channels_mine', channelsMine));

  const closes = await fetchJson('/api/v1/market/closes', {
    headers: authHeaders(savedAgent),
  });
  steps.push(step('market_closes', closes));

  const rebalances = await fetchJson('/api/v1/market/rebalances', {
    headers: authHeaders(savedAgent),
  });
  steps.push(step('market_rebalances', rebalances));

  const swapQuote = await fetchJson(`/api/v1/market/swap/quote?amount_sats=${SWAP_QUOTE_AMOUNT_SATS}`, {
    headers: authHeaders(savedAgent),
  });
  steps.push(step('market_swap_quote', swapQuote));

  const channels = Array.isArray(channelsMine?.data?.channels) ? channelsMine.data.channels : [];
  const firstChannel = channels[0] || null;

  if (firstChannel?.chan_id) {
    const previewPolicy = await signedPost(
      savedAgent,
      '/api/v1/channels/preview',
      makePolicyInstruction(savedAgent, firstChannel.chan_id),
    );
    steps.push(step('channels_preview_policy', previewPolicy, {
      chan_id: firstChannel.chan_id,
      channel_point: firstChannel.channel_point || null,
    }));

    const rebalanceEstimate = await fetchJson('/api/v1/market/rebalance/estimate', {
      method: 'POST',
      headers: {
        ...authHeaders(savedAgent),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        outbound_chan_id: firstChannel.chan_id,
        amount_sats: REBALANCE_AMOUNT_SATS,
      }),
    });
    steps.push(step('market_rebalance_estimate', rebalanceEstimate, {
      chan_id: firstChannel.chan_id,
      channel_point: firstChannel.channel_point || null,
    }));
  } else {
    steps.push(skipped('channels_preview_policy', 'agent has no assigned channel'));
    steps.push(skipped('market_rebalance_estimate', 'agent has no assigned channel'));
  }

  if (OPEN_PEER_PUBKEY) {
    const previewOpen = await signedPost(
      savedAgent,
      '/api/v1/market/preview',
      makeOpenInstruction(savedAgent, OPEN_PEER_PUBKEY),
    );
    steps.push(step('market_open_preview', previewOpen, {
      peer_pubkey: OPEN_PEER_PUBKEY,
      amount_sats: OPEN_AMOUNT_SATS,
    }));
  } else {
    steps.push(skipped('market_open_preview', 'set AOL_CANARY_OPEN_PEER_PUBKEY to exercise open preview'));
  }

  if (ALLOW_REAL_CLOSE && firstChannel?.channel_point) {
    const closeResult = await signedPost(
      savedAgent,
      '/api/v1/market/close',
      makeCloseInstruction(savedAgent, firstChannel.channel_point),
    );
    steps.push(step('market_close_real', closeResult, {
      channel_point: firstChannel.channel_point,
    }));
  } else {
    steps.push(skipped('market_close_real', 'set AOL_CANARY_ALLOW_REAL_CLOSE=1 and ensure the agent has a channel'));
  }

  if (ALLOW_REAL_SWAP && SWAP_ONCHAIN_ADDRESS) {
    const swapResult = await fetchJson('/api/v1/market/swap/lightning-to-onchain', {
      method: 'POST',
      headers: {
        ...authHeaders(savedAgent),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount_sats: SWAP_AMOUNT_SATS,
        onchain_address: SWAP_ONCHAIN_ADDRESS,
      }),
    });
    steps.push(step('market_swap_real', swapResult, {
      amount_sats: SWAP_AMOUNT_SATS,
    }));
  } else {
    steps.push(skipped('market_swap_real', 'set AOL_CANARY_ALLOW_REAL_SWAP=1 and AOL_CANARY_SWAP_ONCHAIN_ADDRESS to exercise live swap'));
  }

  const summary = {
    base_url: BASE_URL,
    agent: {
      id: savedAgent.agent_id,
      name: savedAgent.name || null,
      metadata_path: savedAgent.metadata_path,
    },
    steps,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
