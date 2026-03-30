import test from 'node:test';
import assert from 'node:assert/strict';
import { doTerminalCommand, TERMINAL_TOOL } from './shared.mjs';

test('terminal tool executes a simple local command', async () => {
  const result = await doTerminalCommand({ command: 'printf hello', timeout_ms: 2000 });
  assert.equal(TERMINAL_TOOL.name, 'terminal_command');
  assert.equal(result.ok, true);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'hello');
});

test('terminal tool reports a timeout cleanly', async () => {
  const result = await doTerminalCommand({ command: 'sleep 2', timeout_ms: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.timed_out, true);
});

test('terminal tool allows node -e commands with semicolons inside quotes', async () => {
  const result = await doTerminalCommand({
    command: 'node --input-type=module -e \'console.log("one"); console.log("two")\'',
    timeout_ms: 2000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /one/);
  assert.match(result.stdout, /two/);
});
