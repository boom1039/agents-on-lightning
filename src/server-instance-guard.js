import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const SERVER_ROLE_CONFIG = {
  main: { port: 3302, local: true, description: 'local main server' },
  scratch: { port: 3306, local: true, description: 'local scratch server' },
  prod: { port: 3302, local: false, description: 'production server' },
};

function isKnownRole(role) {
  return Object.hasOwn(SERVER_ROLE_CONFIG, role);
}

export function getServerRole(env = process.env) {
  const explicitRole = typeof env.AOL_SERVER_ROLE === 'string' && env.AOL_SERVER_ROLE.trim()
    ? env.AOL_SERVER_ROLE.trim().toLowerCase()
    : '';
  const role = explicitRole || (env.NODE_ENV === 'production' ? 'prod' : 'main');
  if (!isKnownRole(role)) {
    throw new Error(
      `Unknown AOL_SERVER_ROLE "${role}". Use one of: ${Object.keys(SERVER_ROLE_CONFIG).join(', ')}.`,
    );
  }
  return role;
}

export function getDefaultPortForRole(role) {
  if (!isKnownRole(role)) {
    throw new Error(`Unknown server role "${role}".`);
  }
  return SERVER_ROLE_CONFIG[role].port;
}

export function getServerRegistryFile(env = process.env) {
  if (typeof env.AOL_SERVER_REGISTRY_FILE === 'string' && env.AOL_SERVER_REGISTRY_FILE.trim()) {
    return env.AOL_SERVER_REGISTRY_FILE.trim();
  }
  return join(tmpdir(), 'agents_on_lightning', 'server-registry.json');
}

function defaultIsPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readRegistry(registryFile) {
  if (!existsSync(registryFile)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(registryFile, 'utf8'));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return { entries };
  } catch {
    return { entries: [] };
  }
}

function writeRegistry(registryFile, entries) {
  mkdirSync(dirname(registryFile), { recursive: true });
  writeFileSync(
    registryFile,
    JSON.stringify({ updated_at: new Date().toISOString(), entries }, null, 2),
  );
}

function pruneEntries(entries, { isPidRunning }) {
  return entries.filter((entry) => {
    if (!entry || !isKnownRole(entry.role)) return false;
    return isPidRunning(entry.pid);
  });
}

export function validateServerPort(role, port, env = process.env) {
  const expectedPort = getDefaultPortForRole(role);
  const allowNonstandard = env.AOL_ALLOW_NONSTANDARD_PORT === '1';
  if (!allowNonstandard && port !== expectedPort) {
    throw new Error(
      `Role "${role}" must use port ${expectedPort}. `
      + `Use AOL_SERVER_ROLE=${role} on ${expectedPort}, or set AOL_ALLOW_NONSTANDARD_PORT=1 if you truly need an exception.`,
    );
  }
}

export function reserveServerSlot({
  role,
  port,
  host,
  env = process.env,
  registryFile = getServerRegistryFile(env),
  pid = process.pid,
  isPidRunning = defaultIsPidRunning,
} = {}) {
  if (env.NODE_ENV === 'test' && env.AOL_ENFORCE_SERVER_LIMITS !== '1') {
    return {
      registryFile,
      role,
      release() {},
    };
  }

  validateServerPort(role, port, env);

  const activeEntries = pruneEntries(readRegistry(registryFile).entries, { isPidRunning });

  if (role === 'prod') {
    const otherProd = activeEntries.find((entry) => entry.role === 'prod' && entry.pid !== pid);
    if (otherProd) {
      throw new Error(
        `A production server is already running on port ${otherProd.port}. `
        + 'Run only one production Agents on Lightning server.',
      );
    }
  } else {
    const localEntries = activeEntries.filter((entry) => SERVER_ROLE_CONFIG[entry.role].local);
    const duplicateRole = localEntries.find((entry) => entry.role === role && entry.pid !== pid);
    if (duplicateRole) {
      throw new Error(
        `A ${SERVER_ROLE_CONFIG[role].description} is already running on port ${duplicateRole.port}. `
        + `Reuse that ${role} server instead of starting another one.`,
      );
    }

    const distinctOtherLocalRoles = new Set(
      localEntries
        .filter((entry) => entry.pid !== pid)
        .map((entry) => entry.role),
    );
    if (!distinctOtherLocalRoles.has(role) && distinctOtherLocalRoles.size >= 2) {
      throw new Error(
        'Only two local Agents on Lightning servers are allowed: main on 3302 and scratch on 3306.',
      );
    }
  }

  const nextEntries = activeEntries
    .filter((entry) => !(entry.role === role && entry.pid === pid))
    .concat({
      role,
      pid,
      port,
      host,
      started_at: new Date().toISOString(),
    });
  writeRegistry(registryFile, nextEntries);

  let released = false;
  return {
    registryFile,
    role,
    release() {
      if (released) return;
      released = true;
      const currentEntries = pruneEntries(readRegistry(registryFile).entries, { isPidRunning });
      writeRegistry(
        registryFile,
        currentEntries.filter((entry) => !(entry.role === role && entry.pid === pid)),
      );
    },
  };
}
