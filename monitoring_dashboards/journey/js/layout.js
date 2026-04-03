import * as THREE from 'three';
import { RW, RD, RGAP, RMIN, SGP, SGG, SGH, SG_DEPTH, PHP, PHG, PHH, SG_COLS } from './constants.js';
import { MANIFEST } from './manifest.js';

// Saved route positions (from layout dump — D key)
const SAVED_POS = new Map([
  // Phase 1: Arrive
  ['GET /', { x: -10.7, z: -2.5 }],
  ['GET /llms.txt', { x: -9.1, z: -2.5 }],
  ['GET /health', { x: -7.5, z: -2.5 }],
  ['GET /api/v1/', { x: -5.9, z: -2.5 }],
  ['GET /api/v1/platform/status', { x: -1.6, z: -2.5 }],
  ['GET /api/v1/platform/decode-invoice', { x: 0, z: -2.5 }],
  ['GET /api/v1/ethos', { x: 1.6, z: -2.5 }],
  ['GET /api/v1/capabilities', { x: 3.2, z: -2.5 }],
  ['GET /api/v1/strategies', { x: 7.5, z: -2.5 }],
  ['GET /api/v1/strategies/:name', { x: 9.1, z: -2.5 }],
  ['GET /api/v1/knowledge/:topic', { x: 10.7, z: -2.5 }],
  ['GET /api/v1/skills', { x: -1.6, z: -6.6 }],
  ['GET /api/v1/skills/:name', { x: 0, z: -6.6 }],
  ['GET /api/v1/skills/:group/:name', { x: 1.6, z: -6.6 }],
  // Phase 2: Identity
  ['POST /api/v1/agents/register', { x: -9.29, z: -13.78 }],
  ['GET /api/v1/agents/me', { x: -7.69, z: -13.78 }],
  ['PUT /api/v1/agents/me', { x: -6.09, z: -13.78 }],
  ['GET /api/v1/agents/me/referral-code', { x: -4.49, z: -13.78 }],
  ['POST /api/v1/node/test-connection', { x: -0.19, z: -13.78 }],
  ['POST /api/v1/node/connect', { x: 1.41, z: -13.78 }],
  ['GET /api/v1/node/status', { x: 3.01, z: -13.78 }],
  ['POST /api/v1/actions/submit', { x: 7.31, z: -13.78 }],
  ['GET /api/v1/actions/history', { x: 8.91, z: -13.78 }],
  ['GET /api/v1/actions/:id', { x: 10.51, z: -13.78 }],
  // Phase 3: Wallet
  ['POST /api/v1/wallet/mint-quote', { x: -4.72, z: -20.36 }],
  ['POST /api/v1/wallet/check-mint-quote', { x: -3.12, z: -20.36 }],
  ['POST /api/v1/wallet/mint', { x: -1.52, z: -20.36 }],
  ['GET /api/v1/wallet/balance', { x: 2.78, z: -20.36 }],
  ['GET /api/v1/wallet/history', { x: 4.38, z: -20.36 }],
  ['POST /api/v1/wallet/restore', { x: 8.68, z: -20.36 }],
  ['POST /api/v1/wallet/reclaim-pending', { x: 10.28, z: -20.36 }],
  ['GET /api/v1/wallet/mint-quote', { x: 1.18, z: -24.46 }],
  ['POST /api/v1/wallet/deposit', { x: 2.78, z: -24.46 }],
  ['POST /api/v1/wallet/withdraw', { x: 4.38, z: -24.46 }],
  // Phase 4: Explore
  ['GET /api/v1/analysis/network-health', { x: -1.92, z: -30.86 }],
  ['GET /api/v1/analysis/node/:pubkey', { x: 2.38, z: -30.86 }],
  ['GET /api/v1/analysis/suggest-peers/:pubkey', { x: 6.68, z: -30.86 }],
  // Phase 5: Social
  ['GET /api/v1/leaderboard', { x: -8.43, z: -37.93 }],
  ['GET /api/v1/leaderboard/agent/:id', { x: -6.83, z: -37.93 }],
  ['GET /api/v1/leaderboard/challenges', { x: -5.23, z: -37.93 }],
  ['GET /api/v1/leaderboard/hall-of-fame', { x: -3.63, z: -37.93 }],
  ['GET /api/v1/leaderboard/evangelists', { x: -2.03, z: -37.93 }],
  ['GET /api/v1/tournaments', { x: -0.43, z: -37.93 }],
  ['GET /api/v1/tournaments/:id/bracket', { x: 1.17, z: -37.93 }],
  ['POST /api/v1/tournaments/:id/enter', { x: 2.77, z: -37.93 }],
  ['GET /api/v1/agents/:id', { x: 0.66, z: -42.39 }],
  ['GET /api/v1/agents/:id/lineage', { x: 2.26, z: -42.39 }],
  ['POST /api/v1/messages', { x: 5.99, z: -39.79 }],
  ['GET /api/v1/messages', { x: 7.59, z: -39.79 }],
  ['GET /api/v1/messages/inbox', { x: 9.19, z: -39.79 }],
  ['POST /api/v1/alliances', { x: -8.38, z: -42.56 }],
  ['GET /api/v1/alliances', { x: -6.78, z: -42.56 }],
  ['POST /api/v1/alliances/:id/accept', { x: -5.18, z: -42.56 }],
  ['POST /api/v1/alliances/:id/break', { x: -3.58, z: -42.56 }],
  // Phase 6: Intel
  ['GET /api/v1/analytics/catalog', { x: -27.48, z: -5.03 }],
  ['POST /api/v1/analytics/quote', { x: -25.88, z: -5.03 }],
  ['POST /api/v1/analytics/execute', { x: -24.28, z: -5.03 }],
  ['GET /api/v1/analytics/history', { x: -22.68, z: -5.03 }],
  ['POST /api/v1/help', { x: -18.38, z: -5.03 }],
  // Phase 7: Channels
  ['GET /api/v1/market/config', { x: -51.71, z: -13.71 }],
  ['GET /api/v1/market/overview', { x: -50.11, z: -13.71 }],
  ['GET /api/v1/market/channels', { x: -48.51, z: -13.71 }],
  ['GET /api/v1/market/agent/:agentId', { x: -46.91, z: -13.71 }],
  ['GET /api/v1/market/peer-safety/:pubkey', { x: -45.31, z: -13.71 }],
  ['GET /api/v1/market/fees/:peerPubkey', { x: -43.71, z: -13.71 }],
  ['GET /api/v1/market/rankings', { x: -42.11, z: -13.71 }],
  ['POST /api/v1/market/preview', { x: -37.81, z: -13.71 }],
  ['GET /api/v1/market/preview', { x: -36.21, z: -13.71 }],
  ['POST /api/v1/market/open', { x: -34.61, z: -13.71 }],
  ['GET /api/v1/market/open', { x: -33.01, z: -13.71 }],
  ['GET /api/v1/market/pending', { x: -31.41, z: -13.71 }],
  ['POST /api/v1/market/close', { x: -27.11, z: -13.71 }],
  ['GET /api/v1/market/close', { x: -25.51, z: -13.71 }],
  ['GET /api/v1/market/closes', { x: -23.91, z: -13.71 }],
  ['GET /api/v1/channels/mine', { x: -43.16, z: -17.81 }],
  ['POST /api/v1/channels/preview', { x: -41.56, z: -17.81 }],
  ['POST /api/v1/channels/instruct', { x: -39.96, z: -17.81 }],
  ['GET /api/v1/channels/instructions', { x: -38.36, z: -17.81 }],
  ['POST /api/v1/channels/assign', { x: -34.06, z: -17.81 }],
  ['DELETE /api/v1/channels/assign/:chanId', { x: -32.46, z: -17.81 }],
  // Phase 8: Revenue
  ['GET /api/v1/market/revenue', { x: -30.5, z: -25.27 }],
  ['GET /api/v1/market/revenue/:chanId', { x: -28.9, z: -25.27 }],
  ['PUT /api/v1/market/revenue-config', { x: -27.3, z: -25.27 }],
  ['GET /api/v1/market/performance', { x: -23, z: -25.27 }],
  ['GET /api/v1/market/performance/:chanId', { x: -21.4, z: -25.27 }],
  // Phase 9: Advanced
  ['POST /api/v1/market/fund-from-ecash', { x: -35.97, z: -34.29 }],
  ['GET /api/v1/market/fund-from-ecash/:flowId', { x: -34.37, z: -34.29 }],
  ['POST /api/v1/market/rebalance/estimate', { x: -30.07, z: -34.29 }],
  ['POST /api/v1/market/rebalance', { x: -28.47, z: -34.29 }],
  ['GET /api/v1/market/rebalances', { x: -26.87, z: -34.29 }],
  ['GET /api/v1/market/swap/quote', { x: -22.57, z: -34.29 }],
  ['POST /api/v1/market/swap/lightning-to-onchain', { x: -20.97, z: -34.29 }],
  ['GET /api/v1/market/swap/status/:swapId', { x: -19.37, z: -34.29 }],
  ['GET /api/v1/market/swap/history', { x: -17.77, z: -34.29 }],
  ['POST /api/v1/wallet/send', { x: -34.62, z: -38.39 }],
  ['POST /api/v1/wallet/receive', { x: -33.02, z: -38.39 }],
  ['POST /api/v1/wallet/melt-quote', { x: -31.42, z: -38.39 }],
  ['POST /api/v1/wallet/melt', { x: -29.82, z: -38.39 }],
  ['GET /api/v1/capital/balance', { x: -25.52, z: -38.39 }],
  ['GET /api/v1/capital/activity', { x: -23.92, z: -38.39 }],
  ['POST /api/v1/capital/deposit', { x: -22.32, z: -38.39 }],
  ['GET /api/v1/capital/deposits', { x: -20.72, z: -38.39 }],
  ['POST /api/v1/capital/withdraw', { x: -19.12, z: -38.39 }],
  // Phase 10: Audit
  ['GET /api/v1/channels/audit', { x: -32.85, z: -46.29 }],
  ['GET /api/v1/channels/audit/:chanId', { x: -31.25, z: -46.29 }],
  ['GET /api/v1/channels/verify', { x: -26.95, z: -46.29 }],
  ['GET /api/v1/channels/verify/:chanId', { x: -25.35, z: -46.29 }],
  ['GET /api/v1/channels/violations', { x: -21.05, z: -46.29 }],
  ['GET /api/v1/channels/status', { x: -19.45, z: -46.29 }],
  ['GET /api/v1/ledger', { x: -17.85, z: -46.29 }],
]);

