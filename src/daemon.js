/**
 * AgentDaemon — lightweight daemon for the agent platform.
 * Initializes only agent-facing subsystems (~20 services).
 * Subset of lightning_beam's PanelDaemon (~550 lines → ~150 lines).
 */

import { loadConfig, getProjectRoot } from './config.js';
import { DataLayer } from './data-layer.js';
import { NodeManager } from './lnd/index.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LoopClient } from './loop/client.js';

// Identity
import { AgentRegistry } from './identity/registry.js';
import { acquire as acquireMutex } from './identity/mutex.js';
import { configureRateLimiterPersistence, configureRateLimiterPolicy } from './identity/rate-limiter.js';
import { SpendingVelocityTracker } from './identity/spending-velocity.js';
import {
  getChannelOpenSafetySettings,
  getHelpServiceSettings,
  getRateLimitSettings,
  getRebalanceSafetySettings,
  getSignedChannelSafetySettings,
  getSpendingVelocitySettings,
  getSwapServiceSettings,
  getWalletServiceSettings,
} from './identity/danger-route-settings.js';

// Wallet
import { PublicLedger } from './wallet/ledger.js';
import { HubWallet } from './wallet/hub-wallet.js';
import { AgentCashuProofStore } from './wallet/agent-cashu-proof-store.js';
import { AgentCashuWalletOperations } from './wallet/agent-cashu-wallet-operations.js';
import { AgentCashuSeedManager } from './wallet/agent-cashu-seed-manager.js';

// Social
import { AgentMessaging } from './social/messaging.js';
import { AllianceManager } from './social/alliances.js';
import { LineageTracker } from './social/lineage.js';
import { TournamentManager } from './tournaments/manager.js';
import { ExternalLeaderboard } from './identity/leaderboard.js';

// Channel accountability
import { HashChainAuditLog } from './channel-accountability/hash-chain-audit-log.js';
import { ChannelAssignmentRegistry } from './channel-accountability/channel-assignment-registry.js';
import { SignedInstructionExecutor } from './channel-accountability/signed-instruction-executor.js';
import { ChannelFeePolicyMonitor } from './channel-accountability/channel-fee-policy-monitor.js';

// Channel market
import {
  CapitalLedger, DepositTracker, ChannelOpener, ChannelCloser,
  RevenueAttributionTracker, SubmarineSwapProvider, MarketTransparency,
  PerformanceTracker, EcashChannelFunder, AnalyticsGateway, HelpEndpoint,
  LndCache, RebalanceExecutor, LightningCapitalFunder,
} from './channel-market/index.js';

export class AgentDaemon {
  constructor(configPath) {
    this._configPath = configPath;
    this._stopping = false;
  }

