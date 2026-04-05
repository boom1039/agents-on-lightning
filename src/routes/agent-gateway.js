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
import { agentSocialRoutes } from './agent-social-routes.js';
import { channelAccountabilityRoutes } from './channel-accountability-routes.js';
import { operatorControlRoutes } from './operator-control-routes.js';
import { agentPaidServicesRoutes } from './agent-paid-services-routes.js';
import { channelMarketRoutes } from './channel-market-routes.js';
import { agentEventsRoutes } from './agent-events-routes.js';
import { agentResponseGuidance } from '../identity/response-guidance.js';
import { areOperatorRoutesEnabled, areTestRoutesEnabled } from '../identity/request-security.js';

export function agentGatewayRoutes(daemon) {
  const router = Router();
  router.use(agentResponseGuidance);

  router.use(agentDiscoveryRoutes(daemon));
  router.use(agentIdentityRoutes(daemon));
  router.use(agentWalletRoutes(daemon));
  router.use(agentAnalysisRoutes(daemon));
  router.use(agentSocialRoutes(daemon));
  router.use(channelAccountabilityRoutes(daemon));
  if (areOperatorRoutesEnabled() || areTestRoutesEnabled()) {
    router.use(operatorControlRoutes(daemon));
  }
  router.use(agentPaidServicesRoutes(daemon));
  router.use(channelMarketRoutes(daemon));
  router.use(agentEventsRoutes(daemon));

  return router;
}
