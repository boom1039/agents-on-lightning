function invalidSetting(path) {
  return new Error(`Missing or invalid hidden safety setting: ${path}. Set it in config/local.yaml.`);
}

function requireInteger(value, path, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) {
    throw invalidSetting(path);
  }
  return value;
}

function optionalInteger(value, path, { min = 0 } = {}) {
  if (value == null) return null;
  return requireInteger(value, path, { min });
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') {
    throw invalidSetting(path);
  }
  return value;
}

function requireCaps(caps, path) {
  return {
    autoApproveSats: optionalInteger(caps?.autoApproveSats, `${path}.autoApproveSats`),
    hardCapSats: optionalInteger(caps?.hardCapSats, `${path}.hardCapSats`),
    dailyAutoApproveSats: optionalInteger(caps?.dailyAutoApproveSats, `${path}.dailyAutoApproveSats`),
    dailyHardCapSats: optionalInteger(caps?.dailyHardCapSats, `${path}.dailyHardCapSats`),
    sharedDailyAutoApproveSats: optionalInteger(caps?.sharedDailyAutoApproveSats, `${path}.sharedDailyAutoApproveSats`),
    sharedDailyHardCapSats: optionalInteger(caps?.sharedDailyHardCapSats, `${path}.sharedDailyHardCapSats`),
  };
}

