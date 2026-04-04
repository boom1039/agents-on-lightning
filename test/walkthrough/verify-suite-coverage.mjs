#!/usr/bin/env node

import { ALL_SUITES } from './suites/index.mjs';
import express from 'express';
import { extractRoutesFromApp } from '../../src/monitor/agent-surface-inventory.js';
import { agentGatewayRoutes } from '../../src/routes/agent-gateway.js';

function collectAgentFacingRoutes() {
  const app = express();
  const daemon = new Proxy({}, { get: () => () => {} });
  app.get('/', (_req, res) => res.end());
  app.get('/llms.txt', (_req, res) => res.end());
  app.use(agentGatewayRoutes(daemon));
  app.get('/health', (_req, res) => res.end());
  return extractRoutesFromApp(app);
}

export function collectCoveredRoutes() {
  const routeOwners = new Map();
  for (const suite of ALL_SUITES) {
    for (const phase of suite.phases) {
      for (const route of phase.covers) {
        if (!routeOwners.has(route)) routeOwners.set(route, []);
        routeOwners.get(route).push(`${suite.name}:${phase.name}`);
      }
    }
  }
  return routeOwners;
}

function resolvePhaseAgentExpectations(phase, options = {}) {
  if (!phase.agent_expectations) return {};
  if (typeof phase.agent_expectations === 'function') {
    return phase.agent_expectations(options) || {};
  }
  return phase.agent_expectations;
}

export function collectAgentExpectations(options = {}) {
  const expectationOwners = new Map();
  const extras = [];

  for (const suite of ALL_SUITES) {
    for (const phase of suite.phases) {
      const covers = new Set(phase.covers || []);
      const expectations = resolvePhaseAgentExpectations(phase, options);
      for (const route of Object.keys(expectations)) {
        if (!covers.has(route)) {
          extras.push({
            route,
            phase: `${suite.name}:${phase.name}`,
          });
        }
        if (!expectationOwners.has(route)) expectationOwners.set(route, []);
        expectationOwners.get(route).push(`${suite.name}:${phase.name}`);
      }
    }
  }

  return { expectationOwners, extras };
}

export function buildCoverageReport() {
  const expectedRoutes = collectAgentFacingRoutes();
  const owners = collectCoveredRoutes();
  const { expectationOwners, extras: expectationExtras } = collectAgentExpectations();
  const missing = expectedRoutes.filter(route => !owners.has(route));
  const missingExpectations = expectedRoutes.filter(route => !expectationOwners.has(route));
  const duplicates = [...owners.entries()]
    .filter(([, phases]) => phases.length > 1)
    .map(([route, phases]) => ({ route, phases }))
    .sort((a, b) => a.route.localeCompare(b.route));
  const duplicateExpectations = [...expectationOwners.entries()]
    .filter(([, phases]) => phases.length > 1)
    .map(([route, phases]) => ({ route, phases }))
    .sort((a, b) => a.route.localeCompare(b.route));
  return {
    expectedRoutes,
    owners,
    missing,
    duplicates,
    expectationOwners,
    missingExpectations,
    duplicateExpectations,
    expectationExtras,
  };
}

export function verifyCoverage() {
  const report = buildCoverageReport();
  if (report.missing.length > 0) {
    throw new Error(`Missing coverage for ${report.missing.length} routes:\n${report.missing.join('\n')}`);
  }
  if (report.missingExpectations.length > 0) {
    throw new Error(`Missing agent expectations for ${report.missingExpectations.length} routes:\n${report.missingExpectations.join('\n')}`);
  }
  if (report.expectationExtras.length > 0) {
    throw new Error(`Agent expectation entries without matching covers:\n${report.expectationExtras.map(item => `${item.route} (${item.phase})`).join('\n')}`);
  }
  return report;
}

async function main() {
  const report = buildCoverageReport();
  console.log(`Expected agent-facing routes: ${report.expectedRoutes.length}`);
  console.log(`Covered routes: ${report.owners.size}`);
  if (report.duplicates.length > 0) {
    console.log(`Duplicate claims: ${report.duplicates.length}`);
    for (const duplicate of report.duplicates) {
      console.log(`  ${duplicate.route}`);
      console.log(`    ${duplicate.phases.join(', ')}`);
    }
  } else {
    console.log('Duplicate claims: 0');
  }
  if (report.duplicateExpectations.length > 0) {
    console.log(`Duplicate agent expectations: ${report.duplicateExpectations.length}`);
    for (const duplicate of report.duplicateExpectations) {
      console.log(`  ${duplicate.route}`);
      console.log(`    ${duplicate.phases.join(', ')}`);
    }
  } else {
    console.log('Duplicate agent expectations: 0');
  }

  if (report.missing.length > 0) {
    console.log(`Missing routes: ${report.missing.length}`);
    for (const route of report.missing) {
      console.log(`  ${route}`);
    }
    process.exit(1);
  }
  if (report.missingExpectations.length > 0) {
    console.log(`Missing agent expectations: ${report.missingExpectations.length}`);
    for (const route of report.missingExpectations) {
      console.log(`  ${route}`);
    }
    process.exit(1);
  }
  if (report.expectationExtras.length > 0) {
    console.log(`Extra agent expectation entries: ${report.expectationExtras.length}`);
    for (const item of report.expectationExtras) {
      console.log(`  ${item.route} (${item.phase})`);
    }
    process.exit(1);
  }

  console.log('Coverage manifest is complete.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
