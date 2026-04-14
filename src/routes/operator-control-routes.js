import { Router } from 'express';
import { resetCounters } from '../identity/rate-limiter.js';
import { DangerRoutePolicyStore } from '../identity/danger-route-policy.js';
import { rejectUnauthorizedOperatorRoute, rejectUnauthorizedTestRoute } from '../identity/request-security.js';
import { validateChannelIdOrPoint } from '../identity/validators.js';

function optionalCreatedAtMs(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('created_at_ms must be a positive safe integer when provided');
  }
  return parsed;
}

function proofSummary(row) {
  if (!row) return null;
  return {
    proof_id: row.proof_id,
    proof_record_type: row.proof_record_type,
    money_event_type: row.money_event_type,
    money_event_status: row.money_event_status,
    global_sequence: row.global_sequence,
    proof_hash: row.proof_hash,
    previous_global_proof_hash: row.previous_global_proof_hash,
    signing_key_id: row.signing_key_id,
    issuer_domains: row.issuer_domains,
    public_safe_refs: row.public_safe_refs,
    created_at_ms: row.created_at_ms,
  };
}

function proofLedgerUnavailable(res) {
  return res.status(503).json({
    error: 'proof_ledger_unavailable',
    message: 'Proof Ledger is not enabled on this server.',
  });
}

function proofResponse(daemon, proof) {
  return {
    status: 'created',
    source_of_truth: 'proof_ledger',
    proof: proofSummary(proof),
    verification: daemon.proofLedger.verifyProof(proof),
    global_chain: daemon.proofLedger.verifyChain(),
    public_key: daemon.proofLedger.getPublicKeyInfo(),
  };
}

export function operatorControlRoutes(daemon) {
  const router = Router();

  router.post('/api/v1/test/reset-rate-limits', async (req, res) => {
    const rejection = rejectUnauthorizedTestRoute(req, res);
    if (rejection) return rejection;
    await resetCounters();
    await DangerRoutePolicyStore.resetAllForTests();
    await daemon.channelExecutor?.resetForTests?.();
    return res.json({ status: 'ok', message: 'Local test guards cleared.' });
  });

  router.post('/api/v1/channels/assign', async (req, res) => {
    const rejection = rejectUnauthorizedOperatorRoute(req, res);
    if (rejection) return rejection;
    try {
      const { channel_point, remote_pubkey, agent_id, constraints } = req.body;
      if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
      if (!channel_point && !remote_pubkey) return res.status(400).json({ error: 'channel_point or remote_pubkey required' });

      const profile = daemon.agentRegistry.getById(agent_id);
      if (!profile) return res.status(404).json({ error: 'Agent not found' });

      const channels = await daemon.lndCache?.getChannelsLive?.();
      if (!channels) return res.status(503).json({ error: 'LND node not available' });

      let match;
      if (channel_point) {
        match = channels.find((c) => c.channel_point === channel_point);
        if (!match) return res.status(404).json({ error: 'Channel not found in LND' });
      } else {
        const peerChannels = channels.filter((c) => c.remote_pubkey === remote_pubkey);
        if (peerChannels.length === 0) return res.status(404).json({ error: 'No channels with this peer' });
        if (peerChannels.length > 1) {
          return res.status(400).json({
            error: 'Multiple channels to this peer — specify channel_point',
            channel_points: peerChannels.map((c) => c.channel_point),
          });
        }
        match = peerChannels[0];
      }

      const result = await daemon.channelAssignments.assign(
        match.chan_id,
        match.channel_point,
        agent_id,
        { remote_pubkey: match.remote_pubkey, capacity: match.capacity },
        constraints || null,
      );
      return res.json({ status: 'assigned', assignment: result });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.delete('/api/v1/channels/assign/:chanId', async (req, res) => {
    const rejection = rejectUnauthorizedOperatorRoute(req, res);
    if (rejection) return rejection;
    const chanCheck = validateChannelIdOrPoint(req.params.chanId);
    if (!chanCheck.valid) return res.status(400).json({ error: chanCheck.reason });
    try {
      const revoked = await daemon.channelAssignments.revoke(req.params.chanId);
      return res.json({ status: 'revoked', revoked });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/api/operator/proof-ledger/liability-checkpoint', async (req, res) => {
    const rejection = rejectUnauthorizedOperatorRoute(req, res);
    if (rejection) return rejection;
    if (!daemon.proofLedger) return proofLedgerUnavailable(res);
    try {
      const proof = await daemon.proofLedger.createLiabilityCheckpoint({
        createdAtMs: optionalCreatedAtMs(req.body?.created_at_ms),
      });
      return res.json({
        ...proofResponse(daemon, proof),
        liability_totals: daemon.proofLedger.getLiabilityTotals(),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/operator/proof-ledger/reserve-snapshot', async (req, res) => {
    const rejection = rejectUnauthorizedOperatorRoute(req, res);
    if (rejection) return rejection;
    if (!daemon.proofLedger) return proofLedgerUnavailable(res);
    try {
      const reserveTotalsBySource = req.body?.reserve_totals_by_source ?? req.body?.reserveTotalsBySource;
      if (
        !reserveTotalsBySource
        || (Array.isArray(reserveTotalsBySource) && reserveTotalsBySource.length === 0)
        || (typeof reserveTotalsBySource === 'object' && !Array.isArray(reserveTotalsBySource) && Object.keys(reserveTotalsBySource).length === 0)
      ) {
        return res.status(400).json({
          error: 'reserve_totals_by_source required',
          message: 'Provide at least one reserve source with amount_sats.',
        });
      }
      const proof = await daemon.proofLedger.createReserveSnapshot({
        reserveTotalsBySource,
        reserveEvidenceRefs: req.body?.reserve_evidence_refs ?? req.body?.reserveEvidenceRefs ?? [],
        reserveSufficient: req.body?.reserve_sufficient ?? req.body?.reserveSufficient ?? null,
        createdAtMs: optionalCreatedAtMs(req.body?.created_at_ms),
      });
      return res.json(proofResponse(daemon, proof));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/operator/proof-ledger/reconciliation', async (req, res) => {
    const rejection = rejectUnauthorizedOperatorRoute(req, res);
    if (rejection) return rejection;
    if (!daemon.proofLedger) return proofLedgerUnavailable(res);
    try {
      const reconciliationStatus = req.body?.reconciliation_status ?? req.body?.reconciliationStatus;
      if (!reconciliationStatus || typeof reconciliationStatus !== 'string') {
        return res.status(400).json({
          error: 'reconciliation_status required',
          message: 'Provide a short public-safe reconciliation status string.',
        });
      }
      const proof = await daemon.proofLedger.createReconciliationProof({
        reconciliationStatus,
        reserveSufficient: req.body?.reserve_sufficient ?? req.body?.reserveSufficient ?? null,
        createdAtMs: optionalCreatedAtMs(req.body?.created_at_ms),
      });
      return res.json(proofResponse(daemon, proof));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  return router;
}
