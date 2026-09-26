import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Instrument only the first fake native run, never the real launcher or Claude.
// The POSIX shim runs native-runner.mjs with the name first; the Windows npm-shaped
// shim runs <name>.mjs, which inserts the name only after this preload.
const marker = path.join(process.env.HOME ?? '', 'native-pids.json');
const script = path.basename(process.argv[1] ?? '');
const runner = script === 'native-runner.mjs';
const name = runner ? process.argv[2] : /^(agy|grok)\.mjs$/.exec(script)?.[1];
if (name && process.argv[runner ? 3 : 2] !== 'models' && !existsSync(marker)) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(marker, JSON.stringify({ parent: process.pid, child: child.pid }));
  if (name === 'grok') {
    process.stdout.write(`${JSON.stringify({ type: 'available_commands', tools: [] })}\n`);
  }
  if (name === 'agy') {
    process.stdout.write(
      `${JSON.stringify({ event: 'init', conversation_id: 'agy-cancelled', init: {} })}\n`,
    );
  }
}
