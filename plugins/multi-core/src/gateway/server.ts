import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CodexAuthError, codexRequest } from '../../../multi-openai/src/auth.ts';
import { openaiInstructions } from '../../../multi-openai/src/instructions.ts';
import { MODELS } from '../../../multi-openai/src/models.ts';
import type { ResponsesRequest } from '../../../multi-openai/src/responses.ts';
import { forAnthropic, fromResponses, toResponses } from '../../../multi-openai/src/responses.ts';
import { validateZenKey } from '../../../multi-zen/src/auth.ts';
import { fromChat } from '../../../multi-zen/src/chat.ts';
import { zenRequest } from '../../../multi-zen/src/request.ts';
import type { AgentCatalog } from './agent-catalog.ts';
import type { ApprovalContext, NativeApprovalBridge } from './approval.ts';
import { approvalCwdForComparison, isApprovalRequest, parseApprovalRequest } from './approval.ts';
import type { GatewayFetch } from './fetch.ts';
import type { Emit, MessagesRequest, MessagesResponse, StopReason } from './messages.ts';
import { ModBridge } from './mod-bridge.ts';
import { ModCompactions } from './mod-compaction.ts';
import { handleModRoute } from './mod-routes.ts';
import type { PermissionContext, PermissionModes } from './mode-hook.ts';
import { type NativeHarness, nativeHarnessErrorStatus } from './native-harness.ts';
import type { PendingApprovalTool } from './permission-hook.ts';
import { ProviderUsageDashboard, type ProviderUsageReader } from './provider-usage.ts';
import { ReceiptLedger } from './receipts.ts';
import { estimateInputTokens } from './tokens.ts';
import { forwardObservedTools, ToolObserver } from './tool-observer.ts';
import { originalToolNames } from './tools.ts';

const OPENAI_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ANTHROPIC_URL = 'https://api.anthropic.com';
const MAX_BODY = 8 * 1024 * 1024;
const STRIPPED_REQUEST_HEADERS = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'x-multi-gateway-token',
  'accept-encoding',
];
const STRIPPED_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
];

/** What the gateway reports to `onEvent`; routing only, never credentials or bodies. */
export interface GatewayEvent {
  route:
    | 'anthropic'
    | 'openai'
    | 'openai-request'
    | 'cursor'
    | 'antigravity'
    | 'grok'
    | 'approval'
    | 'zen'
    | 'zen-request';
  model?: string;
  agentId?: string | null;
  path?: string;
  effort?: string;
  status?: number;
  stopReason?: StopReason | null;
  tools?: string[];
  stage?: 1 | 2;
  outcome?: 'allow' | 'deny';
  cached?: boolean;
  permissionContext?: PermissionContext;
  usage?: MessagesResponse['usage'];
  usageMetadata?: MessagesResponse['multi_usage'];
  requestId?: string;
  /** Upstream API the request was billed through, present on completion events. */
  endpoint?: string;
  /** Claude session that owns the request, when the client identified one. */
  session?: string;
}

export interface GatewayOptions {
  receipts?: ReceiptLedger;
  usageDashboard?: ProviderUsageDashboard;
  billedUsage?: (session: string) => Promise<unknown>;
  usageReaders?: Partial<
    Record<'openai' | 'cursor' | 'zen' | 'antigravity' | 'grok', ProviderUsageReader>
  >;
  token: string;
  enabledProviders?: readonly string[];
  authFile: string;
  fetchImpl?: GatewayFetch;
  onEvent?: (event: GatewayEvent) => void;
  timeoutMs?: number;
  cursor?: NativeHarness;
  antigravity?: NativeHarness;
  grok?: NativeHarness;
  zen?: { apiKey: string };
  /** OpenAI review for GPT-originated actions, independent of Claude authentication. */
  approvalBridge?: Pick<NativeApprovalBridge, 'respond'>;
  approvalProviders?: readonly ('openai' | 'cursor')[];
  /** No Anthropic credentials: also block passthrough if no reviewer is available. */
  blockAnthropic?: boolean;
  guardAuto?: boolean;
  permissionModes?: PermissionModes;
  agentCatalog?: AgentCatalog;
  modBridge?: ModBridge;
}

