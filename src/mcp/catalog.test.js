import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { MCP_DOCS, MCP_TASK_PROMPTS } from './catalog.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

test('mcp docs and prompts do not advertise removed generic request tool', async () => {
  const files = [
    'docs/llms.txt',
    'docs/llms-mcp.txt',
    ...MCP_DOCS.map((doc) => `docs/mcp/${doc.file}`),
  ];

  for (const file of files) {
    const text = await readFile(resolve(ROOT, file), 'utf8');
    assert.equal(/\baol_request\b/.test(text), false, `${file} mentions aol_request`);
  }

  for (const prompt of MCP_TASK_PROMPTS) {
    assert.equal(/\baol_request\b/.test(prompt.text), false, `${prompt.name} mentions aol_request`);
  }
});

test('mcp docs do not expose internal api route maps', async () => {
  const files = [
    'docs/llms.txt',
    'docs/llms-mcp.txt',
    ...MCP_DOCS.map((doc) => `docs/mcp/${doc.file}`),
  ];

  for (const file of files) {
    const text = await readFile(resolve(ROOT, file), 'utf8');
    assert.equal(text.includes('/api/v1'), false, `${file} mentions /api/v1`);
    assert.equal(text.includes('/docs/skills'), false, `${file} mentions /docs/skills`);
    assert.equal(/\baol_list_skills\b/.test(text), false, `${file} mentions deprecated aol_list_skills`);
  }
});
