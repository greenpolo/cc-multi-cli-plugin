import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { JsonObject } from '../../types.ts';

export interface Wire {
  url: string;
  headers: Record<string, string>;
  body: JsonObject;
}
export async function readWire(root: string): Promise<Wire> {
  return JSON.parse(await readFile(path.join(root, 'native-wire.json'), 'utf8')) as Wire;
}
export function deliver(wire: Wire, body: JsonObject = wire.body) {
  const headers: Record<string, string> = { ...wire.headers, 'x-e2e-probe': '1' };
  delete headers['content-length'];
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(wire.url, { method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Probe timed out')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
export function changedPrompt(wire: Wire, prompt: string): JsonObject {
  return { ...wire.body, stream: false, messages: [{ role: 'user', content: prompt }] };
}

export async function waitForCompletion(root: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await readFile(path.join(root, 'native-wire-complete.json'));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await setTimeout(10);
  }
  throw new Error('Native response did not complete');
}
