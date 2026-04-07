import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function escapeHtml(text) {
  return `${text ?? ''}`
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function padConsoleTable(rows) {
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => `${row[index] ?? ''}`.length)));
  return rows.map((row) => row.map((cell, index) => `${cell ?? ''}`.padEnd(widths[index])).join(' | ')).join('\n');
}

function renderSummary(summary) {
  return `
    <table>
      <thead>
        <tr>
          <th>Total Routes</th>
          <th>Pass Success</th>
          <th>Pass Guardrail</th>
          <th>Fail</th>
          <th>Run ID</th>
          <th>Started</th>
          <th>Finished</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${summary.total_routes}</td>
          <td>${summary.pass_success}</td>
          <td>${summary.pass_guardrail}</td>
          <td>${summary.fail}</td>
          <td>${escapeHtml(summary.run_id)}</td>
          <td>${escapeHtml(summary.started_at)}</td>
          <td>${escapeHtml(summary.finished_at)}</td>
        </tr>
      </tbody>
    </table>
  `;
}

function renderRows(rows) {
  return rows.map((row) => `
    <tr class="${escapeHtml(row.final)}">
      <td title="${escapeHtml(row.route)}">${escapeHtml(row.route)}</td>
      <td title="${escapeHtml(row.canonical_doc_path)}">${escapeHtml(row.canonical_doc_path)}</td>
      <td title="${escapeHtml(row.doc_step)}">${escapeHtml(row.doc_step)}</td>
      <td title="${escapeHtml(row.domain)}">${escapeHtml(row.domain)}</td>
      <td title="${escapeHtml(row.auth)}">${escapeHtml(row.auth)}</td>
      <td title="${escapeHtml(row.security)}">${escapeHtml(row.security)}</td>
      <td title="${escapeHtml(row.lane)}">${escapeHtml(row.lane)}</td>
      <td title="${escapeHtml(row.actor)}">${escapeHtml(row.actor)}</td>
      <td title="${escapeHtml(row.prereqs)}">${escapeHtml(row.prereqs)}</td>
      <td title="${escapeHtml(row.expected)}">${escapeHtml(row.expected)}</td>
      <td title="${escapeHtml(row.observed)}">${escapeHtml(row.observed)}</td>
      <td title="${escapeHtml(row.http)}">${escapeHtml(row.http)}</td>
      <td title="${escapeHtml(row.attempts)}">${escapeHtml(row.attempts)}</td>
      <td title="${escapeHtml(row.evidence)}">${escapeHtml(row.evidence)}</td>
      <td title="${escapeHtml(row.duration)}">${escapeHtml(row.duration)}</td>
      <td title="${escapeHtml(row.final)}">${escapeHtml(row.final)}</td>
      <td title="${escapeHtml(row.reason)}">${escapeHtml(row.reason)}</td>
    </tr>
  `).join('\n');
}

export async function writeHtmlReport({ outputDir, runId, baseUrl, summary, rows }) {
  const absoluteDir = resolve(process.cwd(), outputDir);
  await mkdir(absoluteDir, { recursive: true });

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Route Test Report ${escapeHtml(runId)}</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; background: #f6f7f9; color: #111; }
    h1, h2 { margin: 0 0 12px; }
    p { margin: 0 0 16px; }
    table { border-collapse: collapse; width: 100%; margin: 0 0 24px; background: white; }
    th, td { border: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top; font-size: 12px; }
    th { background: #f0f3f6; position: sticky; top: 0; }
    tr.pass_success { background: #eefaf0; }
    tr.pass_guardrail { background: #fff8e5; }
    tr.fail { background: #fff0f0; }
    .summary { margin-bottom: 24px; }
    .table-wrap { overflow: auto; width: 100%; }
    table.routes { table-layout: fixed; min-width: 2200px; }
    table.routes th, table.routes td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; max-width: 220px; }
    table.routes th:nth-child(1), table.routes td:nth-child(1) { max-width: 260px; }
    table.routes th:nth-child(2), table.routes td:nth-child(2) { max-width: 220px; }
    table.routes th:nth-child(10), table.routes td:nth-child(10),
    table.routes th:nth-child(11), table.routes td:nth-child(11),
    table.routes th:nth-child(14), table.routes td:nth-child(14) { max-width: 320px; }
    table.routes th:nth-child(4), table.routes td:nth-child(4) { background: #eef6ff; }
    table.routes th:nth-child(5), table.routes td:nth-child(5) { background: #f3f0ff; }
    table.routes th:nth-child(6), table.routes td:nth-child(6) { background: #fff6e8; }
    table.routes th:nth-child(7), table.routes td:nth-child(7) { background: #eefaf6; }
    table.routes th:nth-child(16), table.routes td:nth-child(16) { background: #f5f5f5; font-weight: 700; }
    table.routes th:nth-child(17), table.routes td:nth-child(17) { background: #fff7ed; }
    tr.pass_success td:nth-child(16) { background: #d9f3df; color: #0f5132; }
    tr.pass_guardrail td:nth-child(16) { background: #fff0bf; color: #7a5a00; }
    tr.fail td:nth-child(16) { background: #ffd9d9; color: #842029; }
  </style>
</head>
<body>
  <h1>Docs-Driven Route Report</h1>
  <p>Base URL: ${escapeHtml(baseUrl)}</p>
  <div class="summary">
    ${renderSummary(summary)}
  </div>
  <h2>Routes</h2>
  <div class="table-wrap">
    <table class="routes">
      <thead>
        <tr>
          <th>Route</th>
          <th>Canonical Doc Path</th>
          <th>Doc Step</th>
          <th>Domain</th>
          <th>Auth</th>
          <th>Security</th>
          <th>Lane</th>
          <th>Actor</th>
          <th>Prereqs</th>
          <th>Expected</th>
          <th>Observed</th>
          <th>HTTP</th>
          <th>Attempts</th>
          <th>Evidence</th>
          <th>Duration</th>
          <th>Final</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        ${renderRows(rows)}
      </tbody>
    </table>
  </div>
</body>
</html>`;

  const latestPath = resolve(absoluteDir, 'latest-routes-prod.html');
  const archivePath = resolve(absoluteDir, `${runId}.html`);
  await Promise.all([
    writeFile(latestPath, html, 'utf8'),
    writeFile(archivePath, html, 'utf8'),
  ]);

  return {
    latest_path: latestPath,
    archive_path: archivePath,
  };
}
