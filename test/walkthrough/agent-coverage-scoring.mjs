const SIGNED_CHECKS = [
  'pubkey_registered',
  'action_valid',
  'agent_id_matches',
  'timestamp_fresh',
  'not_duplicate',
  'signature_valid',
];

const MATCHER_CACHE = new Map();

function toArray(value) {
  if (Array.isArray(value)) return [...value];
  if (value == null) return [];
  return [value];
}

function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function normalizeRequestSpec(spec = {}) {
  return {
    auth: spec.auth || 'optional',
    bodyKeys: toArray(spec.bodyKeys),
    bodyAnyKeys: toArray(spec.bodyAnyKeys),
    queryKeys: toArray(spec.queryKeys),
  };
}

function normalizeResponseSpec(spec = {}) {
  return {
    kind: spec.kind || 'status',
    outcome: spec.outcome || 'success',
    statuses: toArray(spec.statuses),
    requiredFields: toArray(spec.requiredFields),
    requiredOneOf: Array.isArray(spec.requiredOneOf)
      ? spec.requiredOneOf.map(group => toArray(group))
      : [],
    requiredChecks: toArray(spec.requiredChecks),
    fieldEquals: cloneObject(spec.fieldEquals),
  };
}

function buildExpectation(request = {}, response = {}) {
  return {
    request: normalizeRequestSpec(request),
    response: normalizeResponseSpec(response),
  };
}

export function reqPublic(overrides = {}) {
  return normalizeRequestSpec({ auth: 'forbidden', ...overrides });
}

export function reqAuth(overrides = {}) {
  return normalizeRequestSpec({ auth: 'required', ...overrides });
}

export function reqOptional(overrides = {}) {
  return normalizeRequestSpec({ auth: 'optional', ...overrides });
}

export function expectStatus(statuses, request = {}, response = {}) {
  return buildExpectation(request, {
    kind: 'status',
    outcome: 'success',
    statuses: toArray(statuses),
    ...response,
  });
}

export function expectHelpful(statuses, request = {}, extraFields = [], response = {}) {
  return buildExpectation(request, {
    kind: 'helpful',
    outcome: 'boundary',
    statuses: toArray(statuses),
    requiredFields: ['error', 'hint', ...toArray(extraFields)],
    ...response,
  });
}

export function expectSafe(request = {}, response = {}) {
  return buildExpectation(request, {
    kind: 'safe',
    outcome: 'success',
    ...response,
  });
}

export function expectSignedBoundary(request = {}, response = {}) {
  return buildExpectation(request, {
    kind: 'signed_boundary',
    outcome: 'boundary',
    requiredChecks: SIGNED_CHECKS,
    ...response,
  });
}

export function expectValidPreview(request = {}, response = {}) {
  return expectStatus(200, request, {
    fieldEquals: { valid: true },
    ...response,
  });
}

export function expectSuccessfulOpen(request = {}, response = {}) {
  return expectStatus(200, request, {
    fieldEquals: { success: true },
    ...response,
  });
}

export function normalizeRoutePath(url, baseUrl = '') {
  try {
    const parsed = new URL(url, baseUrl || 'http://localhost');
    return `${parsed.pathname}${parsed.search || ''}`;
  } catch {
    return String(url || '').replace(baseUrl || '', '');
  }
}

function normalizeEndpointPath(url, baseUrl = '') {
  return normalizeRoutePath(url, baseUrl).split('?')[0];
}

export function getCoverMatcher(cover) {
  let cached = MATCHER_CACHE.get(cover);
  if (cached) return cached;

  const space = cover.indexOf(' ');
  const method = cover.slice(0, space).trim().toUpperCase();
  const rawPath = cover.slice(space + 1).trim().split('?')[0];
  const escaped = rawPath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[^/]+/g, '[^/?#]+');
  const staticPrefix = rawPath.includes(':')
    ? rawPath.slice(0, rawPath.indexOf(':'))
    : rawPath;

  cached = {
    method,
    rawPath,
    regex: new RegExp(`^${escaped}(?:\\?.*)?$`),
    staticPrefix,
  };
  MATCHER_CACHE.set(cover, cached);
  return cached;
}

