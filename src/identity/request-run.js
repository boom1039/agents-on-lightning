function sanitizeRunId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const collapsed = trimmed.replace(/\s+/g, '-');
  const safe = collapsed.replace(/[^A-Za-z0-9._:-]/g, '');
  if (!safe) return null;
  return safe.slice(0, 120);
}

export function getRequestRunId(req) {
  const headerCandidates = [
    req?.headers?.['x-aol-run-id'],
    req?.headers?.['x-run-id'],
    req?.headers?.['x-trace-group'],
  ];
  for (const candidate of headerCandidates) {
    const normalized = Array.isArray(candidate) ? candidate[0] : candidate;
    const runId = sanitizeRunId(normalized);
    if (runId) return runId;
  }

  const queryCandidates = [
    req?.query?.run_id,
    req?.query?.runId,
  ];
  for (const candidate of queryCandidates) {
    const normalized = Array.isArray(candidate) ? candidate[0] : candidate;
    const runId = sanitizeRunId(normalized);
    if (runId) return runId;
  }

  return null;
}

export { sanitizeRunId };
