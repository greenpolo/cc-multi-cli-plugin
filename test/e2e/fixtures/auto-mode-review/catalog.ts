// Loaded before the shared hermetic preload. Only supplement its fixed empty
// catalog at the loopback HTTP boundary; inference still uses UpstreamScript.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (
    process.env.MULTI_E2E_LIVE_CHILD !== '1' &&
    url.origin === process.env.MULTI_E2E_UPSTREAM &&
    url.pathname === '/openai/backend-api/codex/models'
  ) {
    return Promise.resolve(Response.json({ models: [{ slug: 'codex-auto-review' }] }));
  }
  return originalFetch(input, init);
};
