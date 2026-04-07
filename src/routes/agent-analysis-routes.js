/**
 * Agent Analysis Routes — /api/v1/analysis/
 *
 * - network-health: LND-direct, no auth
 * - node/:pubkey: LND getNodeInfo, no auth
 * - suggest-peers/:pubkey: LND one-hop scan → Python scoring script
 */

import { Router } from 'express';
import { rateLimit } from '../identity/rate-limiter.js';
import { validatePubkey } from '../identity/validators.js';
import { err400Validation, err500Internal } from '../identity/agent-friendly-errors.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON3 = process.env.PYTHON3 || 'python3';
const SUGGEST_PEERS_SCRIPT = resolve(__dirname, '..', 'analysis', 'suggest-peers.py');

function buildGraphFallbackCandidates(graph = {}, excluded = new Set(), limit = 30) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  if (nodes.length === 0 || edges.length === 0) return [];

  const nodeMap = new Map(nodes.map((node) => [node.pub_key, node]));
  const stats = new Map();

  for (const edge of edges) {
    const node1 = edge.node1_pub;
    const node2 = edge.node2_pub;
    const capacity = Number.parseInt(edge.capacity || '0', 10) || 0;

    for (const pubkey of [node1, node2]) {
      if (!pubkey || excluded.has(pubkey)) continue;
      const current = stats.get(pubkey) || { num_channels: 0, total_capacity: 0 };
      current.num_channels += 1;
      current.total_capacity += capacity;
      stats.set(pubkey, current);
    }
  }

  return [...stats.entries()]
    .map(([pubkey, stat]) => ({
      pubkey,
      alias: nodeMap.get(pubkey)?.alias || '',
      num_channels: stat.num_channels,
      total_capacity: String(stat.total_capacity),
    }))
    .sort((a, b) => {
      const capDiff = (Number.parseInt(b.total_capacity || '0', 10) || 0)
        - (Number.parseInt(a.total_capacity || '0', 10) || 0);
      if (capDiff !== 0) return capDiff;
      return (b.num_channels || 0) - (a.num_channels || 0);
    })
    .slice(0, limit);
}