/** Rejected before any provider call; answered as HTTP 400 rather than 502. */
class BadRequest extends Error {}
class UpstreamFailure extends Error {
  status: number;
  retryAfter: string | null;
  constructor(status: number, retryAfter: string | null, provider = 'OpenAI') {
    const authHelp = provider === 'OpenAI' ? ' Renew the Codex login.' : ' Check the Zen API key.';
    super(`${provider} returned HTTP ${status}.${status === 401 ? authHelp : ''}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function providerOwnedReview(model: string): boolean {
  return (
    model.startsWith('multi/openai/') ||
    model.startsWith('multi/cursor/') ||
    model.startsWith('multi/antigravity/') ||
    model.startsWith('multi/grok/')
  );
}

function authenticated(actual: string | string[] | undefined, expected: string): boolean {
  const a = Buffer.from(String(actual ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

interface ProviderRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: MessagesRequest;
  parsed: Record<string, unknown>;
  raw: Buffer;
  url: URL;
  signal: AbortSignal;
  abort: AbortController;
  agentId?: string;
  identity: ReturnType<typeof requestIdentity>;
  permissionContext?: PermissionContext;
  emit: Emit;
  remember: (tool: { id: string; name: string; input: unknown }) => void;
  startStream: () => void;
}

export function createNativeGateway({
  token,
  enabledProviders,
  authFile,
  fetchImpl = fetch,
  onEvent: observer = () => {},
  timeoutMs,
  cursor,
  antigravity,
  grok,
  zen,
  approvalBridge,
  approvalProviders: _approvalProviders = approvalBridge ? ['openai'] : [],
  blockAnthropic,
  guardAuto,
  permissionModes,
  agentCatalog,
  modBridge = new ModBridge(),
  receipts = new ReceiptLedger(),
  usageDashboard,
  billedUsage,
  usageReaders = {},
}: GatewayOptions): Server {
  const dashboard =
    usageDashboard ??
    new ProviderUsageDashboard({
      enabled: (enabledProviders ?? ['openai', 'cursor', 'zen', 'antigravity', 'grok']).filter(
        (provider) => {
          if (provider === 'cursor') {
            return Boolean(cursor);
          }
          if (provider === 'zen') {
            return Boolean(zen);
          }
          if (provider === 'antigravity') {
            return Boolean(antigravity);
          }
          if (provider === 'grok') {
            return Boolean(grok);
          }
          return provider === 'openai';
        },
      ),
      ...usageReaders,
    });
  const onEvent = (event: GatewayEvent) => {
    receipts.observe(event);
    observer(event);
  };
  if (!token) {
    throw new Error('Gateway token required');
  }
  if (zen) {
    validateZenKey(zen.apiKey);
  }
  const fallbackSession = randomUUID();
  const approvalContexts = new Map<string, ApprovalContext>();
  const pendingTools = new Map<string, PendingApprovalTool>();
  const reviewCandidates = new Map<
    string,
    { tool: PendingApprovalTool; context: ApprovalContext }
  >();
  function nativeReviewSession(session: unknown) {
    if (blockAnthropic || typeof session !== 'string' || !session) {
      return false;
    }
    const contexts = [...approvalContexts.values()].filter((context) => {
      try {
        return JSON.parse(context.scope)[0] === session;
      } catch {
        return false;
      }
    });
    // A native classifier may pass through only when this session has no
    // provider-owned review context. Per-action routing below handles mixed
    // sessions; this fallback covers native Claude's classifier retries that
    // carry no correlatable tool action.
    return contexts.length > 0 && contexts.every((context) => !providerOwnedReview(context.model));
  }
  const matchesBashAction = (
    candidate: { tool: PendingApprovalTool; context: ApprovalContext },
    action: unknown,
  ) => {
    if (
      !isRecord(candidate.tool.input) ||
      typeof candidate.tool.input.command !== 'string' ||
      typeof action !== 'string'
    ) {
      return false;
    }
    if (candidate.tool.input.command === action) {
      return true;
    }
    // Claude's classifier omits its redundant current-workspace `cd` prefix.
    const cwd =
      typeof candidate.context.cwd === 'string'
        ? approvalCwdForComparison(candidate.context.cwd)
        : undefined;
    return (
      cwd !== undefined &&
      candidate.tool.input.command.replaceAll('\\', '/') === `cd ${cwd} && ${action}`
    );
  };
  function permissionHook(parsed: Record<string, unknown>) {
    const id = typeof parsed.tool_use_id === 'string' ? parsed.tool_use_id : '';
    const pending = pendingTools.get(id);
    pendingTools.delete(id);
    if (
      pending?.scope &&
      pending.session === parsed.session_id &&
      pending.name === parsed.tool_name &&
      typeof parsed.cwd === 'string' &&
      path.isAbsolute(parsed.cwd)
    ) {
      const context = approvalContexts.get(pending.scope);
      if (context?.model === pending.model) {
        evictOldest(reviewCandidates, 512);
        reviewCandidates.set(id, { tool: pending, context: { ...context, cwd: parsed.cwd } });
      }
    }
    // Permission hooks only enrich attribution. Provider review is enforced
    // when Claude sends the actual classifier request, where its origin can be
    // matched against the observed action and retained provider context.
    return {};
  }
  function retainContext(
    approvalScope: string,
    external: string,
    body: MessagesRequest,
    identity: string | undefined,
    agentId: string | undefined,
  ) {
    for (const [id, candidate] of reviewCandidates) {
      if (candidate.context.scope === approvalScope) {
        reviewCandidates.delete(id);
      }
    }
    // Each worker retains its own current request; provider switches replace it.
    approvalContexts.delete(approvalScope);
    evictOldest(approvalContexts, 128);
    approvalContexts.set(approvalScope, {
      model: external,
      request: body,
      scope: approvalScope,
      worker: Boolean(agentId),
      rootRequest: agentId
        ? approvalContexts.get(JSON.stringify([identity, 'main']))?.request
        : undefined,
    });
  }
  function reviewCandidatesFor(parsed: Record<string, unknown>, sourceSession: string) {
    const { action } = parseApprovalRequest(parsed);
    const name = Object.keys(action)[0];
    return [...reviewCandidates.values()].filter(
      (candidate) =>
        candidate.tool.session === sourceSession &&
        candidate.tool.name === name &&
        (name !== 'Bash' || matchesBashAction(candidate, action[name])),
    );
  }
  function pendingReview(parsed: Record<string, unknown>, sourceSession: string) {
    const candidates = reviewCandidatesFor(parsed, sourceSession);
    if (candidates.length !== 1) {
      throw new BadRequest('Missing or ambiguous pending review action');
    }
    return candidates[0].context;
  }
  const compactions = new ModCompactions(async (request) => {
    const model = request.context.model;
    const provider = model?.split('/')[1];
    const harness = provider === 'cursor' ? cursor : grokOrAntigravity(provider);
    const native = harness;
    if (!native || !model) {
      throw new Error('Precomputed summaries require a native harness model');
    }
    assertProviderEnabled(model, enabledProviders);
    // Use a separate native record. A speculative summary never advances or rewinds
    // the originating run and never receives native tool capabilities.
    const result = await native.handle(
      {
        model,
        max_tokens: 3000,
        messages: [
          {
            role: 'user',
            content: `Summarize this conversation for continuation. Preserve tasks, constraints, decisions and unresolved work. Do not execute tools. Instructions: ${request.instructions ?? ''}\n${JSON.stringify(request.messages)}`,
          },
        ],
      },
      JSON.stringify([request.session, `compact-${request.id}`]),
      request.signal,
      undefined,
      request.context,
    );
    return result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  });

  function grokOrAntigravity(provider: string | undefined) {
    if (provider === 'antigravity') {
      return antigravity;
    }
    return provider === 'grok' ? grok : undefined;
  }

  async function handleHarness(
    exchange: ProviderRequest,
    provider: 'cursor' | 'antigravity' | 'grok',
  ) {
    const { res, body, url, signal, agentId, emit, identity } = exchange;
    const bridge = { cursor, antigravity, grok }[provider];
    if (!bridge) {
      const unavailable = {
        cursor: 'Cursor SDK is not signed in. Run the launcher with --cursor-login first.',
        antigravity:
          'Antigravity is unavailable. Install and connect the multi-antigravity plugin.',
        grok: 'Grok is unavailable. Install Grok Build, run grok login, and relaunch.',
      };
      throw new BadRequest(unavailable[provider]);
    }
    const scope = identity.scope ?? JSON.stringify([fallbackSession, agentId ?? 'main']);
    const nativeBody = exchange.body;
    const inputTokens = validateHarness(exchange, provider, bridge);
    if (url.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-multi-token-count': 'estimate',
      });
      return res.end(JSON.stringify({ input_tokens: inputTokens }));
    }
    exchange.startStream();
    const displayRows = provider === 'cursor' && modBridge.available(nativeBody);
    modBridge.begin(scope, body.model ?? provider);
    const result = await bridge
      .handle(
        nativeBody,
        scope,
        signal,
        body.stream ? emit : undefined,
        exchange.permissionContext,
        displayRows ? (observation) => modBridge.observe(scope, observation) : undefined,
      )
      .catch((error: unknown) => {
        modBridge.complete(scope, signal.aborted ? 'cancelled' : 'failed');
        throw error;
      });
    permissionModes?.finishModCompaction(
      identity.session,
      agentId,
      exchange.permissionContext?.compaction,
    );
    rememberResult(exchange, result);
    onEvent(completionEvent(exchange, result, provider, harnessEndpoint(provider)));
    sendResult(exchange, result);
    modBridge.complete(scope);
  }
  async function handleOpenAI(exchange: ProviderRequest, externalModel: string) {
    const { req, res, body, url, signal, abort, agentId, emit } = exchange;
    const request = openaiRequest(exchange, externalModel);
    request.prompt_cache_key = createHash('sha256')
      .update(
        JSON.stringify([
          'openai',
          exchange.identity.session || fallbackSession,
          agentId ?? 'main',
          request.model,
        ]),
      )
      .digest('hex');
    if (url.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-multi-token-count': 'estimate',
      });
      return res.end(JSON.stringify({ input_tokens: estimateInputTokens(request) }));
    }
    const toolNames = originalToolNames(body);
    onEvent({
      route: 'openai-request',
      agentId,
      model: request.model,
      effort: request.reasoning.effort,
    });
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      originator: 'cc_multi_native',
      session_id: String(
        agentId ?? header(req.headers['x-claude-code-session-id']) ?? fallbackSession,
      ),
    };
    const upstream = await codexRequest(authFile, signal, (auth) =>
      fetchImpl(OPENAI_URL, {
        method: 'POST',
        headers: { ...headers, ...auth },
        body: JSON.stringify(request),
        signal,
        redirect: 'error',
      }),
    );
    if (!upstream.ok) {
      // Do not print upstream bodies or credentials in gateway diagnostics.
      onEvent({ route: 'openai', status: upstream.status });
      await upstream.body?.cancel();
      throw new UpstreamFailure(upstream.status, upstream.headers.get('retry-after'));
    }
    if (!upstream.body) {
      throw new Error('OpenAI returned no response stream.');
    }
    exchange.startStream();
    const result = await fromResponses(
      upstream.body,
      externalModel,
      body.stream ? emit : undefined,
      { toolNames, stopSequences: body.stop_sequences, inputTokens: estimateInputTokens(request) },
    );
    rememberResult(exchange, result);
    if (result.stop_reason === 'stop_sequence') {
      abort.abort();
    }
    onEvent({
      ...completionEvent(exchange, result, 'openai', 'responses'),
      model: request.model,
      effort: request.reasoning.effort,
    });
    sendResult(exchange, result);
  }
  async function handleZen(exchange: ProviderRequest) {
    const { res, body, url, signal, agentId, emit } = exchange;
    if (!zen?.apiKey) {
      throw new BadRequest('Zen is not configured. Set OPENCODE_API_KEY or connect OpenCode Zen.');
    }
    const prepared = prepareZenRequest(exchange, fallbackSession);
    if (url.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-multi-token-count': 'estimate' });
      return res.end(JSON.stringify({ input_tokens: prepared.inputTokens }));
    }
    onEvent({ route: 'zen-request', agentId, model: body.model });
    const upstream = await fetchImpl(`https://opencode.ai/zen/v1/${prepared.endpoint}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${zen.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-opencode-session': prepared.cacheKey,
        'x-opencode-client': 'cc-multi-cli-plugin',
      },
      body: JSON.stringify(prepared.body),
      signal,
      redirect: 'error',
    });
    if (!upstream.ok) {
      onEvent({ route: 'zen', agentId, status: upstream.status });
      await upstream.body?.cancel();
      throw new UpstreamFailure(upstream.status, upstream.headers.get('retry-after'), 'Zen');
    }
    if (!upstream.body) {
      throw new Error('Zen returned no response stream.');
    }
    exchange.startStream();
    const options = {
      toolNames: originalToolNames(body),
      stopSequences: body.stop_sequences,
      signaturePrefix: prepared.signaturePrefix,
      requireUsage: true,
      inputTokens: prepared.inputTokens,
    };
    const translate = prepared.endpoint === 'responses' ? fromResponses : fromChat;
    const result = await translate(
      upstream.body,
      String(body.model),
      body.stream ? emit : undefined,
      options,
    );
    rememberResult(exchange, result);
    if (result.stop_reason === 'stop_sequence') {
      exchange.abort.abort();
    }
    onEvent(completionEvent(exchange, result, 'zen', prepared.endpoint));
    sendResult(exchange, result);
  }
  async function handleAnthropic(exchange: ProviderRequest) {
    const { req, res, body, url, raw, signal } = exchange;
    const headers = anthropicHeaders(req);
    const cleaned = forAnthropic(body);
    let forwarded: Buffer | undefined;
    if (req.method === 'POST') {
      forwarded = cleaned === body ? raw : Buffer.from(JSON.stringify(cleaned));
    }
    const upstream = await fetchImpl(ANTHROPIC_URL + url.pathname + url.search, {
      method: req.method ?? 'GET',
      headers,
      body: forwarded,
      signal,
      redirect: 'error',
    });
    onEvent({ route: 'anthropic', status: upstream.status, model: body.model });
    const responseHeaders = Object.fromEntries(upstream.headers);
    for (const name of STRIPPED_RESPONSE_HEADERS) {
      delete responseHeaders[name];
    }
    res.writeHead(upstream.status, responseHeaders);
    if (guardAuto && upstream.ok && body.tools?.length) {
      await forwardObservedTools(upstream, res, exchange.remember, signal);
    } else if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end();
    }
  }
  async function handleReview(exchange: ProviderRequest, context: ApprovalContext | undefined) {
    const { req, res, parsed, url, signal, agentId } = exchange;
    if (!approvalBridge) {
      throw new Error('Approval bridge unavailable');
    }
    if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
      throw new BadRequest('Anthropic passthrough is disabled');
    }
    const result = await approvalBridge.respond(parsed, signal, context);
    const worker = context ? JSON.parse(context.scope)[1] : agentId;
    onEvent({
      route: 'approval',
      model: result.message.model,
      agentId: worker === 'main' ? null : (worker ?? null),
      stage: result.stage,
      outcome: result.outcome,
      cached: result.cached,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(result.message));
  }
  function retainRequestContext(
    { body, url, req, agentId }: ProviderRequest,
    { identity, scope }: ReturnType<typeof requestIdentity>,
    external: string,
  ) {
    if ((!guardAuto && !approvalBridge) || !scope || !body.tools?.length) {
      return;
    }
    if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
      return;
    }
    retainContext(scope, external, body, identity, agentId);
  }
  async function sendPermissionDecision({ req, res, parsed }: ProviderRequest) {
    if (req.method !== 'POST') {
      throw new BadRequest('Permission hook requires POST');
    }
    const decision = permissionHook(parsed);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(decision));
  }
  async function dispatchNativeClassification(
    exchange: ProviderRequest,
    metadata: ReturnType<typeof requestIdentity>,
  ) {
    let candidates: ReturnType<typeof reviewCandidatesFor>;
    try {
      candidates = reviewCandidatesFor(exchange.parsed, metadata.session);
    } catch (error) {
      if (nativeReviewSession(metadata.session)) {
        return handleAnthropic(exchange);
      }
      throw error;
    }
    if (candidates.length === 1) {
      const context = candidates[0].context;
      if (providerOwnedReview(context.model)) {
        return dispatchReview(exchange, metadata, null);
      }
      return handleAnthropic(exchange);
    }
    if (
      candidates.length > 1 &&
      candidates.some(({ context }) => context.model.startsWith('multi/openai/'))
    ) {
      return dispatchReview(exchange, metadata, null);
    }
    if (nativeReviewSession(metadata.session)) {
      return handleAnthropic(exchange);
    }
    return dispatchReview(exchange, metadata, null);
  }
  async function dispatch(
    exchange: ProviderRequest,
    metadata: ReturnType<typeof requestIdentity>,
    external: string | null,
  ) {
    const { parsed } = exchange;
    const classification = isApprovalRequest(parsed);
    if (classification) {
      if (!external) {
        return dispatchNativeClassification(exchange, metadata);
      }
      return dispatchReview(exchange, metadata, external);
    }
    retainRequestContext(exchange, metadata, String(exchange.body.model ?? ''));
    if (!external && blockAnthropic) {
      throw new BadRequest('Anthropic is not signed in. Select an external model.');
    }
    return forwardProvider(exchange, external);
  }
  async function dispatchReview(
    exchange: ProviderRequest,
    metadata: ReturnType<typeof requestIdentity>,
    external: string | null,
  ) {
    // Native classification may omit the worker header or retry with a working
    // model ID. The pending action, not that ID or the current parent, owns review.
    let context = metadata.scope ? approvalContexts.get(metadata.scope) : undefined;
    if (guardAuto) {
      context = pendingReview(exchange.parsed, metadata.session);
    }
    const openai = context?.model.startsWith('multi/openai/');
    if (approvalBridge && (openai || (!guardAuto && !context))) {
      return handleReview(exchange, context);
    }
    const nativeClaude =
      context && (!context.model.startsWith('multi/') || context.model.startsWith('multi/zen/'));
    if (openai || external || blockAnthropic || (context && !nativeClaude)) {
      throw new BadRequest(
        'Automatic review cannot use ordinary external inference. No matching provider reviewer is enabled.',
      );
    }
    return handleAnthropic(exchange);
  }
  function completionEvent(
    exchange: ProviderRequest,
    result: MessagesResponse,
    route: GatewayEvent['route'],
    endpoint: string,
  ): GatewayEvent {
    return {
      route,
      endpoint,
      session: exchange.identity.session || fallbackSession,
      agentId: exchange.agentId,
      model: result.multi_usage?.model ?? exchange.body.model,
      effort: result.multi_usage?.effort ?? exchange.body.output_config?.effort,
      stopReason: result.stop_reason,
      tools: result.content.filter((block) => block.type === 'tool_use').map((block) => block.name),
      usage: result.usage,
      usageMetadata: result.multi_usage ?? { source: 'unavailable' },
      requestId: JSON.stringify([
        route,
        exchange.identity.session || fallbackSession,
        exchange.agentId,
        result.id,
      ]),
    };
  }
  function beginUsage(exchange: ProviderRequest, external: string | null) {
    if (external && exchange.url.pathname === '/v1/messages') {
      receipts.start({
        session: exchange.identity.session || fallbackSession,
        agentId: exchange.agentId,
      });
    }
  }
  async function forwardProvider(exchange: ProviderRequest, external: string | null) {
    const { body, agentId, url } = exchange;
    const route = providerRoute(external);
    beginUsage(exchange, external);
    let permissionContext: PermissionContext | undefined;
    if (
      permissionModes &&
      ['cursor', 'antigravity', 'grok'].includes(route) &&
      url.pathname === '/v1/messages'
    ) {
      try {
        permissionContext = permissionModes.resolveHarness(
          exchange.identity.session,
          agentId,
          body.model,
        );
        exchange.permissionContext = permissionContext;
      } catch (error) {
        throw new BadRequest(reason(error));
      }
    }
    onEvent({
      route,
      model: body.model,
      agentId: agentId ?? null,
      path: url.pathname,
      permissionContext,
    });
    if (!external) {
      return handleAnthropic(exchange);
    }
    if (route === 'cursor' || route === 'antigravity' || route === 'grok') {
      return handleHarness(exchange, route);
    }
    if (external.startsWith('multi/zen/')) {
      return handleZen(exchange);
    }
    return handleOpenAI(exchange, external);
  }
  return http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abort.abort();
      }
    });
    let heartbeat: NodeJS.Timeout | undefined;
    let sourceModel = '';
    let sourceSession = '';
    let sourceScope: string | undefined;
    const observer = new ToolObserver((tool) => remember(tool));
    const remember = (tool: { id: string; name: string; input: unknown }) => {
      if (!guardAuto || !sourceSession) {
        return;
      }
      evictOldest(pendingTools, 512);
      pendingTools.set(tool.id, {
        model: sourceModel,
        session: sourceSession,
        name: tool.name,
        input: tool.input,
        scope: sourceScope,
      });
      if (sourceScope) {
        const context = approvalContexts.get(sourceScope);
        if (context?.model === sourceModel) {
          evictOldest(reviewCandidates, 512);
          reviewCandidates.set(tool.id, {
            tool: {
              model: sourceModel,
              session: sourceSession,
              name: tool.name,
              input: tool.input,
              scope: sourceScope,
            },
            context,
          });
        }
      }
    };
    const emit: Emit = (type, value) => {
      if (guardAuto) {
        observer.event({ type, ...value });
      }
      return res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    };
    try {
      if (!authorizeRequest(req, res, token, guardAuto)) {
        return;
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const { raw, parsed, body } = await readRequest(req, agentCatalog);
      if (url.pathname.startsWith('/multi/mod/')) {
        return handleModRoute(
          req,
          res,
          url,
          parsed,
          modBridge,
          permissionModes,
          compactions,
          receipts,
          billedUsage,
          dashboard,
        );
      }
      const external = externalModel(body.model);
      assertProviderEnabled(external, enabledProviders);
      const signal = providerSignal(abort.signal, external, timeoutMs);
      const agentId = header(req.headers['x-claude-code-agent-id']);
      const metadata = requestIdentity(
        parsed,
        agentId,
        header(req.headers['x-claude-code-session-id']),
      );
      sourceModel = String(body.model ?? '');
      sourceSession = metadata.session;
      sourceScope = metadata.scope;
      const exchange: ProviderRequest = {
        req,
        res,
        body,
        parsed,
        identity: metadata,
        raw,
        url,
        signal,
        abort,
        agentId,
        emit,
        remember,
        startStream: () => {
          if (!body.stream) {
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.flushHeaders();
          heartbeat = setInterval(() => emit('ping', {}), 15000);
        },
      };
      if (url.pathname === '/multi/permission') {
        return sendPermissionDecision(exchange);
      }
      await dispatch(exchange, metadata, external);
    } catch (error) {
      abort.abort();
      failResponse(res, emit, error);
    } finally {
      clearInterval(heartbeat);
    }
  });
}