function literalSiblingExclusions(covers, targetCover) {
  const target = getCoverMatcher(targetCover);
  if (!target.rawPath.includes(':')) return new Set();

  return new Set(
    covers
      .filter((cover) => cover !== targetCover)
      .map((cover) => getCoverMatcher(cover))
      .filter((matcher) => matcher.method === target.method && !matcher.rawPath.includes(':'))
      .filter((matcher) => target.regex.test(matcher.rawPath))
      .map((matcher) => matcher.rawPath),
  );
}

function parseBody(reqBody) {
  if (reqBody == null) return null;
  if (typeof reqBody === 'string') {
    try {
      return JSON.parse(reqBody);
    } catch {
      return null;
    }
  }
  if (typeof reqBody === 'object') return reqBody;
  return null;
}

function hasBearerAuth(headers) {
  if (!headers || typeof headers !== 'object') return false;
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== 'authorization') continue;
    return /^Bearer\s+/i.test(String(value || ''));
  }
  return false;
}

function valueDefined(objectValue) {
  return objectValue !== undefined && objectValue !== null;
}

function buildValidation(pass, reasons, passedChecks, totalChecks) {
  return {
    pass,
    reasons,
    passed_checks: passedChecks,
    total_checks: totalChecks,
  };
}

function validateRequest(call, requestSpec, baseUrl = '') {
  const reasons = [];
  let passedChecks = 0;
  let totalChecks = 0;

  if (requestSpec.auth !== 'optional') {
    totalChecks += 1;
    const hasAuth = hasBearerAuth(call.requestHeaders);
    if (requestSpec.auth === 'required') {
      if (hasAuth) passedChecks += 1;
      else reasons.push('missing bearer auth');
    } else if (requestSpec.auth === 'forbidden') {
      if (!hasAuth) passedChecks += 1;
      else reasons.push('unexpected bearer auth');
    }
  }

  const parsedUrl = new URL(call.url, baseUrl || 'http://localhost');
  for (const key of requestSpec.queryKeys) {
    totalChecks += 1;
    if (parsedUrl.searchParams.has(key)) passedChecks += 1;
    else reasons.push(`missing query key "${key}"`);
  }

  const body = parseBody(call.reqBody);
  for (const key of requestSpec.bodyKeys) {
    totalChecks += 1;
    if (body && typeof body === 'object' && valueDefined(body[key])) passedChecks += 1;
    else reasons.push(`missing body key "${key}"`);
  }

  if (requestSpec.bodyAnyKeys.length > 0) {
    totalChecks += 1;
    const hasAny = body && typeof body === 'object'
      && requestSpec.bodyAnyKeys.some(key => valueDefined(body[key]));
    if (hasAny) passedChecks += 1;
    else reasons.push(`missing any body key from [${requestSpec.bodyAnyKeys.join(', ')}]`);
  }

  return buildValidation(reasons.length === 0, reasons, passedChecks, totalChecks);
}