export function getDangerRouteSettings(config = {}) {
  const root = config.dangerRoutes || {};
  return {
    channels: {
      preview: {
        agentAttemptLimit: requireInteger(root.channels?.preview?.agentAttemptLimit, 'dangerRoutes.channels.preview.agentAttemptLimit', { min: 1 }),
        perChannelAttemptLimit: requireInteger(root.channels?.preview?.perChannelAttemptLimit, 'dangerRoutes.channels.preview.perChannelAttemptLimit', { min: 1 }),
        sharedAttemptLimit: requireInteger(root.channels?.preview?.sharedAttemptLimit, 'dangerRoutes.channels.preview.sharedAttemptLimit', { min: 1 }),
        attemptWindowMs: requireInteger(root.channels?.preview?.attemptWindowMs, 'dangerRoutes.channels.preview.attemptWindowMs', { min: 1 }),
      },
      instruct: {
        agentAttemptLimit: requireInteger(root.channels?.instruct?.agentAttemptLimit, 'dangerRoutes.channels.instruct.agentAttemptLimit', { min: 1 }),
        perChannelAttemptLimit: requireInteger(root.channels?.instruct?.perChannelAttemptLimit, 'dangerRoutes.channels.instruct.perChannelAttemptLimit', { min: 1 }),
        sharedAttemptLimit: requireInteger(root.channels?.instruct?.sharedAttemptLimit, 'dangerRoutes.channels.instruct.sharedAttemptLimit', { min: 1 }),
        attemptWindowMs: requireInteger(root.channels?.instruct?.attemptWindowMs, 'dangerRoutes.channels.instruct.attemptWindowMs', { min: 1 }),
        sharedCooldownMs: requireInteger(root.channels?.instruct?.sharedCooldownMs, 'dangerRoutes.channels.instruct.sharedCooldownMs', { min: 1 }),
      },
    },
    capitalWithdraw: {
      attemptLimit: requireInteger(root.capitalWithdraw?.attemptLimit, 'dangerRoutes.capitalWithdraw.attemptLimit', { min: 1 }),
      attemptWindowMs: requireInteger(root.capitalWithdraw?.attemptWindowMs, 'dangerRoutes.capitalWithdraw.attemptWindowMs', { min: 1 }),
      cooldownMs: requireInteger(root.capitalWithdraw?.cooldownMs, 'dangerRoutes.capitalWithdraw.cooldownMs', { min: 1 }),
      caps: requireCaps(root.capitalWithdraw?.caps, 'dangerRoutes.capitalWithdraw.caps'),
    },
    market: {
      sharedSuccessCooldownMs: requireInteger(root.market?.sharedSuccessCooldownMs, 'dangerRoutes.market.sharedSuccessCooldownMs', { min: 1 }),
      maxPendingOperations: requireInteger(root.market?.maxPendingOperations, 'dangerRoutes.market.maxPendingOperations', { min: 1 }),
      preview: {
        agentAttemptLimit: requireInteger(root.market?.preview?.agentAttemptLimit, 'dangerRoutes.market.preview.agentAttemptLimit', { min: 1 }),
        sharedAttemptLimit: requireInteger(root.market?.preview?.sharedAttemptLimit, 'dangerRoutes.market.preview.sharedAttemptLimit', { min: 1 }),
        attemptWindowMs: requireInteger(root.market?.preview?.attemptWindowMs, 'dangerRoutes.market.preview.attemptWindowMs', { min: 1 }),
        caps: requireCaps(root.market?.preview?.caps, 'dangerRoutes.market.preview.caps'),
      },
      open: {
        agentAttemptLimit: requireInteger(root.market?.open?.agentAttemptLimit, 'dangerRoutes.market.open.agentAttemptLimit', { min: 1 }),
        sharedAttemptLimit: requireInteger(root.market?.open?.sharedAttemptLimit, 'dangerRoutes.market.open.sharedAttemptLimit', { min: 1 }),
        attemptWindowMs: requireInteger(root.market?.open?.attemptWindowMs, 'dangerRoutes.market.open.attemptWindowMs', { min: 1 }),
        cooldownMs: requireInteger(root.market?.open?.cooldownMs, 'dangerRoutes.market.open.cooldownMs', { min: 1 }),
        caps: requireCaps(root.market?.open?.caps, 'dangerRoutes.market.open.caps'),
      },
      close: {
        agentAttemptLimit: requireInteger(root.market?.close?.agentAttemptLimit, 'dangerRoutes.market.close.agentAttemptLimit', { min: 1 }),
        sharedAttemptLimit: requireInteger(root.market?.close?.sharedAttemptLimit, 'dangerRoutes.market.close.sharedAttemptLimit', { min: 1 }),
        attemptWindowMs: requireInteger(root.market?.close?.attemptWindowMs, 'dangerRoutes.market.close.attemptWindowMs', { min: 1 }),
        cooldownMs: requireInteger(root.market?.close?.cooldownMs, 'dangerRoutes.market.close.cooldownMs', { min: 1 }),
      },
      swap: {
        agentAttemptLimit: requireInteger(root.market?.swap?.agentAttemptLimit, 'dangerRoutes.market.swap.agentAttemptLimit', { min: 1 }),
        sharedAttemptLimit: requireInteger(root.market?.swap?.sharedAttemptLimit, 'dangerRoutes.market.swap.sharedAttemptLimit', { min: 1 }),
        attemptWindowMs: requireInteger(root.market?.swap?.attemptWindowMs, 'dangerRoutes.market.swap.attemptWindowMs', { min: 1 }),
        cooldownMs: requireInteger(root.market?.swap?.cooldownMs, 'dangerRoutes.market.swap.cooldownMs', { min: 1 }),
        caps: requireCaps(root.market?.swap?.caps, 'dangerRoutes.market.swap.caps'),
      },
      fundFromEcash: {
        agentAttemptLimit: requireInteger(root.market?.fundFromEcash?.agentAttemptLimit, 'dangerRoutes.market.fundFromEcash.agentAttemptLimit', { min: 1 }),
        sharedAttemptLimit: requireInteger(root.market?.fundFromEcash?.sharedAttemptLimit, 'dangerRoutes.market.fundFromEcash.sharedAttemptLimit', { min: 1 }),
        attemptWindowMs: requireInteger(root.market?.fundFromEcash?.attemptWindowMs, 'dangerRoutes.market.fundFromEcash.attemptWindowMs', { min: 1 }),
        cooldownMs: requireInteger(root.market?.fundFromEcash?.cooldownMs, 'dangerRoutes.market.fundFromEcash.cooldownMs', { min: 1 }),
        caps: requireCaps(root.market?.fundFromEcash?.caps, 'dangerRoutes.market.fundFromEcash.caps'),
      },
      rebalance: {
        agentAttemptLimit: requireInteger(root.market?.rebalance?.agentAttemptLimit, 'dangerRoutes.market.rebalance.agentAttemptLimit', { min: 1 }),
        sharedAttemptLimit: requireInteger(root.market?.rebalance?.sharedAttemptLimit, 'dangerRoutes.market.rebalance.sharedAttemptLimit', { min: 1 }),
        attemptWindowMs: requireInteger(root.market?.rebalance?.attemptWindowMs, 'dangerRoutes.market.rebalance.attemptWindowMs', { min: 1 }),
        cooldownMs: requireInteger(root.market?.rebalance?.cooldownMs, 'dangerRoutes.market.rebalance.cooldownMs', { min: 1 }),
        caps: requireCaps(root.market?.rebalance?.caps, 'dangerRoutes.market.rebalance.caps'),
      },
      rebalanceEstimate: {
        agentAttemptLimit: requireInteger(root.market?.rebalanceEstimate?.agentAttemptLimit, 'dangerRoutes.market.rebalanceEstimate.agentAttemptLimit', { min: 1 }),
        sharedAttemptLimit: requireInteger(root.market?.rebalanceEstimate?.sharedAttemptLimit, 'dangerRoutes.market.rebalanceEstimate.sharedAttemptLimit', { min: 1 }),
        attemptWindowMs: requireInteger(root.market?.rebalanceEstimate?.attemptWindowMs, 'dangerRoutes.market.rebalanceEstimate.attemptWindowMs', { min: 1 }),
      },
    },
  };
}