class RequestTooLarge extends Error {}

function providerSignal(disconnected: AbortSignal, model: string | null, timeoutMs?: number) {
  // Native harness runs follow the client connection rather than an HTTP deadline.
  if (
    model?.startsWith('multi/cursor/') ||
    model?.startsWith('multi/antigravity/') ||
    model?.startsWith('multi/grok/')
  ) {
    return disconnected;
  }
  // Streamed OpenAI, Zen and Claude responses (including server-side advisor calls)
  // can outlive any fixed wall-clock deadline; only an explicit limit bounds them.
  if (timeoutMs === undefined) {
    return disconnected;
  }
  return AbortSignal.any([disconnected, AbortSignal.timeout(timeoutMs)]);
}

async function readRequest(req: http.IncomingMessage, catalog?: AgentCatalog) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > (req.url?.startsWith('/multi/mod/') ? 32 * 1024 : MAX_BODY)) {
      throw new RequestTooLarge();
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    throw new BadRequest('Invalid JSON');
  }
  if (!isRecord(parsed) || (parsed.model !== undefined && typeof parsed.model !== 'string')) {
    throw new BadRequest('Expected an object with a string model');
  }
  const body: MessagesRequest = isApprovalRequest(parsed)
    ? parsed
    : (catalog?.compact(parsed) ?? parsed);
  return { raw: body === parsed ? raw : Buffer.from(JSON.stringify(body)), parsed, body };
}

