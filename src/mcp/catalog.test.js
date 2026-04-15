import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  MCP_AGENT_CARD_PREFERRED_TOOLS,
  MCP_DOCS,
  MCP_RECOMMENDED_TOOLS,
  MCP_TASK_PROMPTS,
  MCP_TOOL_GROUPS,
  MCP_TOOL_MONITORING_BY_NAME,
  MCP_TOOL_NAMES,
  MCP_TOOL_SPECS,
  MCP_WORKFLOW_SUMMARIES,
  SIMPLIFIED_MCP_DOC_NAMES,
} from './catalog.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MCP_TOOL_NAME_SET = new Set(MCP_TOOL_NAMES);

function extractMcpToolNames(text) {
  return [...text.matchAll(/\baol_[a-z0-9_]+\b/g)].map((match) => match[0]);
}

test('mcp tool catalog owns public tool metadata', () => {
  assert.equal(MCP_TOOL_NAMES.length, MCP_TOOL_SPECS.length);
  assert.equal(MCP_TOOL_NAME_SET.size, MCP_TOOL_NAMES.length);

  for (const tool of MCP_TOOL_SPECS) {
    assert.match(tool.name, /^aol_[a-z0-9_]+$/);
    assert.equal(typeof tool.description, 'string');
    assert(tool.description.length > 0);
  }

  for (const toolName of [
    ...MCP_RECOMMENDED_TOOLS,
    ...MCP_AGENT_CARD_PREFERRED_TOOLS,
    ...MCP_WORKFLOW_SUMMARIES.flatMap((workflow) => workflow.tools),
    ...MCP_TOOL_GROUPS.flatMap((group) => group.tools),
  ]) {
    assert(MCP_TOOL_NAME_SET.has(toolName), `catalog metadata references unknown MCP tool ${toolName}`);
  }

  const groupCounts = new Map();
  for (const group of MCP_TOOL_GROUPS) {
    assert.equal(typeof group.workflow_stage, 'string');
    assert(group.workflow_stage.length > 0);
    assert.equal(typeof group.risk_level, 'string');
    assert(group.risk_level.length > 0);
    assert.equal(typeof group.agent_lifecycle_stage, 'string');
    assert(group.agent_lifecycle_stage.length > 0);
    assert.equal(typeof group.intent_type, 'string');
    assert(group.intent_type.length > 0);
    assert.equal(typeof group.expected_outcome_type, 'string');
    assert(group.expected_outcome_type.length > 0);
    for (const toolName of group.tools) {
      groupCounts.set(toolName, (groupCounts.get(toolName) || 0) + 1);
    }
  }

  for (const toolName of MCP_TOOL_NAMES) {
    assert.equal(groupCounts.get(toolName), 1, `${toolName} must belong to exactly one MCP monitoring group`);
    const meta = MCP_TOOL_MONITORING_BY_NAME[toolName];
    assert(meta, `${toolName} is missing monitoring metadata`);
    assert.equal(typeof meta.tool_group, 'string');
    assert.equal(typeof meta.workflow_stage, 'string');
    assert.equal(typeof meta.risk_level, 'string');
    assert.equal(typeof meta.agent_lifecycle_stage, 'string');
    assert.equal(typeof meta.intent_type, 'string');
    assert.equal(typeof meta.outcome_type, 'string');
  }
});

test('mcp docs and prompts only advertise catalog tools', async () => {
  const files = [
    'docs/llms.txt',
    ...MCP_DOCS.map((doc) => `docs/mcp/${doc.file}`),
  ];

  for (const file of files) {
    const text = await readFile(resolve(ROOT, file), 'utf8');
    for (const toolName of extractMcpToolNames(text)) {
      assert(MCP_TOOL_NAME_SET.has(toolName), `${file} mentions uncataloged MCP tool ${toolName}`);
    }
  }

  for (const prompt of MCP_TASK_PROMPTS) {
    for (const toolName of extractMcpToolNames(prompt.text)) {
      assert(MCP_TOOL_NAME_SET.has(toolName), `${prompt.name} mentions uncataloged MCP tool ${toolName}`);
    }
  }
});

test('mcp docs do not expose internal api route maps', async () => {
  const files = [
    'docs/llms.txt',
    ...MCP_DOCS.map((doc) => `docs/mcp/${doc.file}`),
  ];

  for (const file of files) {
    const text = await readFile(resolve(ROOT, file), 'utf8');
    assert.equal(text.includes('/api/v1'), false, `${file} mentions /api/v1`);
    assert.equal(text.includes('/llms-full.txt'), false, `${file} mentions /llms-full.txt`);
    assert.equal(/route maps?/i.test(text), false, `${file} mentions route maps`);
  }
});

test('mcp docs carry agent autonomy and economics message', async () => {
  const llms = await readFile(resolve(ROOT, 'docs/llms.txt'), 'utf8');
  assert.match(llms, /# Agents on Lightning/);
  assert.match(llms, /MCP/);
  assert.match(llms, /no platform fees/);
  assert.match(llms, /no commissions/);
  assert.match(llms, /routing fees/);
  assert.match(llms, /liquidity/);
  assert.match(llms, /financial autonomy/);

  for (const heading of ['What You Can Do', 'Core Workflow', 'Money', 'Market And Channels', 'Social Coordination']) {
    assert.match(llms, new RegExp(heading), `llms is missing ${heading}`);
  }

  for (const tool of ['aol_get_capabilities', 'aol_get_strategy', 'aol_decode_invoice', 'aol_update_revenue_config', 'aol_get_market_agent']) {
    assert.match(llms, new RegExp(`\\b${tool}\\b`), `llms is missing ${tool}`);
  }

  const reference = await readFile(resolve(ROOT, 'docs/mcp/reference.txt'), 'utf8');
  for (const tool of ['aol_get_market_revenue_channel', 'aol_get_market_performance_channel', 'aol_get_channel_instructions', 'aol_get_market_open_help']) {
    assert.match(reference, new RegExp(`\\b${tool}\\b`), `reference doc is missing ${tool}`);
  }
});

test('mcp catalog exposes only simplified workflow docs', async () => {
  const actualNames = MCP_DOCS.map((doc) => doc.name);
  assert.deepEqual(actualNames, [...SIMPLIFIED_MCP_DOC_NAMES]);

  const actualFiles = MCP_DOCS.map((doc) => doc.file).sort();
  const diskFiles = (await readdir(resolve(ROOT, 'docs/mcp')))
    .filter((file) => file.endsWith('.txt'))
    .sort();
  assert.deepEqual(diskFiles, actualFiles);
});
