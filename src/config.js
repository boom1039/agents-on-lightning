import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function expandHome(p) {
  if (typeof p === 'string' && p.startsWith('~/')) {
    return resolve(process.env.HOME || '/root', p.slice(2));
  }
  return p;
}

const DEFAULTS = {
  web: { port: 3302 },
  nodes: {},
  cashu: {
    port: 3338,
  },
};

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    const val = overrides[key];
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof defaults[key] === 'object' &&
      defaults[key] !== null &&
      !Array.isArray(defaults[key])
    ) {
      result[key] = deepMerge(defaults[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function expandPaths(config) {
  if (config.nodes) {
    for (const nodeName of Object.keys(config.nodes)) {
      const node = config.nodes[nodeName];
      if (node.lndDir) node.lndDir = expandHome(node.lndDir);
      if (node.macaroonPath) node.macaroonPath = expandHome(node.macaroonPath);
      if (node.tlsCertPath) node.tlsCertPath = expandHome(node.tlsCertPath);
    }
  }
  if (config.cashu) {
    if (config.cashu.dataDir) config.cashu.dataDir = expandHome(config.cashu.dataDir);
    if (config.cashu.seedPath) config.cashu.seedPath = expandHome(config.cashu.seedPath);
    if (config.cashu.tlsCertPath) config.cashu.tlsCertPath = expandHome(config.cashu.tlsCertPath);
    if (config.cashu.macaroonPath) config.cashu.macaroonPath = expandHome(config.cashu.macaroonPath);
  }
  if (config.help?.apiKeyFile) {
    config.help.apiKeyFile = expandHome(config.help.apiKeyFile);
  }
  return config;
}

let _config = null;

async function readYamlIfPresent(yamlPath) {
  try {
    const raw = await readFile(yamlPath, 'utf-8');
    return parseYaml(raw) || {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Failed to parse config at ${yamlPath}: ${err.message}`);
    }
    return {};
  }
}

export async function loadConfig(configPath) {
  const defaultPath = resolve(PROJECT_ROOT, 'config', 'default.yaml');
  const localPath = resolve(PROJECT_ROOT, 'config', 'local.yaml');
  const explicitPath = configPath || process.env.AOL_CONFIG_PATH || null;

  const defaultConfig = await readYamlIfPresent(defaultPath);
  const overrideConfig = explicitPath
    ? await readYamlIfPresent(explicitPath)
    : await readYamlIfPresent(localPath);

  _config = expandPaths(deepMerge(deepMerge(DEFAULTS, defaultConfig), overrideConfig));
  return _config;
}

export function getConfig() {
  if (!_config) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return _config;
}

export function getProjectRoot() {
  return PROJECT_ROOT;
}