function validateResponse(call, responseSpec) {
  const reasons = [];
  let passedChecks = 0;
  let totalChecks = 0;
  const body = call.body && typeof call.body === 'object' ? call.body : null;
  const signedSuccess =
    responseSpec.kind === 'signed_boundary'
    && call.status === 200
    && body
    && (
      body.valid === true
      || body.status === 'executed'
      || body.success === true
    );

  if (responseSpec.kind === 'safe' || responseSpec.kind === 'signed_boundary') {
    totalChecks += 1;
    if (call.status > 0 && call.status < 500) passedChecks += 1;
    else reasons.push(`expected non-5xx status, got ${call.status}`);
  } else {
    totalChecks += 1;
    if (responseSpec.statuses.includes(call.status)) passedChecks += 1;
    else reasons.push(`expected status ${responseSpec.statuses.join('/')} got ${call.status}`);
  }

  const requiredFields = responseSpec.kind === 'helpful'
    ? ['error', 'hint', ...responseSpec.requiredFields.filter(field => !['error', 'hint'].includes(field))]
    : responseSpec.requiredFields;

  for (const field of requiredFields) {
    totalChecks += 1;
    if (body && valueDefined(body[field])) passedChecks += 1;
    else reasons.push(`missing response field "${field}"`);
  }

  for (const group of responseSpec.requiredOneOf) {
    totalChecks += 1;
    const hasAny = body && group.some(field => valueDefined(body[field]));
    if (hasAny) passedChecks += 1;
    else reasons.push(`missing any response field from [${group.join(', ')}]`);
  }

  for (const [field, expected] of Object.entries(responseSpec.fieldEquals)) {
    totalChecks += 1;
    if (body && Object.is(body[field], expected)) passedChecks += 1;
    else reasons.push(`expected response field "${field}" to equal ${JSON.stringify(expected)}`);
  }

  if (responseSpec.kind === 'signed_boundary' && !signedSuccess) {
    totalChecks += 1;
    const checks = body?.checks_passed;
    if (Array.isArray(checks)) passedChecks += 1;
    else reasons.push('missing checks_passed array');

    for (const check of responseSpec.requiredChecks) {
      totalChecks += 1;
      if (Array.isArray(checks) && checks.includes(check)) passedChecks += 1;
      else reasons.push(`missing checks_passed "${check}"`);
    }
  }

  return buildValidation(reasons.length === 0, reasons, passedChecks, totalChecks);
}

function isNearMiss(call, matcher, baseUrl = '') {
  const path = normalizeEndpointPath(call.url || '', baseUrl);
  const method = String(call.method || 'GET').toUpperCase();
  if (matcher.rawPath === '/') return path === '/' && method !== matcher.method;
  if (path === matcher.rawPath && method !== matcher.method) return true;
  const prefixWithoutTrailingSlash = matcher.staticPrefix.endsWith('/')
    ? matcher.staticPrefix.slice(0, -1)
    : matcher.staticPrefix;
  if (prefixWithoutTrailingSlash && path === prefixWithoutTrailingSlash) return true;
  if (!matcher.staticPrefix) return false;
  return path.startsWith(matcher.staticPrefix) && !(method === matcher.method && matcher.regex.test(normalizeRoutePath(call.url || '', baseUrl)));
}

function validationRank(validation) {
  if (!validation) return -1;
  return validation.pass ? Number.MAX_SAFE_INTEGER : validation.passed_checks;
}

