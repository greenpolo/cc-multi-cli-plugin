// Loaded only with the test harness's explicit `node --import`; never from production.
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const upstream = new URL(process.env.MULTI_E2E_UPSTREAM ?? '');
if (upstream.hostname !== '127.0.0.1' || upstream.protocol !== 'http:') {
  throw new Error('E2E upstream must be loopback HTTP');
}
const origins = new Map([
  ['https://api.anthropic.com', 'anthropic'],
  ['https://chatgpt.com', 'openai'],
  ['https://opencode.ai', 'zen'],
]);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const provider = origins.get(url.origin);
  if (!provider) {
    throw new Error(`Unscripted outbound fetch: ${url.origin}`);
  }
  return realFetch(new URL(`/${provider}${url.pathname}${url.search}`, upstream), init);
};
process.once('multi-mod-session-start', () => {
  process.stderr.write('E2E_MOD_SESSION_START_ACK\n');
});

const serverFile = fileURLToPath(
  new URL('../../plugins/multi-core/src/gateway/server.ts', import.meta.url),
);
const launcherFile = fileURLToPath(
  new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
);
function replaceOnce(source: string, target: string, replacement: string) {
  if (source.split(target).length !== 2) {
    throw new Error('E2E loader seam changed; update its exact match');
  }
  return source.replace(target, replacement);
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== '@cursor/sdk') {
      return next(specifier, context);
    }
    const fixture = process.env.MULTI_E2E_CURSOR_MODULE;
    if (!fixture) {
      const stub = `export const Cursor = { auth: { status: async () => ({ status: 'logged-out' }) } }; export function getDefaultSdkAuthPath() { throw new Error('Unscripted Cursor auth access'); }`;
      return next(`data:text/javascript,${encodeURIComponent(stub)}`, context);
    }
    return next(pathToFileURL(fixture).href, context);
  },
  load(url, context, next) {
    const result = next(url, context);
    if (!url.startsWith('file:')) {
      return result;
    }
    const filename = fileURLToPath(url);
    if (filename !== serverFile && filename !== launcherFile) {
      return result;
    }
    let source = String(result.source);
    if (filename === serverFile && process.env.MULTI_E2E_GATEWAY_TIMEOUT_MS) {
      source = replaceOnce(
        source,
        '  timeoutMs,',
        '  timeoutMs = Number(process.env.MULTI_E2E_GATEWAY_TIMEOUT_MS),',
      );
    }
    if (filename === launcherFile) {
      source = replaceOnce(
        source,
        '  const shutdown = async () => {',
        "  process.stderr.write('E2E_CHILD_PID=' + child.pid + '\\n');\n  const shutdown = async () => {",
      );
    }
    return { ...result, source };
  },
});
