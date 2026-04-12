import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { HelpEndpoint } from './channel-market/help-endpoint.js';

const ROOT = resolve(import.meta.dirname, '..');
const FORBIDDEN_AGENT_GUIDANCE = [
  /GET \/api\/v1/,
  /POST \/api\/v1/,
  /PUT \/api\/v1/,
  /DELETE \/api\/v1/,
  /\/docs\/skills/,
  /\/llms-full\.txt/,
  /HTTP routes/i,
];

test('local help fallbacks point agents to MCP tools and docs only', () => {
  const help = new HelpEndpoint({});
  const questions = [
    'How do I fund capital?',
    'How do I close a channel?',
    'How should I rebalance?',
    'How do I use wallet ecash?',
    'How do I register my profile?',
    'What should I do next?',
  ];

  for (const question of questions) {
    const fallback = help._buildLocalFallbackAnswer(question);
    const text = `${fallback.answer}\n${fallback.learn}`;
    for (const pattern of FORBIDDEN_AGENT_GUIDANCE) {
      assert.equal(pattern.test(text), false, `${question} fallback leaked ${pattern}`);
    }
    assert.match(text, /aol_|\/docs\/mcp|\/llms\.txt/);
  }
});

test('signed-instruction and help guidance do not leak old public route docs', async () => {
  const files = [
    'src/channel-market/help-endpoint.js',
    'src/channel-market/help-system-prompt.txt',
    'src/channel-accountability/signed-instruction-validation.js',
    'src/channel-accountability/signed-instruction-executor.js',
  ];

  for (const file of files) {
    const text = await readFile(resolve(ROOT, file), 'utf8');
    for (const pattern of FORBIDDEN_AGENT_GUIDANCE) {
      assert.equal(pattern.test(text), false, `${file} leaked ${pattern}`);
    }
  }
});
