import { suite as discovery } from './discovery.mjs';
import { suite as identity } from './identity.mjs';
import { suite as wallet } from './wallet.mjs';
import { suite as analysis } from './analysis.mjs';
import { suite as social } from './social.mjs';
import { suite as channels } from './channels.mjs';
import { suite as market } from './market.mjs';
import { suite as analytics } from './analytics.mjs';
import { suite as capital } from './capital.mjs';

export const ALL_SUITES = [
  discovery,
  identity,
  wallet,
  analysis,
  social,
  channels,
  market,
  analytics,
  capital,
];

export function getSuite(name) {
  return ALL_SUITES.find(suite => suite.name === name) || null;
}

export function resolveSuites(selected) {
  if (!selected || selected === 'all') return ALL_SUITES;
  const names = selected.split(',').map(value => value.trim()).filter(Boolean);
  const suites = names.map(name => {
    const suite = getSuite(name);
    if (!suite) {
      throw new Error(`Unknown coverage suite "${name}". Available: ${ALL_SUITES.map(item => item.name).join(', ')}`);
    }
    return suite;
  });
  return suites;
}