function providerRoute(
  model: string | null,
): 'cursor' | 'antigravity' | 'grok' | 'openai' | 'anthropic' | 'zen' {
  if (model?.startsWith('multi/cursor/')) {
    return 'cursor';
  }
  if (model?.startsWith('multi/antigravity/')) {
    return 'antigravity';
  }
  if (model?.startsWith('multi/grok/')) {
    return 'grok';
  }
  if (model?.startsWith('multi/zen/')) {
    return 'zen';
  }
  return model ? 'openai' : 'anthropic';
}
function harnessEndpoint(provider: 'cursor' | 'antigravity' | 'grok'): string {
  return { cursor: '@cursor/sdk', antigravity: 'agy', grok: 'grok' }[provider];
}

function errorStatus(error: unknown): number {
  if (error instanceof CodexAuthError) {
    return 401;
  }
  if (error instanceof BadRequest) {
    return 400;
  }
  if (error instanceof UpstreamFailure) {
    return error.status;
  }
  const harnessStatus = nativeHarnessErrorStatus(error);
  if (harnessStatus !== undefined) {
    return harnessStatus;
  }
  return 502;
}

function rememberResult(exchange: ProviderRequest, result: MessagesResponse) {
  if (exchange.body.stream) {
    return;
  }
  for (const tool of result.content) {
    if (tool.type === 'tool_use') {
      exchange.remember(tool);
    }
  }
}
function sendResult(exchange: ProviderRequest, result: MessagesResponse) {
  if (!exchange.body.stream) {
    exchange.res.writeHead(200, { 'content-type': 'application/json' });
  }
  exchange.res.end(exchange.body.stream ? undefined : JSON.stringify(result));
}