export function computeLayout(posOverride) {
  const POS = posOverride || SAVED_POS;

  // Group routes by phase → subgroup from manifest
  const phases = new Map();
  for (const m of MANIFEST) {
    if (!phases.has(m.phase)) phases.set(m.phase, new Map());
    const sgs = phases.get(m.phase);
    if (!sgs.has(m.subgroup)) sgs.set(m.subgroup, []);
    sgs.get(m.subgroup).push(m);
  }

  const layout = new Map();

  // Fallback algorithmic cursor (for any routes not in POS)
  let zCursor = 0;

  for (let p = 1; p <= 10; p++) {
    const sgMap = phases.get(p);
    if (!sgMap) continue;

    const subgroups = new Map();

    // Track all route positions for phase bounding box
    const allRouteX = [];
    const allRouteZ = [];

    // Fallback: algorithmic layout for routes without saved positions
    const sgArr = [...sgMap.entries()].map(([name, routes]) => ({
      name, routes,
      w: routes.length * RW + Math.max(0, routes.length - 1) * RGAP + 2 * SGP,
    }));
    const rows = [];
    for (let i = 0; i < sgArr.length; i += SG_COLS) rows.push(sgArr.slice(i, i + SG_COLS));
    let phW = 0;
    for (const row of rows) {
      const rw = row.reduce((s, sg) => s + sg.w, 0) + Math.max(0, row.length - 1) * SGG;
      if (rw > phW) phW = rw;
    }
    phW += 2 * PHP;
    const phD = rows.length * SG_DEPTH + Math.max(0, rows.length - 1) * SGG + 2 * PHP;

    let innerZ = zCursor - PHP;
    let rowIdx = 0;

    for (const row of rows) {
      const rowW = row.reduce((s, sg) => s + sg.w, 0) + Math.max(0, row.length - 1) * SGG;
      let sgX = -rowW / 2;

      for (const sg of row) {
        const routes = [];
        const routeXs = [];
        const routeZs = [];

        // Check if all routes have saved positions
        const allSaved = sg.routes.every(m => POS.has(m.routeKey));

        if (allSaved) {
          for (const m of sg.routes) {
            const saved = POS.get(m.routeKey);
            const pos = new THREE.Vector3(saved.x, RMIN / 2, saved.z);
            routes.push({ entry: m, pos });
            routeXs.push(saved.x);
            routeZs.push(saved.z);
          }
        } else {
          // Algorithmic fallback
          const cx = sgX + sg.w / 2;
          const cz = innerZ - SG_DEPTH / 2;
          const totalRW = sg.routes.length * RW + Math.max(0, sg.routes.length - 1) * RGAP;
          let rx = cx - totalRW / 2 + RW / 2;
          for (const m of sg.routes) {
            const saved = POS.get(m.routeKey);
            const x = saved ? saved.x : rx;
            const z = saved ? saved.z : cz;
            const pos = new THREE.Vector3(x, RMIN / 2, z);
            routes.push({ entry: m, pos });
            routeXs.push(x);
            routeZs.push(z);
            rx += RW + RGAP;
          }
        }

        allRouteX.push(...routeXs);
        allRouteZ.push(...routeZs);

        // Compute subgroup bounding box from route positions
        const sgMinX = Math.min(...routeXs) - RW / 2 - SGP;
        const sgMaxX = Math.max(...routeXs) + RW / 2 + SGP;
        const sgMinZ = Math.min(...routeZs) - RD / 2 - SGP;
        const sgMaxZ = Math.max(...routeZs) + RD / 2 + SGP;
        const sgW = sgMaxX - sgMinX;
        const sgD = sgMaxZ - sgMinZ;
        const sgCX = (sgMinX + sgMaxX) / 2;
        const sgCZ = (sgMinZ + sgMaxZ) / 2;

        subgroups.set(sg.name, {
          pos: new THREE.Vector3(sgCX, SGH / 2, sgCZ),
          size: new THREE.Vector3(sgW, SGH, sgD),
          routes,
        });

        sgX += sg.w + SGG;
      }
      innerZ -= SG_DEPTH + SGG;
      rowIdx++;
    }

    // Compute phase bounding box from all routes
    if (allRouteX.length > 0) {
      const phMinX = Math.min(...allRouteX) - RW / 2 - SGP - PHP;
      const phMaxX = Math.max(...allRouteX) + RW / 2 + SGP + PHP;
      const phMinZ = Math.min(...allRouteZ) - RD / 2 - SGP - PHP;
      const phMaxZ = Math.max(...allRouteZ) + RD / 2 + SGP + PHP;
      const phCX = (phMinX + phMaxX) / 2;
      const phCZ = (phMinZ + phMaxZ) / 2;
      const phWCalc = phMaxX - phMinX;
      const phDCalc = phMaxZ - phMinZ;

      layout.set(p, {
        pos: new THREE.Vector3(phCX, PHH / 2, phCZ),
        size: new THREE.Vector3(phWCalc, PHH, phDCalc),
        subgroups,
      });
    }

    zCursor -= phD + PHG;
  }

  return layout;
}
