const DEFAULT_RECEIVE_SAFETY_BUFFER_SATS = 1000;

function nowIso() {
  return new Date().toISOString();
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getRemoteReserveSats(channel) {
  return toInt(
    channel?.remote_chan_reserve_sat
      ?? channel?.remote_constraints?.chan_reserve_sat
      ?? 0,
  );
}

function receivableSatsForChannel(channel, safetyBufferSats) {
  const remoteBalance = toInt(channel?.remote_balance);
  const unsettled = toInt(channel?.unsettled_balance);
  const reserve = getRemoteReserveSats(channel);
  return Math.max(0, remoteBalance - unsettled - reserve - safetyBufferSats);
}

export class ReceivePreflightError extends Error {
  constructor(message, receivePreflight) {
    super(message);
    this.name = 'ReceivePreflightError';
    this.statusCode = 409;
    this.receivePreflight = receivePreflight;
  }
}

export async function buildSingleChannelReceivePreflight(client, amountSats, options = {}) {
  const safetyBufferSats = Number.isInteger(options.safetyBufferSats)
    ? Math.max(0, options.safetyBufferSats)
    : DEFAULT_RECEIVE_SAFETY_BUFFER_SATS;
  const base = {
    checked_at: nowIso(),
    amount_sats: amountSats,
    decision_basis: 'largest_single_active_channel',
    safety_buffer_sats: safetyBufferSats,
  };

  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    return {
      ...base,
      can_receive: false,
      largest_single_channel_receivable_sats: 0,
      total_receivable_sats: 0,
      active_channels: 0,
      usable_channels: 0,
      suggested_max_sats: 0,
      reason: 'amount_sats must be a positive integer.',
    };
  }

  if (!client || typeof client.listChannels !== 'function') {
    return {
      ...base,
      can_receive: false,
      largest_single_channel_receivable_sats: 0,
      total_receivable_sats: 0,
      active_channels: 0,
      usable_channels: 0,
      suggested_max_sats: 0,
      reason: 'No read-capable LND client is available to verify inbound liquidity.',
    };
  }

  try {
    const response = await client.listChannels();
    const channels = Array.isArray(response?.channels) ? response.channels : [];
    const activeChannels = channels.filter((channel) => channel?.active !== false);
    const receivable = activeChannels
      .map((channel) => receivableSatsForChannel(channel, safetyBufferSats))
      .filter((amount) => amount > 0)
      .sort((a, b) => b - a);
    const largest = receivable[0] || 0;
    const total = receivable.reduce((sum, amount) => sum + amount, 0);
    const canReceive = largest >= amountSats;

    return {
      ...base,
      can_receive: canReceive,
      largest_single_channel_receivable_sats: largest,
      total_receivable_sats: total,
      active_channels: activeChannels.length,
      usable_channels: receivable.length,
      suggested_max_sats: largest,
      reason: canReceive
        ? null
        : `No single inbound channel can receive ${amountSats} sats. Largest can receive ${largest} sats.`,
    };
  } catch (err) {
    return {
      ...base,
      can_receive: false,
      largest_single_channel_receivable_sats: 0,
      total_receivable_sats: 0,
      active_channels: 0,
      usable_channels: 0,
      suggested_max_sats: 0,
      reason: `Could not verify inbound liquidity: ${err.message}`,
    };
  }
}
