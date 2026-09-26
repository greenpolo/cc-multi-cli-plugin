// Explicit test-process-only interception; production endpoints remain unchanged.
const upstream = new URL(process.env.MULTI_E2E_UPSTREAM);
if (upstream.hostname !== '127.0.0.1' || upstream.protocol !== 'http:') {
  throw new Error('E2E upstream must be loopback HTTP');
}
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://api.anthropic.com') {
    throw new Error(`Unscripted outbound fetch: ${url.origin}`);
  }
  return realFetch(new URL(url.pathname + url.search, upstream), init);
};
process.once('multi-mod-session-start', () => {
  process.stderr.write('E2E_MOD_SESSION_START_ACK\n');
});
