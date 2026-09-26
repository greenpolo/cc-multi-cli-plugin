// Scenario-local extension of the harness's passive wire observer, not production code.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { deliver, type Wire } from './probe.ts';

const pending: Promise<unknown>[] = [];
export async function drainProbes() {
  await Promise.all(pending);
}

export function recordNativeWire(server: Server) {
  const previous =
    process.env.MULTI_E2E_DISK_REPLAY === '1'
      ? (JSON.parse(
          readFileSync(path.join(process.env.HOME ?? '', 'native-wire.json'), 'utf8'),
        ) as Wire)
      : undefined;
  server.on('request', (req, res) => {
    if (!req.url?.startsWith('/v1/messages?') || req.headers['x-e2e-probe']) {
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as { model?: string };
      if (!body.model?.match(/^multi\/(antigravity|grok|cursor)\//)) {
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('No gateway listener');
      }
      const wire = {
        url: `http://127.0.0.1:${address.port}${req.url}`,
        headers: req.headers as Record<string, string>,
        body,
      };
      writeFileSync(path.join(process.env.HOME ?? '', 'native-wire.json'), JSON.stringify(wire));
      res.once('finish', () => {
        writeFileSync(path.join(process.env.HOME ?? '', 'native-wire-complete.json'), '{}');
      });
      if (previous) {
        res.once('finish', () => {
          pending.push(
            deliver(wire, previous.body)
              .then((reply) => {
                writeFileSync(
                  path.join(process.env.HOME ?? '', 'disk-replay.json'),
                  JSON.stringify(reply),
                );
              })
              .catch((error: unknown) => {
                writeFileSync(
                  path.join(process.env.HOME ?? '', 'disk-replay.json'),
                  JSON.stringify({ error: String(error) }),
                );
              }),
          );
        });
      }
    });
  });
}

registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (url.endsWith('/plugins/multi-core/src/launcher.ts')) {
      return {
        ...result,
        source: String(result.source).replace(
          '    server.closeAllConnections();',
          `    await (await import(${JSON.stringify(import.meta.url)})).drainProbes();\n    server.closeAllConnections();`,
        ),
      };
    }
    if (!url.endsWith('/test/e2e/gateway-observer.ts')) {
      return result;
    }
    const source = String(result.source);
    if (!source.includes('let replayed = false;')) {
      throw new Error('Gateway observer seam changed');
    }
    return {
      ...result,
      source: `import { recordNativeWire } from ${JSON.stringify(import.meta.url)};\n${source.replace('let replayed = false;', 'recordNativeWire(server);\n  let replayed = false;')}`,
    };
  },
});