function evictOldest<T>(cache: Map<string, T>, capacity: number) {
  const oldest = cache.keys().next();
  if (cache.size >= capacity && !oldest.done) {
    cache.delete(oldest.value);
  }
}

function requestIdentity(
  parsed: Record<string, unknown>,
  agentId?: string,
  sessionHeader?: string,
) {
  const rawIdentity =
    isRecord(parsed.metadata) && typeof parsed.metadata.user_id === 'string'
      ? parsed.metadata.user_id
      : undefined;
  let session = '';
  if (rawIdentity) {
    try {
      const metadata: unknown = JSON.parse(rawIdentity);
      if (isRecord(metadata) && typeof metadata.session_id === 'string') {
        session = metadata.session_id;
      }
    } catch {
      /* Unknown identity cannot grant auto capability. */
    }
  }
  if (session && sessionHeader && session !== sessionHeader) {
    throw new BadRequest('Session header and metadata disagree');
  }
  session = session || sessionHeader || '';
  const identity = session || rawIdentity;
  return {
    identity,
    session,
    scope: identity ? JSON.stringify([identity, agentId ?? 'main']) : undefined,
  };
}

function prepareZenRequest(exchange: ProviderRequest, fallbackSession: string) {
  const { req, body, url, identity, agentId } = exchange;
  try {
    if (
      req.method !== 'POST' ||
      !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)
    ) {
      throw new Error('Zen requires POST /v1/messages or /v1/messages/count_tokens');
    }
    // Zen uses this for sticky upstream routing. Claude identity survives restarts;
    // no per-request nonce is inserted into the prompt or cache key.
    const cacheKey = createHash('sha256')
      .update(
        JSON.stringify([
          identity.session || fallbackSession,
          agentId ?? 'main',
          body.model,
          process.cwd(),
        ]),
      )
      .digest('hex');
    return { ...zenRequest(body, cacheKey), cacheKey };
  } catch (error) {
    throw new BadRequest(reason(error));
  }
}

