import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const [sessionId, kind, countText = '1'] = process.argv.slice(2);
const base = process.env.MULTI_MOD_GATEWAY_URL;
const token = process.env.MULTI_GATEWAY_TOKEN;
// The gateway issues a session's mod key on its first mod request; later changes present it.
const modKeys = new Map();
async function request(route, body, agentId, allowError = false, session = sessionId) {
  const response = await fetch(new URL(route, base), {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      'x-multi-gateway-token': token,
      'x-claude-code-session-id': session,
      ...(agentId ? { 'x-claude-code-agent-id': agentId } : {}),
      ...(modKeys.has(session) ? { 'x-multi-mod-key': modKeys.get(session) } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const issued = response.headers.get('x-multi-mod-key');
  if (issued) {
    modKeys.set(session, issued);
  }
  const text = await response.text();
  if (!response.ok && !allowError) {
    throw new Error(`${route}: ${response.status} ${text}`);
  }
  return allowError ? { status: response.status, body: JSON.parse(text) } : JSON.parse(text);
}
const query = `?sessionId=${encodeURIComponent(sessionId)}`;
if (kind === 'quota') {
  await writeFile(
    'wire-output.json',
    JSON.stringify(await request(`/multi/mod/usage${query}&view=providers`)),
  );
} else if (kind === 'grok') {
  // Admit settings without executing a setup worker, so model validation is the
  // refusal being exercised rather than missing native permission context. The mod
  // holds this Claude session's key, so the wire drives a session of its own.
  const session = randomUUID();
  const own = `?sessionId=${encodeURIComponent(session)}`;
  await request(
    '/multi/mod/session',
    { sessionId: session, cwd: process.cwd(), model: 'multi/grok/e2e[1m]', event: 'start' },
    undefined,
    false,
    session,
  );
  const mode = await request(`/multi/mod/mode${own}`, undefined, undefined, false, session);
  let policy = await request(
    '/multi/mod/policy',
    { sessionId: session, cwd: process.cwd(), sourceGeneration: mode.generation },
    undefined,
    false,
    session,
  );
  const deadline = Date.now() + 10000;
  while (policy.status === 'pending' && Date.now() < deadline) {
    await setTimeout(25);
    policy = await request(
      '/multi/mod/policy',
      { sessionId: session, generation: policy.generation },
      undefined,
      false,
      session,
    );
  }
  if (policy.status !== 'ready') {
    throw new Error('Native policy did not become ready');
  }
  await request(
    '/multi/mod/session',
    {
      sessionId: session,
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      model: 'multi/grok/e2e[1m]',
      generation: mode.generation,
      policyGeneration: policy.generation,
    },
    undefined,
    false,
    session,
  );
  const body = {
    model: 'multi/grok/e2e[1m]',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply ok, no tools.' }],
  };
  const replies = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await request('/v1/messages', body, undefined, true, session);
    replies.push(reply);
    console.log(JSON.stringify(reply));
  }
  await writeFile('wire-output.json', JSON.stringify({ replies }));
} else {
  const mode = await request(`/multi/mod/mode${query}`);
  const provider = 'cursor';
  const model = `multi/${provider}/e2e`;
  // Agent is asynchronous in recent Claude builds. Wait for its public receipt,
  // not a timer assumption, before querying billing or creating more scopes.
  const deadline = Date.now() + 10000;
  for (;;) {
    const { receipts } = await request(`/multi/mod/receipts${query}`);
    if (receipts.some((receipt) => receipt.entries.some((entry) => entry.provider === provider))) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Initial ${provider} worker never produced a receipt`);
    }
    await setTimeout(25);
  }
  const replies = [];
  for (let index = 1; index < Number(countText); index++) {
    const agentId = `wire-worker-${index}`;
    const worker = {
      sessionId,
      cwd: process.cwd(),
      subagentType: `${provider}-e2e`,
      permissionMode: 'bypassPermissions',
      parentModel: 'claude-sonnet-4-6',
      generation: mode.generation,
    };
    await request('/multi/mod/worker', worker);
    await request('/multi/mod/worker', { ...worker, agentId });
    const body = {
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply ok, no tools.' }],
    };
    replies.push(await request('/v1/messages', body, agentId));
  }
  const billed = await request(`/multi/mod/usage${query}&billed=true`);
  const usage = await request(`/multi/mod/usage${query}`);
  const receipts = await request(`/multi/mod/receipts${query}`);
  await writeFile('wire-output.json', JSON.stringify({ billed, usage, receipts, replies }));
}
console.log('Wire checks complete.');
