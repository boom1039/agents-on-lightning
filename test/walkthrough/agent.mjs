#!/usr/bin/env node
/**
 * Interactive Outside Agent — blank slate.
 *
 * You tell it what to do. It does it. You watch.
 * It knows nothing. No URLs. No context. No insider knowledge.
 *
 * Usage:
 *   node agent.mjs                                    # default: openai gpt-4.1-mini
 *   node agent.mjs --provider anthropic               # use haiku
 *   node agent.mjs --provider openai --model gpt-4o   # use gpt-4o
 */

import { createInterface } from 'node:readline';
import { opt, doHttp, createProvider } from './shared.mjs';

// ─── CLI args ───

const args = process.argv.slice(2);
const PROVIDER = opt('--provider', 'openai', args);
const MODEL = opt('--model', PROVIDER === 'openai' ? 'gpt-4.1-mini' : 'claude-haiku-4-5-20251001', args);

// ─── Main loop ───

async function main() {
  if (PROVIDER === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY');
    process.exit(1);
  }
  if (PROVIDER === 'openai' && !process.env.OPENAI_API_KEY) {
    console.error('Set OPENAI_API_KEY');
    process.exit(1);
  }

  const provider = await createProvider({ provider: PROVIDER, id: MODEL });

  console.log(`\n  Agent (${PROVIDER}/${MODEL})`);
  console.log(`  Knows nothing. You tell it what to do.\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise(resolve => rl.question('  you> ', resolve));
  const messages = [];

  while (true) {
    const input = await ask();
    if (!input.trim()) continue;

    messages.push({ role: 'user', content: input.trim() });

    for (let turn = 0; turn < 30; turn++) {
      let response;
      try {
        response = await provider.call(messages);
      } catch (err) {
        console.log(`  [error: ${err.message}]`);
        break;
      }

      if (response.text.trim()) {
        for (const line of response.text.trim().split('\n')) {
          console.log(`  agent> ${line}`);
        }
      }

      if (response.toolCalls.length === 0) break;

      const results = [];
      for (const tc of response.toolCalls) {
        process.stdout.write(`  [${tc.input.method} ${tc.input.url}] `);
        const httpResult = await doHttp(tc.input);
        console.log(`-> ${httpResult.status}${httpResult.errSnippet ? ' ' + httpResult.errSnippet : ''}`);
        results.push({ id: tc.id, content: httpResult.raw });
      }

      provider.push(messages, response.raw, results);
    }
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
