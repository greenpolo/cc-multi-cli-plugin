import { writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const [sessionId, kind, countText = '1'] = process.argv.slice(2);
const base = process.env.MULTI_MOD_GATEWAY_URL;
const token = process.env.MULTI_GATEWAY_TOKEN;
async function request(route, body, agentId, allowError = false) {
  const response = await fetch(new URL(route, base), {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      'x-multi-gateway-token': token,
      'x-claude-code-session-id': sessionId,
      ...(agentId ? { 'x-claude-code-agent-id': agentId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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
} else {
  const mode = await request(`/multi/mod/mode${query}`);
  const provider = kind === 'cursor' ? 'cursor' : 'grok';
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
    if (kind === 'grok') {
      body.model += '[1m]';
      replies.push(await request('/v1/messages', body, agentId, true));
      replies.push(await request('/v1/messages', body, agentId, true));
      // The tag is context-window metadata, not a different native request.
      body.model = model;
    }
    replies.push(await request('/v1/messages', body, agentId));
  }
  const billed =
    kind === 'cursor' ? await request(`/multi/mod/usage${query}&billed=true`) : undefined;
  const usage = await request(`/multi/mod/usage${query}`);
  const receipts = await request(`/multi/mod/receipts${query}`);
  await writeFile('wire-output.json', JSON.stringify({ billed, usage, receipts, replies }));
}
console.log('Wire checks complete.');