export function evaluateRouteAttempts(httpLog, cover, expectation, { baseUrl = '', excludedExactPaths = new Set() } = {}) {
  const matcher = getCoverMatcher(cover);
  const exactAttempts = [];
  let nearMissCount = 0;

  for (const call of httpLog) {
    const normalized = normalizeRoutePath(call.url || '', baseUrl);
    const endpointPath = normalizeEndpointPath(call.url || '', baseUrl);
    const method = String(call.method || 'GET').toUpperCase();
    if (method === matcher.method && matcher.regex.test(normalized) && !excludedExactPaths.has(endpointPath)) {
      if (exactAttempts.length < 3) exactAttempts.push(call);
      continue;
    }
    if (isNearMiss(call, matcher, baseUrl)) nearMissCount += 1;
  }

  if (exactAttempts.length === 0) {
    return {
      cover,
      category: 'cannot_find_endpoint',
      exact_attempts_used: 0,
      near_miss_count: nearMissCount,
      best_status: null,
      best_request_validation: null,
      best_response_validation: null,
      failure_reason: `never made an exact ${cover} call`,
      reach: false,
    };
  }

  const attempts = exactAttempts.map((call, index) => {
    const requestValidation = validateRequest(call, expectation.request, baseUrl);
    const responseValidation = requestValidation.pass
      ? validateResponse(call, expectation.response)
      : null;
    return {
      index,
      call,
      requestValidation,
      responseValidation,
    };
  });

  const passedAttempt = attempts.find((attempt) => (
    attempt.requestValidation.pass && attempt.responseValidation?.pass
  ));
  if (passedAttempt) {
    const signedSuccess =
      expectation.response.kind === 'signed_boundary'
      && passedAttempt.call.status === 200
      && passedAttempt.call.body
      && (
        passedAttempt.call.body.valid === true
        || passedAttempt.call.body.status === 'executed'
        || passedAttempt.call.body.success === true
      );
    return {
      cover,
      category: expectation.response.outcome === 'boundary' && !signedSuccess ? 'pass_boundary' : 'pass_success',
      exact_attempts_used: attempts.length,
      near_miss_count: nearMissCount,
      best_status: passedAttempt.call.status,
      best_request_validation: passedAttempt.requestValidation,
      best_response_validation: passedAttempt.responseValidation,
      failure_reason: null,
      reach: true,
    };
  }

  const bestRequest = attempts.reduce((best, current) => (
    validationRank(current.requestValidation) > validationRank(best?.requestValidation)
      ? current
      : best
  ), null);
  const validRequestAttempts = attempts.filter((attempt) => attempt.requestValidation.pass);

  if (validRequestAttempts.length === 0) {
    return {
      cover,
      category: 'found_endpoint_wrong_request',
      exact_attempts_used: attempts.length,
      near_miss_count: nearMissCount,
      best_status: bestRequest?.call.status ?? attempts[attempts.length - 1].call.status,
      best_request_validation: bestRequest?.requestValidation ?? null,
      best_response_validation: null,
      failure_reason: bestRequest?.requestValidation?.reasons?.join('; ') || 'request never matched the documented contract',
      reach: true,
    };
  }

  const bestResponse = validRequestAttempts.reduce((best, current) => (
    validationRank(current.responseValidation) > validationRank(best?.responseValidation)
      ? current
      : best
  ), null);

  return {
    cover,
    category: 'found_endpoint_wrong_response',
    exact_attempts_used: attempts.length,
    near_miss_count: nearMissCount,
    best_status: bestResponse?.call.status ?? validRequestAttempts[validRequestAttempts.length - 1].call.status,
    best_request_validation: bestResponse?.requestValidation ?? null,
    best_response_validation: bestResponse?.responseValidation ?? null,
    failure_reason: bestResponse?.responseValidation?.reasons?.join('; ') || 'response never matched the documented contract',
    reach: true,
  };
}

export function evaluatePhaseCoverage(httpLog, covers, expectations, { baseUrl = '' } = {}) {
  const exclusionsByCover = new Map(covers.map((cover) => [cover, literalSiblingExclusions(covers, cover)]));
  const routeResults = covers.map((cover) => evaluateRouteAttempts(httpLog, cover, expectations[cover], {
    baseUrl,
    excludedExactPaths: exclusionsByCover.get(cover),
  }));
  const categoryCounts = {
    pass_success: 0,
    pass_boundary: 0,
    cannot_find_endpoint: 0,
    found_endpoint_wrong_request: 0,
    found_endpoint_wrong_response: 0,
  };

  for (const result of routeResults) {
    categoryCounts[result.category] += 1;
  }

  const successScore = categoryCounts.pass_success;
  const boundaryScore = categoryCounts.pass_boundary;
  const contractScore = successScore + boundaryScore;
  const reachScore = routeResults.filter(result => result.reach).length;

  return {
    routeResults,
    categoryCounts,
    successScore,
    boundaryScore,
    contractScore,
    reachScore,
    passed: contractScore === covers.length,
    failureGroups: {
      cannot_find_endpoint: routeResults.filter(result => result.category === 'cannot_find_endpoint').map(result => result.cover),
      found_endpoint_wrong_request: routeResults.filter(result => result.category === 'found_endpoint_wrong_request').map(result => result.cover),
      found_endpoint_wrong_response: routeResults.filter(result => result.category === 'found_endpoint_wrong_response').map(result => result.cover),
    },
    openRoutes: routeResults
      .filter(result => result.category !== 'pass_success' && result.category !== 'pass_boundary' && result.exact_attempts_used < 3)
      .map(result => result.cover),
  };
}
