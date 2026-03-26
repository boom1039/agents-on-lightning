/**
 * LND Configuration File (lnd.conf) — Parser and Writer
 *
 * Reads and writes the INI-style lnd.conf file used by LND.
 * The file has sections like [Application Options], [tor], [gossip], etc.
 * Settings can be active (key=value) or commented out (#key=value).
 *
 * This module is the only thing that touches lnd.conf on disk.
 * It creates timestamped backups before every write so changes
 * can always be rolled back.
 *
 * LND requires a restart for most config changes to take effect.
 * This module only handles the file — restart signaling is the
 * caller's responsibility.
 */

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// Sections that LND uses in lnd.conf. The default section (before any
// [section] header) is "Application Options" per LND convention.
const DEFAULT_SECTION = 'Application Options';

/**
 * Parse lnd.conf into structured entries.
 *
 * Returns an array of entries, each with:
 *   { section, key, value, active, lineNum, comment }
 *
 * "active" means the line is not commented out.
 * Comment-only lines and blank lines are preserved for faithful rewriting.
 *
 * @param {string} confPath - Absolute path to lnd.conf
 * @returns {Promise<{ entries: Object[], raw: string, sections: string[] }>}
 */
export async function parseLndConf(confPath) {
  const raw = await readFile(confPath, 'utf-8');
  const lines = raw.split('\n');
  const entries = [];
  const sections = new Set();
  let currentSection = DEFAULT_SECTION;
  sections.add(currentSection);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Section header: [section_name]
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      sections.add(currentSection);
      continue;
    }

    // Skip empty lines and pure comment lines (no key=value)
    if (!trimmed || (trimmed.startsWith('#') && !trimmed.includes('='))) {
      continue;
    }

    // Active setting: key=value
    const activeMatch = trimmed.match(/^([^#=][^=]*)=(.*)$/);
    if (activeMatch) {
      entries.push({
        section: currentSection,
        key: activeMatch[1].trim(),
        value: activeMatch[2].trim(),
        active: true,
        lineNum: i + 1,
        comment: null,
      });
      continue;
    }

    // Commented-out setting: #key=value
    // The key must look like a valid LND config key: alphanumeric, hyphens, dots,
    // underscores. This prevents matching prose comments that happen to contain '='
    // (e.g. "# debug would log every HTLC=GB/day")
    const commentedMatch = trimmed.match(/^#\s*([\w][\w.\-]*)\s*=\s*(.*)$/);
    if (commentedMatch) {
      entries.push({
        section: currentSection,
        key: commentedMatch[1].trim(),
        value: commentedMatch[2].trim(),
        active: false,
        lineNum: i + 1,
        comment: line, // Preserve exact comment formatting
      });
    }
  }

  return {
    entries,
    raw,
    sections: [...sections],
  };
}

/**
 * Build a lookup map from parsed entries: "section.key" -> entry
 * For default section, also index by just "key" for convenience.
 *
 * @param {Object[]} entries
 * @returns {Map<string, Object>}
 */
export function buildEntryMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    const fullKey = `${entry.section}.${entry.key}`;
    map.set(fullKey, entry);
    // Also index by bare key for Application Options (most common lookups)
    if (entry.section === DEFAULT_SECTION) {
      map.set(entry.key, entry);
    }
  }
  return map;
}

/**
 * Apply a set of changes to lnd.conf and write the result.
 *
 * Each change is: { key, value, section?, active? }
 *   - key: the config key (e.g. "trickledelay", "gossip.sub-batch-delay")
 *   - value: the new value (string)
 *   - section: optional section override (otherwise inferred from key or existing)
 *   - active: true to uncomment/enable, false to comment out
 *
 * Creates a timestamped backup before writing.
 *
 * @param {string} confPath - Absolute path to lnd.conf
 * @param {Object[]} changes - Array of changes to apply
 * @returns {Promise<{ backup: string, applied: number, skipped: string[] }>}
 */
