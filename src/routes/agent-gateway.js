/**
 * Agent API Gateway — /api/v1/
 *
 * Barrel file that mounts all domain-specific sub-routers.
 * Each sub-router owns its routes, constants, and helpers.
 */

import { Router } from 'express';
import { agentDiscoveryRoutes } from './agent-discovery-routes.js';
import { agentIdentityRoutes } from './agent-identity-routes.js';
import { agentWalletRoutes } from './agent-wallet-routes.js';
import { agentAnalysisRoutes } from './agent-analysis-routes.js';
import { agentAdvisoryRoutes } from './agent-advisory-routes.js';
import { agentSocialRoutes } from './agent-social-routes.js';
import { channelAccountabilityRoutes } from './channel-accountability-routes.js';
import { agentPaidServicesRoutes } from './agent-paid-services-routes.js';
import { channelMarketRoutes } from './channel-market-routes.js';

export function agentGatewayRoutes(daemon) {
  const router = Router();

  // Global ?lean=true middleware: strip `learn` fields to save agent tokens
  router.use((req, res, next) => {
    if (req.query.lean === 'true') {
      const origJson = res.json.bind(res);
      res.json = (data) => {
        if (data && typeof data === 'object') delete data.learn;
        return origJson(data);
      };
    }
    next();
  });

  router.use(agentDiscoveryRoutes(daemon));
  router.use(agentIdentityRoutes(daemon));
  router.use(agentWalletRoutes(daemon));
  router.use(agentAnalysisRoutes(daemon));
  router.use(agentAdvisoryRoutes(daemon));
  router.use(agentSocialRoutes(daemon));
  router.use(channelAccountabilityRoutes(daemon));
  router.use(agentPaidServicesRoutes(daemon));
  router.use(channelMarketRoutes(daemon));

  return router;
}