export function getSignedChannelSafetySettings(config = {}) {
  return {
    defaultCooldownMinutes: requireInteger(
      config.safety?.signedChannels?.defaultCooldownMinutes,
      'safety.signedChannels.defaultCooldownMinutes',
      { min: 1 },
    ),
  };
}

export function getChannelOpenSafetySettings(config = {}) {
  const root = config.channelOpen || {};
  return {
    minChannelSizeSats: requireInteger(root.minChannelSizeSats, 'channelOpen.minChannelSizeSats', { min: 1 }),
    maxChannelSizeSats: requireInteger(root.maxChannelSizeSats, 'channelOpen.maxChannelSizeSats', { min: 1 }),
    maxTotalChannels: optionalInteger(root.maxTotalChannels, 'channelOpen.maxTotalChannels', { min: 1 }),
    maxPerAgent: optionalInteger(root.maxPerAgent, 'channelOpen.maxPerAgent', { min: 1 }),
    pendingOpenTimeoutBlocks: requireInteger(root.pendingOpenTimeoutBlocks, 'channelOpen.pendingOpenTimeoutBlocks', { min: 1 }),
    connectPeerTimeoutMs: requireInteger(root.connectPeerTimeoutMs, 'channelOpen.connectPeerTimeoutMs', { min: 1 }),
    defaultSatPerVbyte: optionalInteger(root.defaultSatPerVbyte, 'channelOpen.defaultSatPerVbyte', { min: 1 }),
    peerSafety: {
      forceCloseLimit: requireInteger(root.peerSafety?.forceCloseLimit, 'channelOpen.peerSafety.forceCloseLimit'),
      requireAllowlist: requireBoolean(root.peerSafety?.requireAllowlist, 'channelOpen.peerSafety.requireAllowlist'),
      minPeerChannels: requireInteger(root.peerSafety?.minPeerChannels, 'channelOpen.peerSafety.minPeerChannels', { min: 1 }),
      maxPeerLastUpdateAgeSeconds: requireInteger(root.peerSafety?.maxPeerLastUpdateAgeSeconds, 'channelOpen.peerSafety.maxPeerLastUpdateAgeSeconds', { min: 1 }),
    },
    startupPolicyLimits: {
      minBaseFeeMsat: requireInteger(root.startupPolicyLimits?.minBaseFeeMsat, 'channelOpen.startupPolicyLimits.minBaseFeeMsat'),
      maxBaseFeeMsat: requireInteger(root.startupPolicyLimits?.maxBaseFeeMsat, 'channelOpen.startupPolicyLimits.maxBaseFeeMsat'),
      minFeeRatePpm: requireInteger(root.startupPolicyLimits?.minFeeRatePpm, 'channelOpen.startupPolicyLimits.minFeeRatePpm'),
      maxFeeRatePpm: requireInteger(root.startupPolicyLimits?.maxFeeRatePpm, 'channelOpen.startupPolicyLimits.maxFeeRatePpm'),
      minTimeLockDelta: requireInteger(root.startupPolicyLimits?.minTimeLockDelta, 'channelOpen.startupPolicyLimits.minTimeLockDelta', { min: 1 }),
      maxTimeLockDelta: requireInteger(root.startupPolicyLimits?.maxTimeLockDelta, 'channelOpen.startupPolicyLimits.maxTimeLockDelta', { min: 1 }),
    },
  };
}

