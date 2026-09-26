import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Instrument only the first fake native run, never the real launcher or Claude.
const marker = path.join(process.env.HOME ?? '', 'native-pids.json');
if (
  process.argv[1]?.endsWith('native-runner.mjs') &&
  process.argv[3] !== 'models' &&
  !existsSync(marker)
) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(marker, JSON.stringify({ parent: process.pid, child: child.pid }));
  if (process.argv[2] === 'grok') {
    process.stdout.write(`${JSON.stringify({ type: 'available_commands', tools: [] })}\n`);
  }
  if (process.argv[2] === 'agy') {
    process.stdout.write(
      `${JSON.stringify({ event: 'init', conversation_id: 'agy-cancelled', init: {} })}\n`,
    );
  }
}
