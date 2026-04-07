const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 300_000; // 5 minutes
const RECENT_EXECUTION_WINDOW_MS = 120_000; // 2 minutes
const RESTART_GAP_THRESHOLD_MS = 90_000;

/**
 * Polls LND feeReport() for assigned channels, detects unauthorized fee changes,
 * and logs violations to the audit chain.
 */
export class ChannelFeePolicyMonitor {
  constructor({ assignmentRegistry, auditLog, executor, nodeManager, pollIntervalMs }) {
    this._assignments = assignmentRegistry;
    this._auditLog = auditLog;
    this._executor = executor;
    this._nodeManager = nodeManager;
    this._pollIntervalMs = pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;

    // channel_point → { base_fee_msat, fee_per_mil }
    this._lastKnownState = new Map();
    this._timer = null;
    this._running = false;
    this._lastPollAt = null;
    this._totalPolls = 0;
    this._violationsDetected = 0;
    this._lndConnected = false;
    this._currentBackoff = this._pollIntervalMs;
    this._consecutiveFailures = 0;
  }

  async start() {
    if (this._running) return;
    this._running = true;

    // Detect restart gap
    const lastTs = this._auditLog.getLastTimestamp();
    if (lastTs && Date.now() - lastTs > RESTART_GAP_THRESHOLD_MS) {
      await this._auditLog.append({
        type: 'monitor_restarted',
        gap_ms: Date.now() - lastTs,
      });
    }

    // Initial baseline capture
    await this._poll(true);
    this._scheduleNext();
    console.log(`[ChannelMonitor] Started — polling every ${this._pollIntervalMs / 1000}s`);
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    console.log('[ChannelMonitor] Stopped');
  }

  _scheduleNext() {
    if (!this._running) return;
    this._timer = setTimeout(async () => {
      await this._poll(false);
      this._scheduleNext();
    }, this._currentBackoff);
  }

  async _poll(isBaseline) {
    const node = this._nodeManager.getScopedDefaultNodeOrNull('read');
    if (!node) {
      await this._handleLndDown();
      return;
    }

    let report;
    try {
      report = await node.feeReport();
    } catch (err) {
      console.warn(`[ChannelMonitor] feeReport failed: ${err.message}`);
      await this._handleLndDown();
      return;
    }

    // LND is back
    if (!this._lndConnected) {
      this._lndConnected = true;
      this._currentBackoff = this._pollIntervalMs;
      this._consecutiveFailures = 0;
      if (!isBaseline) {
        await this._auditLog.append({ type: 'lnd_reconnected' });
      }
    }

    // Build fee map: channel_point → fees
    const feeMap = new Map();
    for (const ch of report.channel_fees || []) {
      feeMap.set(ch.channel_point, {
        base_fee_msat: ch.base_fee_msat,
        fee_per_mil: ch.fee_per_mil,
      });
    }

    const assignedPoints = this._assignments.getAssignedChannelPoints();

    if (isBaseline) {
      // Capture initial state for all assigned channels
      for (const point of assignedPoints) {
        const fees = feeMap.get(point);
        if (fees) {
          this._lastKnownState.set(point, fees);
        }
      }
      await this._auditLog.append({
        type: 'monitor_started',
        assigned_channels: assignedPoints.size,
      });
    } else {
      // Compare against last known state
      for (const point of assignedPoints) {
        const current = feeMap.get(point);
        if (!current) continue; // Channel closed or not in report

        const previous = this._lastKnownState.get(point);
        if (!previous) {
          // Newly assigned since last poll — capture baseline
          this._lastKnownState.set(point, current);
          continue;
        }

        // Check if fees changed
        const baseChanged = current.base_fee_msat !== previous.base_fee_msat;
        const rateChanged = current.fee_per_mil !== previous.fee_per_mil;

        if (baseChanged || rateChanged) {
          // Was this change from a recent instruction execution?
          const chanId = this._assignments.getChanIdByPoint(point);
          const recentExec = this._executor.getRecentExecutions().get(chanId);
          const isAuthorized = recentExec && (Date.now() - recentExec.executedAt) < RECENT_EXECUTION_WINDOW_MS;

          if (!isAuthorized) {
            // Unauthorized change — violation
            const assignment = this._assignments.getAssignmentByPoint(point);
            await this._auditLog.append({
              type: 'violation_detected',
              chan_id: chanId,
              channel_point: point,
              agent_id: assignment?.agent_id,
              old_fees: previous,
              new_fees: current,
            });
            this._violationsDetected++;
          }

          // Update last known state regardless
          this._lastKnownState.set(point, current);
        }
      }

      // Clean up state for channels no longer assigned
      for (const point of this._lastKnownState.keys()) {
        if (!assignedPoints.has(point)) {
          this._lastKnownState.delete(point);
        }
      }
    }

    this._lastPollAt = Date.now();
    this._totalPolls++;
  }

  async _handleLndDown() {
    if (this._lndConnected) {
      this._lndConnected = false;
      await this._auditLog.append({ type: 'lnd_unreachable' }).catch(() => {});
    }
    this._consecutiveFailures++;
    // Exponential backoff: 30s → 60s → 120s → 300s max
    this._currentBackoff = Math.min(
      this._pollIntervalMs * Math.pow(2, this._consecutiveFailures),
      MAX_BACKOFF_MS,
    );
  }

  getStatus() {
    return {
      running: this._running,
      lastPollAt: this._lastPollAt,
      totalPolls: this._totalPolls,
      violationsDetected: this._violationsDetected,
      lndConnected: this._lndConnected,
      assignedChannels: this._assignments.getAssignedChannelPoints().size,
      currentBackoffMs: this._currentBackoff,
    };
  }
}