function openaiRequest(exchange: ProviderRequest, externalModel: string): ResponsesRequest {
  const { req, body, url } = exchange;
  try {
    const model = Object.values(MODELS).find((model) => externalModel === `multi/openai/${model}`);
    if (!model) {
      throw new Error('Unknown native OpenAI model');
    }
    if (
      !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname) ||
      req.method !== 'POST'
    ) {
      throw new Error('External models require POST /v1/messages or /v1/messages/count_tokens');
    }
    const request = toResponses(body, model);
    return { ...request, instructions: openaiInstructions(request.instructions) };
  } catch (error) {
    throw new BadRequest(reason(error));
  }
}

function anthropicHeaders(req: http.IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const single = header(value);
    if (single !== undefined && !STRIPPED_REQUEST_HEADERS.includes(name)) {
      headers[name] = single;
    }
  }
  headers['accept-encoding'] = 'identity';
  return headers;
}

function authorizeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  guardAuto?: boolean,
) {
  if (req.headers.origin || !authenticated(req.headers['x-multi-gateway-token'], token)) {
    const pathName = new URL(req.url ?? '', 'http://localhost').pathname;
    res.writeHead(pathName.startsWith('/multi/mod/') ? 401 : 403);
    res.end('Forbidden');
    return false;
  }
  const url = new URL(req.url ?? '', 'http://localhost');
  if (
    ![
      '/v1/messages',
      '/v1/messages/count_tokens',
      '/v1/models',
      '/api/hello',
      '/multi/mod/session',
      '/multi/mod/worker',
      '/multi/mod/worker-model',
      '/multi/mod/mode',
      '/multi/mod/policy',
      '/multi/mod/offer',
      '/multi/mod/telemetry',
      '/multi/mod/lifecycle',
      '/multi/mod/usage',
      '/multi/mod/usage/complete',
      '/multi/mod/receipts',
      '/multi/mod/detach',
      '/multi/mod/compact/precompute',
      '/multi/mod/compact/run',
      '/multi/mod/compact/authorize',
      '/multi/mod/compact/cancel',
      ...(guardAuto ? ['/multi/permission'] : []),
    ].includes(url.pathname) ||
    !['POST', 'GET', 'HEAD'].includes(req.method ?? '')
  ) {
    res.writeHead(404);
    res.end('Not found');
    return false;
  }
  return true;
}

