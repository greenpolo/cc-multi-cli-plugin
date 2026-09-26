import { execFile } from 'node:child_process';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

export interface TtyDriver {
  send(text: string): Promise<void>;
  key(key: 'Enter' | 'Escape' | 'C-c' | 'C-d' | 'Up' | 'Down'): Promise<void>;
  capture(): Promise<string>;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}
export interface TtyLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Existing isolated scenario root; the tmux socket never uses the user's server. */
  root: string;
}

/** POSIX backend. Windows needs a ConPTY adapter, so it skips instead of emulating a TTY. */
export async function startTty(t: TestContext, options: TtyLaunch): Promise<TtyDriver | undefined> {
  if (process.platform === 'win32') {
    t.skip('Interactive E2E requires a ConPTY backend on Windows; not implemented');
    return undefined;
  }
  const socket = path.join(options.root, 'tty.sock');
  if (Buffer.byteLength(socket) > 100) {
    t.skip('tmux socket path exceeds portable Unix socket limit; use a shorter E2E scratch root');
    return undefined;
  }
  const invoke = async (args: string[]) =>
    (
      await promisify(execFile)('tmux', ['-S', socket, ...args], {
        env: options.env,
        cwd: options.cwd,
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  try {
    await promisify(execFile)('tmux', ['-V'], { env: options.env, timeout: 5000 });
  } catch {
    t.skip('Interactive E2E requires tmux on POSIX');
    return undefined;
  }
  const close = async () => {
    await invoke(['kill-server']).catch(() => '');
  };
  t.after(close);
  await invoke([
    'new-session',
    '-d',
    '-s',
    'e2e',
    '-x',
    '120',
    '-y',
    '40',
    options.command,
    ...options.args,
  ]);
  const capture = () => invoke(['capture-pane', '-p', '-S', '-2000', '-t', 'e2e:0.0']);
  return {
    send: async (text) => {
      await invoke(['send-keys', '-t', 'e2e:0.0', '-l', '--', text]);
    },
    key: async (key) => {
      await invoke(['send-keys', '-t', 'e2e:0.0', key]);
    },
    capture,
    waitFor: async (pattern, timeoutMs = 10000) => {
      const deadline = performance.now() + timeoutMs;
      let screen = '';
      while (performance.now() < deadline) {
        screen = await capture();
        if (new RegExp(pattern.source, pattern.flags.replaceAll('g', '')).test(screen)) {
          return screen;
        }
        await setTimeout(50);
      }
      throw new Error(`TTY wait timed out for ${pattern}\n${screen}`);
    },
    close,
  };
}