export function agentAnalysisRoutes(daemon) {
  const router = Router();
  const analysisRate = rateLimit('analysis');

  // --- Network health (LND-direct) ---

  // Read analysis network health.
  // @agent-route {"auth":"public","domain":"analysis","subgroup":"Network","label":"network-health","summary":"Read analysis network health.","order":100,"tags":["analysis","read","public"],"doc":["skills/analysis-network-health.txt","skills/analysis.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/analysis/network-health', analysisRate, async (_req, res) => {
    try {
      const client = daemon.nodeManager?.getScopedDefaultNode('read');
      if (!client) {
        return res.json({
          error: 'No LND node connected',
          hint: 'Detailed analysis is available through the paid analytics catalog at /api/v1/analytics/catalog',
        });
      }

      const [info, chanBalance, networkInfo] = await Promise.all([
        client.getInfo().catch(() => null),
        client.channelBalance().catch(() => null),
        client.getNetworkInfo().catch(() => null),
      ]);

      res.json({
        source: 'lnd',
        node: info ? {
          pubkey: info.identity_pubkey,
          alias: info.alias,
          num_active_channels: info.num_active_channels,
          num_inactive_channels: info.num_inactive_channels,
          num_pending_channels: info.num_pending_channels,
          num_peers: info.num_peers,
          synced_to_chain: info.synced_to_chain,
          synced_to_graph: info.synced_to_graph,
          block_height: info.block_height,
          version: info.version,
        } : null,
        channel_balance: chanBalance ? {
          local_balance_sat: chanBalance.local_balance?.sat || '0',
          remote_balance_sat: chanBalance.remote_balance?.sat || '0',
        } : null,
        network: networkInfo ? {
          num_nodes: networkInfo.num_nodes,
          num_channels: networkInfo.num_channels,
          total_network_capacity: networkInfo.total_network_capacity,
          avg_channel_size: networkInfo.avg_channel_size,
        } : null,
        hint: 'For deeper analysis, see /api/v1/analysis/node/:pubkey or /api/v1/analysis/suggest-peers/:pubkey',
      });
    } catch (err) {
      return err500Internal(res, 'reading network health');
    }
  });

  // --- Node profile (LND-direct) ---

  // Read analysis node by pubkey.
  // @agent-route {"auth":"public","domain":"analysis","subgroup":"Profiling","label":"node","summary":"Read analysis node by pubkey.","order":200,"tags":["analysis","read","dynamic","public"],"doc":["skills/analysis-node-profile.txt","skills/analysis.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/analysis/node/:pubkey', analysisRate, async (req, res) => {
    const check = validatePubkey(req.params.pubkey);
    if (!check.valid) return err400Validation(res, check.reason, { see: 'GET /api/v1/analysis/network-health' });

    try {
      const client = daemon.nodeManager?.getScopedDefaultNode('read');
      if (!client) return res.json({ error: 'No LND node connected' });

      const nodeInfo = await client.getNodeInfo(req.params.pubkey);
      const n = nodeInfo?.node || {};

      res.json({
        pubkey: n.pub_key,
        alias: n.alias || '',
        color: n.color || '',
        num_channels: nodeInfo.num_channels || 0,
        total_capacity: nodeInfo.total_capacity || '0',
        addresses: (n.addresses || []).map(a => a.addr),
        last_update: n.last_update,
      });
    } catch (err) {
      return err500Internal(res, 'reading node profile');
    }
  });

  // --- Suggest peers (LND one-hop scan → Python scoring) ---

  // Read analysis suggest peers by pubkey.
  // @agent-route {"auth":"public","domain":"analysis","subgroup":"Peers","label":"suggest-peers","summary":"Read analysis suggest peers by pubkey.","order":300,"tags":["analysis","read","dynamic","public"],"doc":["skills/analysis-suggest-peers.txt","skills/analysis.txt"],"security":{"moves_money":false,"requires_ownership":false,"requires_signature":false,"long_running":false}}
  router.get('/api/v1/analysis/suggest-peers/:pubkey', analysisRate, async (req, res) => {
    const check = validatePubkey(req.params.pubkey);
    if (!check.valid) return err400Validation(res, check.reason);

    try {
      const client = daemon.nodeManager?.getScopedDefaultNode('read');
      if (!client) return res.json({ error: 'No LND node connected' });

      // 1. Get our channels (who we already connect to)
      const myChannels = await client.listChannels();
      const myPeers = (myChannels.channels || []).map(c => c.remote_pubkey);

      // 2. Get target node's channels (their peers) — include_channels=true to get the channel list
      const targetInfo = await client._get(`/v1/graph/node/${req.params.pubkey}?include_channels=true`);
      const targetChannels = targetInfo.channels || [];
      const peerPubkeys = new Set();
      for (const ch of targetChannels) {
        if (ch.node1_pub !== req.params.pubkey) peerPubkeys.add(ch.node1_pub);
        if (ch.node2_pub !== req.params.pubkey) peerPubkeys.add(ch.node2_pub);
      }

      // 3. Fetch info on each peer (one-hop out), cap at 30 to limit LND calls
      const peerList = [...peerPubkeys].slice(0, 30);
      const oneHopCandidates = await Promise.all(
        peerList.map(async (pubkey) => {
          try {
            const info = await client.getNodeInfo(pubkey);
            return {
              pubkey,
              alias: info.node?.alias || '',
              num_channels: info.num_channels || 0,
              total_capacity: info.total_capacity || '0',
            };
          } catch {
            return null;
          }
        }),
      );
      const scoreCandidates = async (candidates) => {
        const input = JSON.stringify({
          target_pubkey: req.params.pubkey,
          my_peers: myPeers,
          candidates,
        });

        return new Promise((resolve, reject) => {
          const proc = spawn(PYTHON3, [SUGGEST_PEERS_SCRIPT], { timeout: 10_000 });
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', d => { stdout += d; });
          proc.stderr.on('data', d => { stderr += d; });
          proc.on('close', code => {
            if (code !== 0) return reject(new Error(stderr || `Python exit ${code}`));
            try { resolve(JSON.parse(stdout)); }
            catch { reject(new Error('Invalid JSON from Python')); }
          });
          proc.on('error', reject);
          proc.stdin.write(input);
          proc.stdin.end();
        });
      };

      let candidates = oneHopCandidates.filter(Boolean);
      let candidateSource = 'one_hop';
      let result = await scoreCandidates(candidates);

      if (result.total_candidates_considered === 0) {
        const graph = await client.describeGraph(false).catch(() => null);
        const excluded = new Set([...myPeers, req.params.pubkey]);
        const fallbackCandidates = buildGraphFallbackCandidates(graph, excluded, 30);
        if (fallbackCandidates.length > 0) {
          candidates = fallbackCandidates;
          candidateSource = 'network_graph_fallback';
          result = await scoreCandidates(candidates);
        }
      }

      // 4. Return scored suggestions
      res.json({
        target_pubkey: req.params.pubkey,
        ...result,
        candidate_source: candidateSource,
      });
    } catch (err) {
      return err500Internal(res, 'suggesting peers');
    }
  });

  return router;
}