export async function applyChanges(confPath, changes) {
  const raw = await readFile(confPath, 'utf-8');
  const lines = raw.split('\n');

  // Create backup before any modifications
  const backupDir = resolve(dirname(confPath), 'conf-backups');
  await mkdir(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(backupDir, `lnd.conf.${ts}`);
  await copyFile(confPath, backupPath);

  // Parse current state to find line positions
  let currentSection = DEFAULT_SECTION;
  const lineIndex = []; // Array of { section, lineNum, line }
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
    }
    lineIndex.push({ section: currentSection, lineNum: i, line: lines[i] });
  }

  const applied = [];
  const skipped = [];

  for (const change of changes) {
    if (!change.key) {
      skipped.push(`Missing key in change: ${JSON.stringify(change)}`);
      continue;
    }

    // Resolve section: explicit, or from dotted key, or Application Options
    let targetSection = change.section || DEFAULT_SECTION;
    let targetKey = change.key;

    // Handle dotted keys like "gossip.sub-batch-delay" -> section=gossip, key=sub-batch-delay
    // But also handle keys with dots that are in Application Options like "workers.sig"
    // LND convention: section headers in lnd.conf match the key prefix for nested sections
    // We check if there's an existing line with this key first
    const existingLine = findExistingLine(lineIndex, targetKey, targetSection);

    if (existingLine) {
      // Update existing line in place
      const newLine = change.active !== false
        ? `${existingLine.bareKey}=${change.value}`
        : `#${existingLine.bareKey}=${change.value}`;
      lines[existingLine.lineNum] = newLine;
      applied.push({ key: targetKey, value: change.value, action: 'updated' });
    } else {
      // Append to the appropriate section
      const sectionLineNum = findSectionEnd(lineIndex, targetSection);
      if (sectionLineNum !== -1) {
        const newLine = change.active !== false
          ? `${targetKey}=${change.value}`
          : `#${targetKey}=${change.value}`;
        lines.splice(sectionLineNum, 0, newLine);
        // Re-index after splice (shift all lineNums after insertion)
        for (const entry of lineIndex) {
          if (entry.lineNum >= sectionLineNum) entry.lineNum++;
        }
        applied.push({ key: targetKey, value: change.value, action: 'added' });
      } else {
        skipped.push(`Section not found for ${targetKey}`);
      }
    }
  }

  // Write the modified file
  await writeFile(confPath, lines.join('\n'), 'utf-8');

  return {
    backup: backupPath,
    applied: applied.length,
    changes: applied,
    skipped,
  };
}

/**
 * Find an existing line for a given key in the parsed line index.
 * Handles both active (key=value) and commented (#key=value) lines.
 */
function findExistingLine(lineIndex, key, section) {
  for (const entry of lineIndex) {
    const trimmed = entry.line.trim();

    // Try active match
    const activeMatch = trimmed.match(/^([^#=][^=]*)=(.*)$/);
    if (activeMatch && activeMatch[1].trim() === key) {
      return { lineNum: entry.lineNum, bareKey: activeMatch[1].trim(), section: entry.section };
    }

    // Try commented match
    const commentMatch = trimmed.match(/^#\s*([^=]+)=(.*)$/);
    if (commentMatch && commentMatch[1].trim() === key) {
      return { lineNum: entry.lineNum, bareKey: commentMatch[1].trim(), section: entry.section };
    }
  }
  return null;
}

/**
 * Find the last content line within a section (before the next section starts).
 * Returns the line number where a new entry should be inserted.
 */
function findSectionEnd(lineIndex, section) {
  let inSection = false;
  let lastContentLine = -1;

  for (const entry of lineIndex) {
    const trimmed = entry.line.trim();
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);

    if (sectionMatch) {
      if (inSection) return lastContentLine + 1;
      if (sectionMatch[1] === section) inSection = true;
      lastContentLine = entry.lineNum;
      continue;
    }

    // For Application Options (default section), we're "in section" from the start
    if (section === DEFAULT_SECTION && !inSection && !trimmed.startsWith('[')) {
      inSection = true;
    }

    if (inSection) {
      lastContentLine = entry.lineNum;
    }
  }

  // If we reached the end while still in the section
  if (inSection && lastContentLine !== -1) {
    return lastContentLine + 1;
  }

  return -1;
}

/**
 * List available backups for an lnd.conf file.
 * @param {string} confPath
 * @returns {Promise<string[]>} Sorted backup filenames (newest first)
 */
export async function listBackups(confPath) {
  const backupDir = resolve(dirname(confPath), 'conf-backups');
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(backupDir);
    return files
      .filter(f => f.startsWith('lnd.conf.'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Restore a specific backup.
 * @param {string} confPath
 * @param {string} backupName - Filename of the backup to restore
 */
export async function restoreBackup(confPath, backupName) {
  const backupDir = resolve(dirname(confPath), 'conf-backups');
  const backupPath = resolve(backupDir, backupName);

  // Validate the backup exists and is within the backup directory (path traversal guard)
  if (!backupPath.startsWith(backupDir)) {
    throw new Error('Invalid backup name');
  }

  // Create a backup of the current state before restoring
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const preRestorePath = resolve(backupDir, `lnd.conf.pre-restore-${ts}`);
  await copyFile(confPath, preRestorePath);

  // Restore
  await copyFile(backupPath, confPath);

  return { restored: backupName, preRestoreBackup: preRestorePath };
}
