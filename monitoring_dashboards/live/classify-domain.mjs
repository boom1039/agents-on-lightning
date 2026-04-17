/**
 * Classify an API path into its journey domain.
 * Single source of truth — imported by server.mjs, analytics-db.mjs, route-surface.mjs, etc.
 */
export function classifyDomain(p) {
  if (!p) return null;
  if (p === '/' || p === '/llms.txt' || p === '/health') return 'app-level';
  if (p === '/api/v1/' || p.startsWith('/api/v1/platform/') || p === '/api/v1/ethos' || p === '/api/v1/capabilities' || p.startsWith('/api/v1/strategies') || p.startsWith('/api/v1/knowledge/') || p.startsWith('/api/v1/skills')) return 'discovery';
  if (p.startsWith('/api/v1/agents/') || p.startsWith('/api/v1/node/')) return 'identity';
  if (p.startsWith('/api/v1/wallet/') || p === '/api/v1/ledger') return 'wallet';
  if (p.startsWith('/api/v1/analysis/')) return 'analysis';
  if (p.startsWith('/api/v1/messages') || p.startsWith('/api/v1/leaderboard') || p.startsWith('/api/v1/bounties')) return 'social';
  if (p.startsWith('/api/v1/channels/')) return 'channels';
  if (p.startsWith('/api/v1/market/')) return 'market';
  if (p.startsWith('/api/v1/analytics/')) return 'analytics';
  if (p.startsWith('/api/v1/capital/') || p === '/api/v1/help') return 'capital';
  return null;
}
