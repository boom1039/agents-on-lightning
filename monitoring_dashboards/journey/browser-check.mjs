#!/usr/bin/env node
/**
 * Browser-check: launches Brave with GPU, loads the journey view,
 * captures console errors and WebGL errors from stderr, reports results.
 *
 * Zero dependencies — uses Brave's --enable-logging flag.
 *
 * Usage:  node monitoring_dashboards/journey/browser-check.mjs [url] [wait-ms]
 * Defaults: http://localhost:3308/journey/three, 5000ms
 *
 * Exit 0 = clean, exit 1 = errors found
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const url = process.argv[2] || 'http://localhost:3308/journey/three';
const wait = parseInt(process.argv[3] || '5000', 10);

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

const proc = spawn(BRAVE, [
  '--headless=new',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-brave-update',
  // GPU / WebGL
  '--use-gl=angle',
  '--use-angle=metal',
  '--enable-gpu-rasterization',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  // Logging: captures console messages, JS exceptions, WebGL errors
  '--enable-logging=stderr',
  '--v=0',
  // Window
  '--window-size=1280,720',
  url,
], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

await sleep(wait);

proc.kill('SIGTERM');
await new Promise((resolve) => proc.on('close', resolve));

// Parse Brave's stderr
const lines = stderr.split('\n');
const consoleErrors = [];
const glErrors = [];

for (const line of lines) {
  // Console messages: [pid:tid:date/time:LEVEL:CONSOLE:line] "message", source: url (line)
  const consoleMatch = line.match(/:CONSOLE:\d+\]\s*"(.+?)"/);
  if (consoleMatch) {
    const msg = consoleMatch[1];
    // Skip Brave internals and non-errors
    if (msg.includes('GL_INVALID') || msg.includes('glCopySubTexture')) {
      glErrors.push(msg);
    }
    // Any console.error from our code shows up here too
    // We check the source URL to filter app errors vs browser internals
    const srcMatch = line.match(/source:\s*(http:\/\/localhost:\d+\/.+?)\s*\(/);
    if (srcMatch && !msg.includes('GL_INVALID')) {
      consoleErrors.push(`${msg} (${srcMatch[1]})`);
    }
    continue;
  }

  // GPU process GL errors (not mirrored to console)
  if (line.includes('GL_INVALID') || line.includes('glCopySubTexture')) {
    const errMatch = line.match(/GL_INVALID\w+:\s*\w+:\s*.+/);
    if (errMatch && !glErrors.includes(errMatch[0])) {
      glErrors.push(errMatch[0]);
    }
    continue;
  }

  // JS exceptions
  if (line.includes('Uncaught') && line.includes('localhost')) {
    consoleErrors.push(line.trim());
  }
}

// Deduplicate GL errors (they repeat every frame)
const uniqueGL = [...new Set(glErrors)];

const allErrors = [...consoleErrors, ...uniqueGL];

if (allErrors.length === 0) {
  console.log(`OK  ${url} (${wait}ms, 0 errors)`);
  process.exit(0);
} else {
  console.error(`FAIL  ${url} — ${allErrors.length} error(s):\n`);
  for (const e of consoleErrors) console.error(`  [console] ${e}`);
  for (const e of uniqueGL)     console.error(`  [webgl]   ${e} (×${glErrors.filter(g => g === e).length})`);
  process.exit(1);
}