  async start() {
    console.log('[AgentDaemon] Starting...');
    const t0 = Date.now();
    this._startupWarnings = [];
    this._startupError = null;

    // 1. Config + DataLayer
    this.config = await loadConfig(this._configPath);
    this.dataLayer = new DataLayer(process.env.AOL_DATA_DIR || getProjectRoot());
    configureRateLimiterPersistence({ dataLayer: this.dataLayer });
    configureRateLimiterPolicy(getRateLimitSettings(this.config));

    // 2. Load API key (for help endpoint)
    if (!process.env.ANTHROPIC_API_KEY) {
      const keyPath = this.config.help?.apiKeyFile || process.env.ANTHROPIC_API_KEY_FILE;
      if (keyPath) {
        try {
          const k = (await readFile(keyPath, 'utf-8')).trim();
          if (k?.startsWith('sk-ant-')) process.env.ANTHROPIC_API_KEY = k;
        } catch { /* handled below */ }
      }
      if (!process.env.ANTHROPIC_API_KEY) {
        this._startupWarnings.push('ANTHROPIC_API_KEY missing');
      }
    }

    // 3. LND NodeManager
    this.nodeManager = new NodeManager();
    for (const [name, nodeConf] of Object.entries(this.config.nodes || {})) {
      try { await this.nodeManager.addNode(name, nodeConf); }
      catch (err) { console.error(`[AgentDaemon] Node "${name}" failed: ${err.message}`); }
    }
    if (this.nodeManager.getNodeNames().length === 0) {
      console.warn('[AgentDaemon] No LND nodes connected — running in limited mode');
      this._startupWarnings.push('No LND nodes connected');
    }

    // 4. Agent identity + wallet
    this.publicLedger = new PublicLedger(this.dataLayer);
    this.agentRegistry = new AgentRegistry(this.dataLayer);
    await this.agentRegistry.load();

    this.hubWallet = new HubWallet({
      dataLayer: this.dataLayer,
      nodeManager: this.nodeManager,
      ledger: this.publicLedger,
      config: getWalletServiceSettings(this.config),
    });

    const cashuProofStore = new AgentCashuProofStore(this.dataLayer);
    const seedPath = this.config.cashu?.seedPath || null;
    if (seedPath) {
      const cashuSeedManager = new AgentCashuSeedManager(seedPath);
      try { await cashuSeedManager.initialize(); this._cashuSeedManager = cashuSeedManager; }
      catch { this._cashuSeedManager = null; }
    } else {
      this._cashuSeedManager = null;
      this._startupWarnings.push('cashu.seedPath missing');
    }

    this.agentCashuWallet = new AgentCashuWalletOperations({
      proofStore: cashuProofStore,
      ledger: this.publicLedger,
      mintUrl: this.config.cashu?.mintUrl || null,
      mintPort: this.config.cashu?.port || null,
      seedManager: this._cashuSeedManager,
    });

    // 5. Social
    this.messaging = new AgentMessaging(this.dataLayer, this.agentRegistry);
    this.allianceManager = new AllianceManager(this.dataLayer, this.agentRegistry);
    this.lineageTracker = new LineageTracker(this.dataLayer, this.agentRegistry);
    this.tournamentManager = new TournamentManager(this.dataLayer, this.agentRegistry);
    this.externalLeaderboard = new ExternalLeaderboard(this.dataLayer, this.agentRegistry, null);
    await this.externalLeaderboard.load();

    // 6. Channel accountability
    const channelMutex = { acquire: acquireMutex };
    this.channelAuditLog = new HashChainAuditLog(this.dataLayer, channelMutex);
    await this.channelAuditLog._loadTail();
    this.channelAssignments = new ChannelAssignmentRegistry(this.dataLayer, this.channelAuditLog);
    await this.channelAssignments.load();
    this.channelExecutor = new SignedInstructionExecutor({
      assignmentRegistry: this.channelAssignments,
      auditLog: this.channelAuditLog,
      nodeManager: this.nodeManager,
      agentRegistry: this.agentRegistry,
      dataLayer: this.dataLayer,
      publicLedger: this.publicLedger,
      safetySettings: getSignedChannelSafetySettings(this.config),
    });
    await this.channelExecutor.loadCooldowns();
    this.channelMonitor = new ChannelFeePolicyMonitor({
      assignmentRegistry: this.channelAssignments,
      auditLog: this.channelAuditLog,
      executor: this.channelExecutor,
      nodeManager: this.nodeManager,
    });
    this.channelMonitor.start();

    // 7. Channel market
    this.capitalLedger = new CapitalLedger({
      dataLayer: this.dataLayer,
      auditLog: this.channelAuditLog,
      mutex: channelMutex,
      publicLedger: this.publicLedger,
    });

    this.analyticsGateway = new AnalyticsGateway({
      walletOps: this.agentCashuWallet,
      dataLayer: this.dataLayer,
      ledger: this.publicLedger,
      capitalLedger: this.capitalLedger,
      nodeManager: this.nodeManager,
    });

    this.spendingVelocity = new SpendingVelocityTracker(getSpendingVelocitySettings(this.config));

    this.depositTracker = new DepositTracker({
      capitalLedger: this.capitalLedger,
      nodeManager: this.nodeManager,
      dataLayer: this.dataLayer,
      auditLog: this.channelAuditLog,
      mutex: channelMutex,
    });
    await this.depositTracker.load();
    this.depositTracker.startPolling();

    try {
      this.loopClient = this.config.loop?.tlsCertPath && this.config.loop?.macaroonPath
        ? new LoopClient(this.config.loop)
        : null;
      this.lightningCapitalFunder = new LightningCapitalFunder({
        nodeManager: this.nodeManager,
        depositTracker: this.depositTracker,
        capitalLedger: this.capitalLedger,
        dataLayer: this.dataLayer,
        auditLog: this.channelAuditLog,
        mutex: channelMutex,
        loopClient: this.loopClient,
        config: this.config.loop || {},
      });
      await this.lightningCapitalFunder.load();
      this.lightningCapitalFunder.startPolling();
      if (!this.loopClient) {
        this._startupWarnings.push('loop config missing; Lightning capital deposits will use non-Loop bridge checks only');
      }
    } catch (err) {
      console.warn(`[AgentDaemon] Lightning capital funder init failed: ${err.message}`);
      this._startupWarnings.push(`Lightning capital funder unavailable: ${err.message}`);
      this.loopClient = null;
      this.lightningCapitalFunder = null;
    }

    this.channelOpener = new ChannelOpener({
      capitalLedger: this.capitalLedger,
      nodeManager: this.nodeManager,
      dataLayer: this.dataLayer,
      auditLog: this.channelAuditLog,
      agentRegistry: this.agentRegistry,
      assignmentRegistry: this.channelAssignments,
      mutex: channelMutex,
      config: getChannelOpenSafetySettings(this.config),
    });
    await this.channelOpener.load();
    this.channelOpener.startPolling();
    this.channelOpener.logStartupRules();

    this.ecashChannelFunder = new EcashChannelFunder({
      walletOps: this.agentCashuWallet,
      channelOpener: this.channelOpener,
      capitalLedger: this.capitalLedger,
      dataLayer: this.dataLayer,
      auditLog: this.channelAuditLog,
      mutex: channelMutex,
    });
    await this.ecashChannelFunder.load();

    this.channelCloser = new ChannelCloser({
      capitalLedger: this.capitalLedger,
      nodeManager: this.nodeManager,
      dataLayer: this.dataLayer,
      auditLog: this.channelAuditLog,
      agentRegistry: this.agentRegistry,
      assignmentRegistry: this.channelAssignments,
      mutex: channelMutex,
      config: this.config.channelClose || {},
    });
    await this.channelCloser.load();
    this.channelCloser.startPolling();
    this.channelCloser.logStartupRules();

    this.revenueTracker = new RevenueAttributionTracker({
      capitalLedger: this.capitalLedger,
      nodeManager: this.nodeManager,
      dataLayer: this.dataLayer,
      auditLog: this.channelAuditLog,
      assignmentRegistry: this.channelAssignments,
      mutex: channelMutex,
    });
    await this.revenueTracker.load();
    this.revenueTracker.startPolling();

    this.swapProvider = new SubmarineSwapProvider({
      capitalLedger: this.capitalLedger,
      nodeManager: this.nodeManager,
      dataLayer: this.dataLayer,
      auditLog: this.channelAuditLog,
      mutex: channelMutex,
      config: getSwapServiceSettings(this.config),
    });
    await this.swapProvider.load();
    this.swapProvider.startPolling();

    this.lndCache = new LndCache(this.nodeManager);

    this.marketTransparency = new MarketTransparency({
      assignmentRegistry: this.channelAssignments,
      agentRegistry: this.agentRegistry,
      lndCache: this.lndCache,
      revenueTracker: this.revenueTracker,
      auditLog: this.channelAuditLog,
    });

    this.performanceTracker = new PerformanceTracker({
      dataLayer: this.dataLayer,
      assignmentRegistry: this.channelAssignments,
      revenueTracker: this.revenueTracker,
      lndCache: this.lndCache,
      agentRegistry: this.agentRegistry,
    });
    await this.performanceTracker.load();
    this.performanceTracker.startPolling();
    this.externalLeaderboard._performanceTracker = this.performanceTracker;

    this.rebalanceExecutor = new RebalanceExecutor({
      capitalLedger: this.capitalLedger,
      nodeManager: this.nodeManager,
      dataLayer: this.dataLayer,
      auditLog: this.channelAuditLog,
      agentRegistry: this.agentRegistry,
      assignmentRegistry: this.channelAssignments,
      mutex: channelMutex,
      config: getRebalanceSafetySettings(this.config),
    });
    await this.rebalanceExecutor.load();

    // 8. Help endpoint
    try {
      this.helpEndpoint = new HelpEndpoint({
        agentRegistry: this.agentRegistry,
        assignmentRegistry: this.channelAssignments,
        auditLog: this.channelAuditLog,
        capitalLedger: this.capitalLedger,
        performanceTracker: this.performanceTracker,
        marketTransparency: this.marketTransparency,
        walletOps: this.agentCashuWallet,
        dataLayer: this.dataLayer,
        config: getHelpServiceSettings(this.config),
      });
    } catch (err) {
      console.warn(`[AgentDaemon] Help endpoint init failed: ${err.message}`);
      this._startupWarnings.push(`Help endpoint unavailable: ${err.message}`);
      this.helpEndpoint = null;
    }

    // 9. Background timers
    this._leaderboardTimer = setInterval(() => {
      this.externalLeaderboard?.update().catch(() => {});
      this.allianceManager?.expireOld().catch(() => {});
    }, 5 * 60 * 1000);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[AgentDaemon] Started in ${elapsed}s | ` +
      `Nodes: ${this.nodeManager.getNodeNames().length} | ` +
      `Agents: ${this.agentRegistry.count()} registered`
    );
  }

  async stop() {
    if (this._stopping) return;
    this._stopping = true;
    clearInterval(this._leaderboardTimer);
    this.channelMonitor?.stop?.();
    this.depositTracker?.stopPolling?.();
    this.lightningCapitalFunder?.stopPolling?.();
    this.channelOpener?.stopPolling?.();
    this.channelCloser?.stopPolling?.();
    this.revenueTracker?.stopPolling?.();
    this.swapProvider?.stopPolling?.();
    this.performanceTracker?.stopPolling?.();
    console.log('[AgentDaemon] Stopped');
  }

  getHealthSummary() {
    const nodes = this.nodeManager?.getNodeNames()?.length || 0;
    const degraded = Boolean(this._startupError) || nodes === 0;
    return {
      status: degraded ? 'degraded' : 'ok',
      degraded,
      agents: this.agentRegistry?.count?.() || 0,
      nodes,
      warnings: [...(this._startupWarnings || [])],
      startup_error: this._startupError,
    };
  }
}
