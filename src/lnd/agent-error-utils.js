function sanitizeLndDetail(errMsg) {
  return String(errMsg || '').replace(/\/[^\s]+/g, '[path]').trim();
}

function btcStringToSats(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const sats = `${whole}${fraction.padEnd(8, '0').slice(0, 8)}`;
  const parsed = Number.parseInt(sats, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function withDetails(message, detail) {
  if (!detail || message.includes(detail)) return message;
  return `${message} Details: ${detail}`;
}

export function summarizeLndError(errMsg, { action = 'request', fallback = 'LND request failed.' } = {}) {
  const detail = sanitizeLndDetail(errMsg);

  const minSizeMatch = /chan size of ([\d.]+) BTC is below min chan size of ([\d.]+) BTC/i.exec(detail);
  if (minSizeMatch) {
    const attemptedSats = btcStringToSats(minSizeMatch[1]);
    const minSats = btcStringToSats(minSizeMatch[2]);
    if (Number.isFinite(minSats) && Number.isFinite(attemptedSats)) {
      return `Channel too small. You tried ${attemptedSats} sats, but this peer requires at least ${minSats} sats.`;
    }
    if (Number.isFinite(minSats)) {
      return `Channel too small. This peer requires at least ${minSats} sats.`;
    }
  }

  if (/not enough witness outputs to create funding transaction/i.test(detail)) {
    return withDetails('The node wallet cannot construct the channel-funding transaction right now. Treat this as a channel-open infrastructure blocker and do not assume any mining-fee subsidy.', detail);
  }
  if (/peer is not connected|peer not online|unable to locate/i.test(detail)) {
    return withDetails('Could not connect to peer. The node may be offline or unreachable.', detail);
  }
  if (/peer .* disconnected/i.test(detail)) {
    return withDetails(`The node lost the peer during the real ${action} attempt.`, detail);
  }
  if (/wallet is fully synced/i.test(detail)) {
    return withDetails('Node is syncing. Try again in a few minutes.', detail);
  }
  if (/pending channels exceed maximum/i.test(detail)) {
    return withDetails('Too many channels pending confirmation. Wait for current opens to confirm.', detail);
  }
  if (/timed out|timeout/i.test(detail)) {
    return withDetails(`The node did not answer before the ${action} timeout.`, detail);
  }
  if (/channel not found/i.test(detail)) {
    return withDetails('The node could not find that channel.', detail);
  }
  if (/insufficient .*balance|insufficient funds/i.test(detail)) {
    return withDetails('The node does not have enough funds for that action.', detail);
  }

  return withDetails(fallback, detail);
}

export function sanitizeLndMessage(errMsg) {
  return sanitizeLndDetail(errMsg);
}
