import { readFile, writeFile, rename, mkdir, readdir, stat, access } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getProjectRoot } from './config.js';

export class DataLayer {
  constructor(baseDir) {
    this._baseDir = baseDir || getProjectRoot();
  }

  _resolve(relPath) {
    const absPath = resolve(this._baseDir, relPath);
    // Path traversal guard: reject any path that escapes the base directory
    if (!absPath.startsWith(this._baseDir)) {
      throw new Error('Path traversal denied');
    }
    return absPath;
  }

  async exists(relPath) {
    try {
      await access(this._resolve(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async readJSON(relPath) {
    const absPath = this._resolve(relPath);
    const raw = await readFile(absPath, 'utf-8');
    return JSON.parse(raw);
  }

  _cloneDefaultJSON(defaultValue) {
    const resolved = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
    return structuredClone(resolved);
  }

  async readRuntimeStateJSON(relPath, { defaultValue = {} } = {}) {
    const absPath = this._resolve(relPath);
    let raw;
    try {
      raw = await readFile(absPath, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return this._cloneDefaultJSON(defaultValue);
      }
      throw err;
    }

    const trimmed = raw.trim();
    try {
      if (!trimmed) {
        throw new SyntaxError('Runtime state file is empty');
      }
      return JSON.parse(trimmed);
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        throw err;
      }

      const corruptSuffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
      const corruptPath = `${absPath}.corrupt-${corruptSuffix}`;
      const fallback = this._cloneDefaultJSON(defaultValue);

      try {
        await rename(absPath, corruptPath);
      } catch (renameErr) {
        if (renameErr.code !== 'ENOENT') {
          throw renameErr;
        }
      }

      await this.writeJSON(relPath, fallback);
      console.warn(
        `[DataLayer] Repaired corrupt runtime state at ${relPath}; ` +
        `moved original to ${corruptPath}`
      );
      return fallback;
    }
  }

  async writeJSON(relPath, data) {
    const absPath = this._resolve(relPath);
    const dir = dirname(absPath);
    await mkdir(dir, { recursive: true });
    const tmpSuffix = randomBytes(6).toString('hex');
    const tmpPath = `${absPath}.tmp.${tmpSuffix}`;
    const content = JSON.stringify(data, null, 2) + '\n';
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, absPath);
  }

  async appendLog(relPath, entry) {
    const absPath = this._resolve(relPath);
    const dir = dirname(absPath);
    await mkdir(dir, { recursive: true });
    const stamped = { ...entry, _ts: entry._ts || Date.now() };
    const line = JSON.stringify(stamped) + '\n';
    const fh = await open(absPath, 'a');
    try {
      await fh.write(line);
    } finally {
      await fh.close();
    }
  }

  async readLog(relPath, since) {
    const absPath = this._resolve(relPath);
    let raw;
    try {
      raw = await readFile(absPath, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    const entries = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (since !== undefined && since !== null) {
          const ts = parsed._ts || 0;
          if (ts < since) continue;
        }
        entries.push(parsed);
      } catch {
        continue;
      }
    }
    return entries;
  }

  async listDir(relPath) {
    const absPath = this._resolve(relPath);
    let entries;
    try {
      entries = await readdir(absPath);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const withStats = await Promise.all(
      entries
        .filter(name => !name.startsWith('.'))
        .map(async name => {
          const fullPath = resolve(absPath, name);
          const s = await stat(fullPath);
          return { name, path: fullPath, mtime: s.mtimeMs, size: s.size, isDir: s.isDirectory() };
        }),
    );
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats;
  }
}