export function getRebalanceSafetySettings(config = {}) {
  const root = config.rebalance || {};
  return {
    minAmountSats: requireInteger(root.minAmountSats, 'rebalance.minAmountSats', { min: 1 }),
    maxAmountSats: requireInteger(root.maxAmountSats, 'rebalance.maxAmountSats', { min: 1 }),
    maxFeeSats: requireInteger(root.maxFeeSats, 'rebalance.maxFeeSats', { min: 1 }),
    paymentTimeoutSeconds: requireInteger(root.paymentTimeoutSeconds, 'rebalance.paymentTimeoutSeconds', { min: 1 }),
    maxConcurrentPerAgent: requireInteger(root.maxConcurrentPerAgent, 'rebalance.maxConcurrentPerAgent', { min: 1 }),
  };
}

export function getSwapServiceSettings(config = {}) {
  const root = config.swap || {};
  return {
    minSwapSats: requireInteger(root.minSwapSats, 'swap.minSwapSats', { min: 1 }),
    maxSwapSats: requireInteger(root.maxSwapSats, 'swap.maxSwapSats', { min: 1 }),
    maxConcurrentSwaps: requireInteger(root.maxConcurrentSwaps, 'swap.maxConcurrentSwaps', { min: 1 }),
    pollIntervalMs: requireInteger(root.pollIntervalMs, 'swap.pollIntervalMs', { min: 1 }),
    invoiceTimeoutSeconds: requireInteger(root.invoiceTimeoutSeconds, 'swap.invoiceTimeoutSeconds', { min: 1 }),
    feeLimitSat: requireInteger(root.feeLimitSat, 'swap.feeLimitSat', { min: 1 }),
    swapExpiryMs: requireInteger(root.swapExpiryMs, 'swap.swapExpiryMs', { min: 1 }),
  };
}

export function getHelpServiceSettings(config = {}) {
  const root = config.help || {};
  return {
    rateLimit: requireInteger(root.rateLimit, 'help.rateLimit', { min: 1 }),
    rateWindowMs: requireInteger(root.rateWindowMs, 'help.rateWindowMs', { min: 1 }),
    upstreamTimeoutMs: requireInteger(root.upstreamTimeoutMs, 'help.upstreamTimeoutMs', { min: 1 }),
    circuitFailureLimit: requireInteger(root.circuitFailureLimit, 'help.circuitFailureLimit', { min: 1 }),
    circuitFailureWindowMs: requireInteger(root.circuitFailureWindowMs, 'help.circuitFailureWindowMs', { min: 1 }),
    circuitOpenMs: requireInteger(root.circuitOpenMs, 'help.circuitOpenMs', { min: 1 }),
  };
}

export function getWalletServiceSettings(config = {}) {
  const root = config.wallet || {};
  return {
    maxRoutingFeeSats: requireInteger(root.maxRoutingFeeSats, 'wallet.maxRoutingFeeSats', { min: 1 }),
    withdrawalTimeoutSeconds: requireInteger(root.withdrawalTimeoutSeconds, 'wallet.withdrawalTimeoutSeconds', { min: 1 }),
  };
}