function failResponse(res: http.ServerResponse, emit: Emit, error: unknown) {
  if (res.destroyed) {
    return;
  }
  const status = errorStatus(error);
  if (error instanceof RequestTooLarge) {
    res.writeHead(413);
    res.end('Request too large');
    return;
  }
  const errorTypes: Record<number, string> = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    429: 'rate_limit_error',
    503: 'overloaded_error',
  };
  const failure = {
    type: 'error',
    error: {
      type: errorTypes[status] ?? 'api_error',
      message: `Native gateway: ${reason(error)}`,
    },
  };
  if (error instanceof UpstreamFailure && error.retryAfter && !res.headersSent) {
    res.setHeader('retry-after', error.retryAfter);
  }
  if (res.headersSent) {
    emit('error', { error: failure.error });
    res.end();
  } else {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failure));
  }
}

function assertProviderEnabled(model: string | null, enabled: readonly string[] | undefined) {
  if (model && enabled && !enabled.includes(model.split('/')[1])) {
    throw new BadRequest('This provider plugin is not enabled for this session.');
  }
}

function externalModel(model: unknown) {
  return typeof model === 'string' && model.startsWith('multi/') ? model : null;
}
function validateHarness(
  exchange: ProviderRequest,
  provider: string,
  bridge: NonNullable<GatewayOptions['cursor'] | GatewayOptions['antigravity']>,
) {
  try {
    if (
      !['/v1/messages', '/v1/messages/count_tokens'].includes(exchange.url.pathname) ||
      exchange.req.method !== 'POST'
    ) {
      throw new Error(`${provider} requires POST /v1/messages or /v1/messages/count_tokens`);
    }
    return bridge.validate(exchange.body, exchange.permissionContext);
  } catch (error) {
    throw new BadRequest(reason(error));
  }
}
