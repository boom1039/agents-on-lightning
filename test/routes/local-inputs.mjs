import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_FILE = resolve(process.cwd(), '.local', 'test-routes.json');

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trim(value) {
  return `${value || ''}`.trim();
}

function parsePeerTargets(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => normalizePeerTarget(item)).filter(Boolean);
  }
  return `${value}`
    .split(',')
    .map((item) => normalizePeerTarget(item))
    .filter(Boolean);
}

function normalizePeerTarget(value) {
  const text = trim(value);
  if (!text) return null;
  const [pubkey, host = ''] = text.split('@');
  if (!pubkey) return null;
  return {
    pubkey: trim(pubkey),
    host: trim(host),
    raw: text,
  };
}

export function loadLocalInputs() {
  const filePath = resolve(process.cwd(), trim(process.env.AOL_ROUTE_INPUTS_FILE) || DEFAULT_FILE);
  const fileInputs = readJson(filePath);

  const envPeerTargets = parsePeerTargets(trim(process.env.AOL_ROUTE_PEER_TARGETS));
  const filePeerTargets = parsePeerTargets(fileInputs.peer_targets);

  return {
    file_path: filePath,
    base_url: trim(process.env.AOL_ROUTE_BASE_URL) || trim(fileInputs.base_url) || 'https://agentsonlightning.com',
    mode: trim(process.env.AOL_ROUTE_MODE) || trim(fileInputs.mode) || 'full_audit',
    report_dir: trim(process.env.AOL_ROUTE_REPORT_DIR) || trim(fileInputs.report_dir) || 'test/routes/reports',
    external_invoice: trim(process.env.AOL_ROUTE_EXTERNAL_INVOICE) || trim(fileInputs.external_invoice),
    onchain_address: trim(process.env.AOL_ROUTE_ONCHAIN_ADDRESS) || trim(fileInputs.onchain_address),
    peer_targets: envPeerTargets.length > 0 ? envPeerTargets : filePeerTargets,
    node: {
      host: trim(process.env.AOL_ROUTE_NODE_HOST) || trim(fileInputs.node?.host),
      macaroon: trim(process.env.AOL_ROUTE_NODE_MACAROON) || trim(fileInputs.node?.macaroon),
      tls_cert: trim(process.env.AOL_ROUTE_NODE_TLS_CERT) || trim(fileInputs.node?.tls_cert),
    },
    timeouts: {
      fetch_ms: Number.parseInt(process.env.AOL_ROUTE_TIMEOUT_MS || fileInputs.timeouts?.fetch_ms || '20000', 10),
      long_poll_ms: Number.parseInt(process.env.AOL_ROUTE_LONG_TIMEOUT_MS || fileInputs.timeouts?.long_poll_ms || '120000', 10),
    },
  };
}
