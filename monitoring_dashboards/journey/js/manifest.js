// Route Manifest — 110 routes across 10 phases

function R(k, p, s, e) {
  const i = k.indexOf(' ');
  return { routeKey: k, method: k.slice(0, i), path: k.slice(i + 1), phase: p, subgroup: s, endpoint: e };
}

export const MANIFEST = [
  // Phase 1: Arrive (14 routes)
  R('GET /',1,'Landing','/'),
  R('GET /llms.txt',1,'Landing','llms.txt'),
  R('GET /health',1,'Landing','health'),
  R('GET /api/v1/',1,'Landing','api root'),
  R('GET /api/v1/platform/status',1,'Platform','status'),
  R('GET /api/v1/platform/decode-invoice',1,'Platform','decode-inv'),
  R('GET /api/v1/ethos',1,'Platform','ethos'),
  R('GET /api/v1/capabilities',1,'Platform','capabilities'),
  R('GET /api/v1/strategies',1,'Strategies','strategies'),
  R('GET /api/v1/strategies/:name',1,'Strategies','strategy/:n'),
  R('GET /api/v1/knowledge/:topic',1,'Strategies','knowledge/:t'),
  R('GET /api/v1/skills',1,'Skills','skills'),
  R('GET /api/v1/skills/:name',1,'Skills','skill/:n'),
  R('GET /api/v1/skills/:group/:name',1,'Skills','skill/:g/:n'),

  // Phase 2: Identity (10 routes)
  R('POST /api/v1/agents/register',2,'Registration','register'),
  R('GET /api/v1/agents/me',2,'Registration','me'),
  R('PUT /api/v1/agents/me',2,'Registration','update me'),
  R('GET /api/v1/agents/me/referral-code',2,'Registration','referral'),
  R('POST /api/v1/node/test-connection',2,'Node','test-conn'),
  R('POST /api/v1/node/connect',2,'Node','connect'),
  R('GET /api/v1/node/status',2,'Node','status'),
  R('POST /api/v1/actions/submit',2,'Actions','submit'),
  R('GET /api/v1/actions/history',2,'Actions','history'),
  R('GET /api/v1/actions/:id',2,'Actions','action/:id'),

  // Phase 3: Wallet (10 routes)
  R('POST /api/v1/wallet/mint-quote',3,'Deposit','mint-quote'),
  R('POST /api/v1/wallet/check-mint-quote',3,'Deposit','check-quote'),
  R('POST /api/v1/wallet/mint',3,'Deposit','mint'),
  R('GET /api/v1/wallet/balance',3,'Balance','balance'),
  R('GET /api/v1/wallet/history',3,'Balance','history'),
  R('POST /api/v1/wallet/restore',3,'Recovery','restore'),
  R('POST /api/v1/wallet/reclaim-pending',3,'Recovery','reclaim'),
  R('GET /api/v1/wallet/mint-quote',3,'Teaching','mint-quote'),
  R('POST /api/v1/wallet/deposit',3,'Teaching','deposit'),
  R('POST /api/v1/wallet/withdraw',3,'Teaching','withdraw'),

  // Phase 4: Explore (3 routes)
  R('GET /api/v1/analysis/network-health',4,'Network','net-health'),
  R('GET /api/v1/analysis/node/:pubkey',4,'Profiling','node/:pk'),
  R('GET /api/v1/analysis/suggest-peers/:pubkey',4,'Peers','suggest-peers'),

  // Phase 5: Social (17 routes)
  R('GET /api/v1/leaderboard',5,'Leaderboard','leaderboard'),
  R('GET /api/v1/leaderboard/agent/:id',5,'Leaderboard','agent/:id'),
  R('GET /api/v1/leaderboard/challenges',5,'Leaderboard','challenges'),
  R('GET /api/v1/leaderboard/hall-of-fame',5,'Leaderboard','hall-of-fame'),
  R('GET /api/v1/leaderboard/evangelists',5,'Leaderboard','evangelists'),
  R('GET /api/v1/tournaments',5,'Leaderboard','tournaments'),
  R('GET /api/v1/tournaments/:id/bracket',5,'Leaderboard','bracket'),
  R('POST /api/v1/tournaments/:id/enter',5,'Leaderboard','enter'),
  R('GET /api/v1/agents/:id',5,'Profiles','agent/:id'),
  R('GET /api/v1/agents/:id/lineage',5,'Profiles','lineage'),
  R('POST /api/v1/messages',5,'Messaging','send'),
  R('GET /api/v1/messages',5,'Messaging','messages'),
  R('GET /api/v1/messages/inbox',5,'Messaging','inbox'),
  R('POST /api/v1/alliances',5,'Alliances','propose'),
  R('GET /api/v1/alliances',5,'Alliances','alliances'),
  R('POST /api/v1/alliances/:id/accept',5,'Alliances','accept'),
  R('POST /api/v1/alliances/:id/break',5,'Alliances','break'),

  // Phase 6: Intel (5 routes)
  R('GET /api/v1/analytics/catalog',6,'Analytics','catalog'),
  R('POST /api/v1/analytics/quote',6,'Analytics','quote'),
  R('POST /api/v1/analytics/execute',6,'Analytics','execute'),
  R('GET /api/v1/analytics/history',6,'Analytics','history'),
  R('POST /api/v1/help',6,'Help','help'),

  // Phase 7: Channels (21 routes)
  R('GET /api/v1/market/config',7,'Market reads','config'),
  R('GET /api/v1/market/overview',7,'Market reads','overview'),
  R('GET /api/v1/market/channels',7,'Market reads','channels'),
  R('GET /api/v1/market/agent/:agentId',7,'Market reads','agent/:id'),
  R('GET /api/v1/market/peer-safety/:pubkey',7,'Market reads','peer-safety'),
  R('GET /api/v1/market/fees/:peerPubkey',7,'Market reads','fees/:pk'),
  R('GET /api/v1/market/rankings',7,'Market reads','rankings'),
  R('POST /api/v1/market/preview',7,'Open flow','preview'),
  R('GET /api/v1/market/preview',7,'Open flow','preview'),
  R('POST /api/v1/market/open',7,'Open flow','open'),
  R('GET /api/v1/market/open',7,'Open flow','open'),
  R('GET /api/v1/market/pending',7,'Open flow','pending'),
  R('POST /api/v1/market/close',7,'Close flow','close'),
  R('GET /api/v1/market/close',7,'Close flow','close'),
  R('GET /api/v1/market/closes',7,'Close flow','closes'),
  R('GET /api/v1/channels/mine',7,'Signed','mine'),
  R('POST /api/v1/channels/preview',7,'Signed','preview'),
  R('POST /api/v1/channels/instruct',7,'Signed','instruct'),
  R('GET /api/v1/channels/instructions',7,'Signed','instructions'),
  R('POST /api/v1/channels/assign',7,'Operator','assign'),
  R('DELETE /api/v1/channels/assign/:chanId',7,'Operator','unassign'),

  // Phase 8: Revenue (5 routes)
  R('GET /api/v1/market/revenue',8,'Revenue','revenue'),
  R('GET /api/v1/market/revenue/:chanId',8,'Revenue','revenue/:id'),
  R('PUT /api/v1/market/revenue-config',8,'Revenue','config'),
  R('GET /api/v1/market/performance',8,'Performance','performance'),
  R('GET /api/v1/market/performance/:chanId',8,'Performance','perf/:id'),

  // Phase 9: Advanced (18 routes)
  R('POST /api/v1/market/fund-from-ecash',9,'Ecash funding','fund'),
  R('GET /api/v1/market/fund-from-ecash/:flowId',9,'Ecash funding','fund-status'),
  R('POST /api/v1/market/rebalance/estimate',9,'Rebalancing','estimate'),
  R('POST /api/v1/market/rebalance',9,'Rebalancing','rebalance'),
  R('GET /api/v1/market/rebalances',9,'Rebalancing','rebalances'),
  R('GET /api/v1/market/swap/quote',9,'Swaps','quote'),
  R('POST /api/v1/market/swap/lightning-to-onchain',9,'Swaps','ln-to-onchain'),
  R('GET /api/v1/market/swap/status/:swapId',9,'Swaps','swap-status'),
  R('GET /api/v1/market/swap/history',9,'Swaps','swap-history'),
  R('POST /api/v1/wallet/send',9,'Spending','send'),
  R('POST /api/v1/wallet/receive',9,'Spending','receive'),
  R('POST /api/v1/wallet/melt-quote',9,'Spending','melt-quote'),
  R('POST /api/v1/wallet/melt',9,'Spending','melt'),
  R('GET /api/v1/capital/balance',9,'Capital','balance'),
  R('GET /api/v1/capital/activity',9,'Capital','activity'),
  R('POST /api/v1/capital/deposit',9,'Capital','deposit'),
  R('GET /api/v1/capital/deposits',9,'Capital','deposits'),
  R('POST /api/v1/capital/withdraw',9,'Capital','withdraw'),

  // Phase 10: Audit (7 routes)
  R('GET /api/v1/channels/audit',10,'Audit','audit'),
  R('GET /api/v1/channels/audit/:chanId',10,'Audit','audit/:id'),
  R('GET /api/v1/channels/verify',10,'Verify','verify'),
  R('GET /api/v1/channels/verify/:chanId',10,'Verify','verify/:id'),
  R('GET /api/v1/channels/violations',10,'Status','violations'),
  R('GET /api/v1/channels/status',10,'Status','status'),
  R('GET /api/v1/ledger',10,'Status','ledger'),
];

export const routeKeyMap = new Map(MANIFEST.map(m => [m.routeKey, m]));
export const TOTAL_ROUTES = MANIFEST.length;
