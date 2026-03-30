export const USABLE_NOW_BLOCKERS = {
  'POST /api/v1/channels/preview': 'needs a real assigned channel in the current harness',
  'POST /api/v1/channels/instruct': 'needs a real assigned channel in the current harness',
  'POST /api/v1/market/preview': 'needs real secp256k1 signing in the current harness',
  'POST /api/v1/market/open': 'needs real secp256k1 signing in the current harness',
  'POST /api/v1/market/close': 'needs real secp256k1 signing in the current harness',
  'POST /api/v1/market/rebalance': 'needs real secp256k1 signing in the current harness',
};

export const USABLE_NOW_EXCLUDED_ROUTES = new Set(Object.keys(USABLE_NOW_BLOCKERS));

function isPass(result) {
  return result?.category === 'pass_success' || result?.category === 'pass_boundary';
}

export function summarizeUsableNow(phaseEntries = []) {
  let total = 0;
  let passed = 0;
  const misses = [];

  for (const phase of phaseEntries) {
    for (const result of phase.route_results || []) {
      if (USABLE_NOW_EXCLUDED_ROUTES.has(result.cover)) continue;
      total += 1;
      if (isPass(result)) {
        passed += 1;
      } else {
        misses.push({
          suite: phase.suite,
          phase: phase.phase,
          cover: result.cover,
          category: result.category,
        });
      }
    }
  }

  return {
    passed,
    total,
    perfect: passed === total,
    excluded: [...USABLE_NOW_EXCLUDED_ROUTES].map((cover) => ({
      cover,
      reason: USABLE_NOW_BLOCKERS[cover],
    })),
    misses,
  };
}
