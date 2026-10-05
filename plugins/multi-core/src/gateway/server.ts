import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  openaiSignaturePrefixes,
  prepareOpenAIRequest,
} from '../../../multi-openai/src/gateway-request.ts';
import { validateZenKey } from '../../../multi-zen/src/auth.ts';
import {
  prepareZenRequest,
  zenSignaturePrefixes,
  zenUnavailable,
} from '../../../multi-zen/src/gateway-request.ts';
import type { ApprovalContext, NativeApprovalBridge } from './approval.ts';
import { approvalCwdForComparison, isApprovalRequest, parseApprovalRequest } from './approval.ts';
import { setBounded } from './bounded.ts';
import {
  DisplayRows,
  displayFollowUp,
  FollowUpRefused,
  FollowUpUnavailable,
  followUpFallback,
  isDisplayTool,
  recordedFollowUp,
  unavailableFollowUp,
  withoutDisplayTools,
} from './display-rows.ts';
import type { GatewayFetch } from './fetch.ts';
import {
  emitHandback,
  handbackOffered,
  handbackRequestKind,
  recordedReport,
  withHandback,
  withoutHarnessHandback,
} from './harness-handback.ts';
import type { NativeObservation } from './harness-progress.ts';
import type { Emit, MessagesRequest, MessagesResponse, StopReason } from './messages.ts';
import { ModBridge } from './mod-bridge.ts';
import { ModCompactions } from './mod-compaction.ts';
import { MOD_KEY_HEADER, ModSessionKeys } from './mod-keys.ts';
import { handleModRoute } from './mod-routes.ts';
import type { PermissionContext, PermissionModes } from './mode-hook.ts';
import { type NativeHarness, nativeHarnessErrorStatus } from './native-harness.ts';
import type { PendingApprovalTool } from './permission-hook.ts';
import {
  type HarnessProvider,
  harnessEndpoint,
  harnessProvider,
  harnessUnavailable,
  isHarnessProvider,
  providerOwnedReview,
  providerRoute,
} from './provider.ts';
import type { PreparedRequest } from './provider-request.ts';
import { ProviderAuthError, UpstreamFailure } from './provider-request.ts';
import { ProviderUsageDashboard, type ProviderUsageReader } from './provider-usage.ts';
import { ReceiptLedger } from './receipts.ts';
import { isRecord } from './record.ts';
import { forAnthropic } from './responses.ts';
import { dangerousToolMode, safeguardResults } from './safeguards.ts';
import { forwardObservedTools, ToolObserver } from './tool-observer.ts';

/** Other providers' reasoning signatures mean nothing to Anthropic and are stripped. */
const FOREIGN_SIGNATURE_PREFIXES = [...openaiSignaturePrefixes, ...zenSignaturePrefixes];
const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com';
// Anthropic's own Messages API limit is 32 MB; the gateway buffers up to it and leaves
// the verdict to the provider, so a request Claude Code could send natively still goes.
const MAX_BODY = 32 * 1024 * 1024;
const STRIPPED_REQUEST_HEADERS = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'x-multi-gateway-token',
  'accept-encoding',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
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
  /** Why a request failed inside the gateway; never a credential or a body. */
  diagnostic?: string;
}

export interface GatewayOptions {
  receipts?: ReceiptLedger;
  usageDashboard?: ProviderUsageDashboard;
  billedUsage?: (session: string) => Promise<unknown>;
  usageReaders?: Partial<
    Record<'openai' | 'cursor' | 'zen' | 'antigravity' | 'grok', ProviderUsageReader>
  >;
  token: string;
  /** How long a non-streamed provider reply may stay silent before its headers go out. */
  jsonKeepAliveMs?: number;
  /** Where Claude's own traffic goes: Anthropic by default, or the caller's own base URL. */
  anthropicBaseUrl?: string;
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
  /** No Anthropic credentials: also block passthrough if no reviewer is available. */
  blockAnthropic?: boolean;
  guardAuto?: boolean;
  permissionModes?: PermissionModes;
  modBridge?: ModBridge;
  /** Display rows for native harness actions; the native tool names each harness is known to have. */
  displayRows?: DisplayRows;
  displayTools?: Partial<Record<'cursor' | 'antigravity' | 'grok', readonly string[]>>;
}

/** Rejected before any provider call; answered as HTTP 400 rather than 502. */
class BadRequest extends Error {}
class ForbiddenHost extends Error {}
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
  /** Arms the non-streamed keepalive before a slow upstream wait; a stream needs none. */
  keepAlive: () => void;
}

export function createNativeGateway({
  token,
  anthropicBaseUrl = DEFAULT_ANTHROPIC_URL,
  jsonKeepAliveMs = 30000,
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
  blockAnthropic,
  guardAuto,
  permissionModes,
  modBridge = new ModBridge(),
  displayRows = new DisplayRows(),
  displayTools = {},
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
  const anthropicOrigin = parseAnthropicBase(anthropicBaseUrl);
  const anthropicUrl = (url: URL) => anthropicOrigin + url.pathname + url.search;
  const modKeys = new ModSessionKeys();
  const fallbackSession = randomUUID();
  const harnesses: Record<HarnessProvider, NativeHarness | undefined> = {
    cursor,
    antigravity,
    grok,
  };
  const harnessFor = (provider: string | undefined) =>
    isHarnessProvider(provider) ? harnesses[provider] : undefined;
  // Offer the mod rows only for the harnesses this gateway runs.
  for (const [provider, names] of Object.entries(displayTools)) {
    if (harnessFor(provider) && names) {
      displayRows.announce(names);
    }
  }
  const approvalContexts = new Map<string, ApprovalContext>();
  const pendingTools = new Map<string, PendingApprovalTool>();
  const reviewCandidates = new Map<
    string,
    { tool: PendingApprovalTool; context: ApprovalContext }
  >();
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
        setBounded(
          reviewCandidates,
          id,
          { tool: pending, context: { ...context, cwd: parsed.cwd, ...reportedMode(parsed) } },
          512,
          'insertion',
        );
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
    setBounded(
      approvalContexts,
      approvalScope,
      {
        model: external,
        request: body,
        scope: approvalScope,
        worker: Boolean(agentId),
        rootRequest: agentId
          ? approvalContexts.get(JSON.stringify([identity, 'main']))?.request
          : undefined,
        requestPermissionMode: dangerousToolMode(body.safeguards),
      },
      128,
      'insertion',
    );
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
  function providerActionPending(sourceSession: string) {
    return [...reviewCandidates.values()].some(
      (candidate) =>
        candidate.tool.session === sourceSession && providerOwnedReview(candidate.context.model),
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
    const harness = harnessFor(harnessProvider(model));
    if (!harness || !model) {
      throw new Error('Precomputed summaries require a native harness model');
    }
    assertProviderEnabled(model, enabledProviders);
    // Use a separate native record. A speculative summary never advances or rewinds
    // the originating run and never receives native tool capabilities.
    const result = await harness.handle(
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

  function harnessScope({ identity, agentId }: ProviderRequest) {
    return identity.scope ?? JSON.stringify([fallbackSession, agentId ?? 'main']);
  }
  /**
   * A harness request refused before its native run starts still reaches the
   * status line with its reason; a failure alone tells the user nothing.
   */
  function refuseHarness(exchange: ProviderRequest, provider: string, error: unknown) {
    if (exchange.url.pathname === '/v1/messages') {
      modBridge.refuse(harnessScope(exchange), exchange.body.model ?? provider, reason(error));
    }
    return error;
  }
  async function handleHarness(exchange: ProviderRequest, provider: HarnessProvider) {
    const { res, body, url, signal, agentId, emit, identity } = exchange;
    const bridge = harnesses[provider];
    if (!bridge) {
      throw refuseHarness(exchange, provider, new BadRequest(harnessUnavailable[provider]));
    }
    const scope = harnessScope(exchange);
    let inputTokens: number;
    try {
      inputTokens = validateHarness(exchange, provider, bridge);
    } catch (error) {
      throw refuseHarness(exchange, provider, error);
    }
    if (url.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-multi-token-count': 'estimate',
      });
      return res.end(JSON.stringify({ input_tokens: inputTokens }));
    }
    exchange.startStream();
    // Each finished native action becomes a display row in this reply, so it
    // anchors in this session's (or this worker's) own transcript.
    const run = modBridge.begin(scope, body.model ?? provider);
    const observe = (observation: NativeObservation) => {
      if (observation.type === 'toolset') {
        displayRows.announce(observation.tools);
        return undefined;
      }
      modBridge.observe(scope, run, observation);
      return observation.type === 'completed'
        ? displayRows.issue(scope, observation.row)
        : undefined;
    };
    const deliverHandback = handbackOffered(exchange.parsed as MessagesRequest);
    const streamed = harnessStreamEmitter(emit, deliverHandback);
    const nativeResult = await bridge
      .handle(
        body,
        scope,
        signal,
        body.stream ? streamed : undefined,
        exchange.permissionContext,
        observe,
      )
      .catch((error: unknown) => {
        modBridge.complete(scope, signal.aborted ? 'cancelled' : 'failed', run, reason(error));
        // A failed compaction turn must not leave its scope tool-free.
        permissionModes?.finishModCompaction(
          identity.session,
          agentId,
          exchange.permissionContext?.compaction,
        );
        throw error;
      });
    const result = finishHarnessDelivery(nativeResult, deliverHandback, body, emit);
    permissionModes?.finishModCompaction(
      identity.session,
      agentId,
      exchange.permissionContext?.compaction,
    );
    if (result.multi_followup !== undefined) {
      displayRows.rememberFollowUp(
        { scope, provider },
        {
          id: result.id,
          rows: result.content.flatMap((block) =>
            block.type === 'tool_use' && isDisplayTool(block.name) ? [block.id] : [],
          ),
          text: result.multi_followup,
          usage: result.usage,
        },
      );
    }
    rememberResult(exchange, result);
    onEvent(completionEvent(exchange, result, provider, harnessEndpoint(provider)));
    sendResult(exchange, result);
    modBridge.complete(scope, 'completed', run);
  }
  /**
   * The engine ran a reply's display rows and asks for the turn's next message.
   * That message is the text the reply deferred; no provider is called, so the
   * rows' results never reach a model.
   */
  async function answerFollowUp(
    exchange: ProviderRequest,
    ids: readonly string[],
    external: string | null,
    deliverHandback: boolean,
  ) {
    const { body, emit } = exchange;
    const followUp = await pendingFollowUp(exchange, ids, providerRoute(external));
    // An empty deferral is the reply's own choice; the turn's last message still says something.
    const text = followUp.text || followUpFallback;
    // The reply's context carries over, so the window's fill does not read as empty
    // after a turn with rows; the reply already reported its output and its spend.
    const context = followUp.usage;
    const plain: MessagesResponse = {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: body.model ?? '',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: context ? { ...context, output_tokens: 0 } : { input_tokens: 0, output_tokens: 0 },
    };
    const result = deliverHandback ? withHandback(plain, text, body.safeguards) : plain;
    const safeguard_results =
      result.safeguard_results ?? safeguardResults(body.safeguards, result.content, 'native');
    if (safeguard_results) {
      result.safeguard_results = safeguard_results;
    }
    if (body.stream) {
      exchange.startStream();
      emit('message_start', { message: { ...result, content: [], stop_reason: null } });
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
      emit('content_block_stop', { index: 0 });
      if (deliverHandback) {
        emitHandback(emit, result);
      }
      emitTerminal(emit, result);
    }
    sendResult(exchange, result);
  }
  async function answerHandbackOnly(exchange: ProviderRequest, external: string | null) {
    const harness = harnessFor(providerRoute(external));
    const recorded = await harness?.recordedResponse?.(
      harnessScope(exchange),
      followUpContext(exchange),
    );
    const report = recordedReport(recorded);
    if (report === undefined) {
      throw new BadRequest('No recorded harness report is available for SubagentHandback');
    }
    const plain: MessagesResponse = {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: exchange.body.model ?? '',
      content: [{ type: 'text', text: report }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: recorded?.usage ?? { input_tokens: 0, output_tokens: 0 },
    };
    const result = withHandback(plain, report, exchange.body.safeguards);
    if (exchange.body.stream) {
      exchange.startStream();
      exchange.emit('message_start', { message: { ...result, content: [], stop_reason: null } });
      exchange.emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      exchange.emit('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: report },
      });
      exchange.emit('content_block_stop', { index: 0 });
      emitHandback(exchange.emit, result);
      emitTerminal(exchange.emit, result);
    }
    sendResult(exchange, result);
  }
  async function answerHandbackRequest(
    exchange: ProviderRequest,
    kind: ReturnType<typeof handbackRequestKind>,
    deliverHandback: boolean,
    external: string | null,
  ): Promise<boolean> {
    if (!kind || !harnessProvider(external)) {
      return false;
    }
    if (!deliverHandback) {
      throw new BadRequest('SubagentHandback is required for this harness continuation');
    }
    await answerHandbackOnly(exchange, external);
    return true;
  }
  async function dispatchGatewayMessage(
    exchange: ProviderRequest,
    followUp: string[] | undefined,
    external: string | null,
    deliverHandback: boolean,
    handbackKind: ReturnType<typeof handbackRequestKind>,
  ): Promise<void> {
    if (await answerHandbackRequest(exchange, handbackKind, deliverHandback, external)) {
      return;
    }
    if (followUp) {
      await answerFollowUp(exchange, followUp, external, deliverHandback);
      return;
    }
    await dispatch(exchange, exchange.identity, external);
  }
  /**
   * The deferred answer the rows' own reply holds, for the scope and provider that
   * wrote them only: from this gateway, or after a restart or an eviction from the
   * harness's durable record of that reply. Anything else is an explicit error.
   */
  async function pendingFollowUp(
    exchange: ProviderRequest,
    ids: readonly string[],
    provider: ReturnType<typeof providerRoute>,
  ) {
    const scope = harnessScope(exchange);
    const held = displayRows.followUp({ scope, provider }, ids);
    if (held) {
      return held;
    }
    const harness = harnessFor(provider);
    const recorded = await harness
      ?.recordedResponse?.(scope, followUpContext(exchange))
      .catch(() => undefined);
    const recovered = recordedFollowUp(recorded, ids);
    if (!recovered) {
      throw new FollowUpUnavailable(unavailableFollowUp);
    }
    return recovered;
  }
  /** The admitted context that locates a harness record; its default cwd without one. */
  function followUpContext({ identity, agentId, body }: ProviderRequest) {
    try {
      return permissionModes?.resolveHarness(identity.session, agentId, body.model);
    } catch {
      return undefined;
    }
  }
  /**
   * A hosted-API provider (OpenAI, Zen): the provider module prepares the request,
   * this owns keepalive, events, failure mapping and the reply.
   */
  async function handleHosted(exchange: ProviderRequest, route: 'openai' | 'zen') {
    const { res, body, url, signal, agentId, emit } = exchange;
    const prepared = prepareHosted(exchange, route);
    if (url.pathname === '/v1/messages/count_tokens') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-multi-token-count': 'estimate',
      });
      return res.end(JSON.stringify({ input_tokens: prepared.inputTokens() }));
    }
    onEvent(prepared.requestEvent(agentId));
    exchange.keepAlive();
    const upstream = await prepared.send(signal, fetchImpl);
    if (!upstream.ok) {
      // Do not print upstream bodies or credentials in gateway diagnostics.
      onEvent(prepared.failureEvent(upstream.status, agentId));
      await upstream.body?.cancel();
      throw new UpstreamFailure(
        upstream.status,
        upstream.headers.get('retry-after'),
        prepared.label,
        prepared.authHelp,
      );
    }
    if (!upstream.body) {
      throw new Error(`${prepared.label} returned no response stream.`);
    }
    exchange.startStream();
    const result = await prepared.translate(upstream.body, body.stream ? emit : undefined);
    rememberResult(exchange, result);
    if (result.stop_reason === 'stop_sequence') {
      exchange.abort.abort();
    }
    onEvent({
      ...completionEvent(exchange, result, prepared.route, prepared.endpoint),
      ...prepared.completion,
    });
    sendResult(exchange, result);
  }
  function prepareHosted(exchange: ProviderRequest, route: 'openai' | 'zen'): PreparedRequest {
    const { req, url, body, identity, agentId } = exchange;
    if (route === 'zen' && !zen?.apiKey) {
      throw new BadRequest(zenUnavailable);
    }
    const input = {
      method: req.method,
      pathname: url.pathname,
      body,
      session: identity.session,
      fallbackSession,
      clientSession: header(req.headers['x-claude-code-session-id']),
      agentId,
    };
    try {
      return zen?.apiKey && route === 'zen'
        ? prepareZenRequest(input, zen.apiKey)
        : prepareOpenAIRequest(input, String(body.model), authFile);
    } catch (error) {
      throw new BadRequest(reason(error));
    }
  }
  async function handleAnthropic(exchange: ProviderRequest) {
    const { req, res, body, url, raw, signal } = exchange;
    const headers = anthropicHeaders(req);
    const cleaned = forAnthropic(body, FOREIGN_SIGNATURE_PREFIXES);
    let forwarded: Buffer | undefined;
    if (req.method === 'POST') {
      forwarded = cleaned === body ? raw : Buffer.from(JSON.stringify(cleaned));
    }
    try {
      const upstream = await fetchImpl(anthropicUrl(url), {
        method: req.method ?? 'GET',
        headers,
        body: forwarded,
        signal,
        redirect: 'error',
      });
      onEvent({ route: 'anthropic', status: upstream.status, model: body.model });
      await relayAnthropic(
        upstream,
        res,
        signal,
        body.tools?.length ? exchange.remember : undefined,
        body.model,
      );
    } catch (error) {
      // Anthropic failures are not rebranded: Claude Code sees a dropped connection. The
      // reason still reaches the event stream, so a gateway bug is not silent.
      onEvent({ route: 'anthropic', model: body.model, diagnostic: reason(error) });
      res.destroy();
    }
  }
  async function relayAnthropic(
    upstream: Response,
    res: http.ServerResponse,
    signal: AbortSignal,
    remember?: (tool: { id: string; name: string; input: unknown }) => void,
    model?: unknown,
  ) {
    const responseHeaders = Object.fromEntries(upstream.headers);
    for (const name of STRIPPED_RESPONSE_HEADERS) {
      delete responseHeaders[name];
    }
    res.writeHead(upstream.status, responseHeaders);
    if (guardAuto && upstream.ok && remember) {
      await forwardObservedTools(upstream, res, remember, signal, (diagnostic) =>
        onEvent({ route: 'anthropic', model: String(model ?? ''), diagnostic }),
      );
    } else if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end();
    }
  }
  /** Any /v1 request the gateway does not route itself goes to Anthropic as raw bytes. */
  async function handleRawAnthropic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    abort: AbortController,
  ) {
    if (req.headers.origin) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (blockAnthropic) {
      throw new BadRequest('Anthropic is not signed in. Select an external model.');
    }
    const method = req.method ?? 'GET';
    const hasBody = requestHasBody(req);
    const headers = anthropicHeaders(req);
    if (hasBody && req.headers['content-length'] !== undefined) {
      headers['content-length'] = String(req.headers['content-length']);
    }
    try {
      const upstream = await fetchImpl(anthropicUrl(url), {
        method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
        duplex: hasBody ? 'half' : undefined,
        signal: providerSignal(abort.signal, null, timeoutMs),
        redirect: 'error',
      });
      onEvent({ route: 'anthropic', status: upstream.status, model: undefined });
      await relayAnthropic(upstream, res, abort.signal);
    } catch (error) {
      onEvent({ route: 'anthropic', path: url.pathname, diagnostic: reason(error) });
      res.destroy();
    }
  }
  /**
   * Claude reports its current mode with each pending action, which catches EnterPlanMode
   * and ExitPlanMode inside a turn. A worker also stays bound by a planning parent's
   * prompt snapshot. An unknown session or worker mode fails the review closed.
   */
  function withPlanMode(context: ApprovalContext | undefined) {
    if (!context) {
      return context;
    }
    const [session, worker] = JSON.parse(context.scope) as [string, string];
    const agent = worker === 'main' ? undefined : worker;
    let planMode = context.permissionMode === 'plan' || context.requestPermissionMode === 'plan';
    if (!planMode && permissionModes && (agent || context.permissionMode === undefined)) {
      planMode = permissionModes.planning(session, agent);
    }
    return planMode ? { ...context, planMode } : context;
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
  /**
   * Claude's own classifier (auto mode, for Claude's own actions) goes to Anthropic. It
   * leaves for provider review only when a provider-owned action observed in this session
   * positively matches: observing Claude's stream is best effort, so a missing match
   * proves nothing about who proposed the action.
   */
  function classifyUnobserved(
    exchange: ProviderRequest,
    metadata: ReturnType<typeof requestIdentity>,
  ) {
    // Without action observation there are no candidates to match: only a session whose
    // retained context is Claude's own may pass to Anthropic.
    const context = metadata.scope ? approvalContexts.get(metadata.scope) : undefined;
    if (context && !providerOwnedReview(context.model) && !blockAnthropic) {
      return handleAnthropic(exchange);
    }
    return dispatchReview(exchange, metadata, null);
  }
  /** The matching review candidates, or undefined when the request is Anthropic's own. */
  function readableCandidates(parsed: Record<string, unknown>, sourceSession: string) {
    try {
      return reviewCandidatesFor(parsed, sourceSession);
    } catch (error) {
      // An action the gateway cannot read cannot be matched, so it may be the provider
      // action waiting for review: it passes to Anthropic only when none is waiting.
      if (blockAnthropic) {
        throw error;
      }
      if (providerActionPending(sourceSession)) {
        throw new BadRequest('Unreadable review request while a provider action awaits review');
      }
      return undefined;
    }
  }
  async function dispatchNativeClassification(
    exchange: ProviderRequest,
    metadata: ReturnType<typeof requestIdentity>,
  ) {
    if (!guardAuto) {
      return classifyUnobserved(exchange, metadata);
    }
    const candidates = readableCandidates(exchange.parsed, metadata.session);
    if (!candidates) {
      return handleAnthropic(exchange);
    }
    if (!candidates.some(({ context }) => providerOwnedReview(context.model))) {
      if (blockAnthropic) {
        return dispatchReview(exchange, metadata, null);
      }
      return handleAnthropic(exchange);
    }
    // metadata.session picks the review candidates, so a header that disagrees with it
    // could steer a provider action's review to another session.
    if (metadata.mismatch) {
      throw new BadRequest('Session header and metadata disagree');
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
      return handleReview(exchange, withPlanMode(context));
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
    if (permissionModes && isHarnessProvider(route) && url.pathname === '/v1/messages') {
      try {
        permissionContext = permissionModes.resolveHarness(
          exchange.identity.session,
          agentId,
          body.model,
        );
        exchange.permissionContext = permissionContext;
      } catch (error) {
        throw refuseHarness(exchange, route, new BadRequest(reason(error)));
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
    if (isHarnessProvider(route)) {
      return handleHarness(exchange, route);
    }
    return handleHosted(exchange, route === 'zen' ? 'zen' : 'openai');
  }
  function handleMod(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    parsed: Record<string, unknown>,
  ) {
    if (!admitModRequest(req, res, parsed, modKeys)) {
      return undefined;
    }
    return handleModRoute(req, res, url, parsed, {
      bridge: modBridge,
      permissionModes,
      compactions,
      receipts,
      billedUsage,
      dashboard,
      rows: displayRows,
      keys: modKeys,
    });
  }
  return http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abort.abort();
      }
    });
    let sourceModel = '';
    let sourceSession = '';
    let sourceScope: string | undefined;
    const observer = new ToolObserver((tool) => remember(tool));
    const remember = (tool: { id: string; name: string; input: unknown }) => {
      if (!guardAuto || !sourceSession) {
        return;
      }
      const pending: PendingApprovalTool = {
        model: sourceModel,
        session: sourceSession,
        name: tool.name,
        input: tool.input,
        scope: sourceScope,
      };
      setBounded(pendingTools, tool.id, pending, 512, 'insertion');
      if (sourceScope) {
        const context = approvalContexts.get(sourceScope);
        if (context?.model === sourceModel) {
          setBounded(reviewCandidates, tool.id, { tool: pending, context }, 512, 'insertion');
        }
      }
    };
    const replies = new ReplyKeepAlive(res, (type) => emit(type, {}), jsonKeepAliveMs);
    const emit: Emit = (type, value) => {
      if (guardAuto) {
        observer.event({ type, ...value });
      }
      return res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    };
    try {
      assertLoopbackHost(req);
      const url = new URL(req.url ?? '', 'http://localhost');
      if (isRawAnthropicPath(url.pathname)) {
        return await handleRawAnthropic(req, res, url, abort);
      }
      if (!authorizeRequest(req, res, token, guardAuto)) {
        return;
      }
      const request = await readRequest(req);
      const { parsed } = request;
      if (url.pathname.startsWith('/multi/mod/')) {
        return handleMod(req, res, url, parsed);
      }
      const { body, raw, followUp, deliverHandback, handbackKind } = displayRowsRemoved(
        url,
        request,
      );
      const external = externalModel(body.model);
      assertProviderEnabled(external, enabledProviders);
      const signal = providerSignal(abort.signal, external, timeoutMs);
      const agentId = header(req.headers['x-claude-code-agent-id']);
      const metadata = requestIdentity(
        parsed,
        agentId,
        header(req.headers['x-claude-code-session-id']),
        external !== null,
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
        startStream: () => replies.startStream(body.stream),
        keepAlive: () => replies.keepAlive(body.stream),
      };
      if (url.pathname === '/multi/permission') {
        return sendPermissionDecision(exchange);
      }
      await dispatchGatewayMessage(exchange, followUp, external, deliverHandback, handbackKind);
    } catch (error) {
      abort.abort();
      failResponse(res, emit, error, replies.jsonStarted, sourceModel);
    } finally {
      replies.stop();
    }
  });
}

class RequestTooLarge extends Error {}

/**
 * What keeps a provider reply's connection alive while it works. A stream sends its
 * headers at once and a `ping` event every 15 s. Claude Code's request timeout only
 * bounds the wait for response headers, and a timed-out request is retried: a run that
 * is still working would then be started again. A non-streamed reply that is still
 * pending after a while therefore sends its headers and keeps the connection alive with
 * leading JSON whitespace, which any JSON parser skips before the message. Replies and
 * failures that come sooner keep their own status; after that point a failure can only
 * be an error body.
 */
class ReplyKeepAlive {
  jsonStarted = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly res: http.ServerResponse;
  private readonly ping: (type: 'ping') => void;
  private readonly delayMs: number;

  constructor(res: http.ServerResponse, ping: (type: 'ping') => void, delayMs: number) {
    this.res = res;
    this.ping = ping;
    this.delayMs = delayMs;
  }

  startStream(streamed: boolean | undefined) {
    if (this.timer) {
      return;
    }
    if (!streamed) {
      this.keepAlive(streamed);
      return;
    }
    this.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    this.res.flushHeaders();
    this.timer = setInterval(() => this.ping('ping'), 15000);
  }

  keepAlive(streamed: boolean | undefined) {
    if (this.timer || streamed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.jsonStarted = true;
      this.res.writeHead(200, { 'content-type': 'application/json' });
      this.res.flushHeaders();
      this.timer = setInterval(() => this.res.write(' '), Math.min(15000, this.delayMs));
    }, this.delayMs);
  }

  stop() {
    clearInterval(this.timer);
  }
}

/**
 * The gateway token alone does not authorize a mod request that changes a session: the
 * token is in the environment of Claude's own tools. See mod-keys.ts.
 */
function admitModRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: Record<string, unknown>,
  keys: ModSessionKeys,
) {
  if (req.method !== 'POST' || typeof parsed.sessionId !== 'string' || !parsed.sessionId) {
    return true;
  }
  const verdict = keys.check(parsed.sessionId, header(req.headers[MOD_KEY_HEADER]));
  if (verdict.refused) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Mod session key required' }));
    return false;
  }
  if (verdict.issue) {
    res.setHeader(MOD_KEY_HEADER, verdict.issue);
  }
  return true;
}

/**
 * Everything except the Messages API the gateway parses and may route, and its own
 * /multi/* control routes, goes to Anthropic as raw bytes with the caller's headers.
 */
function isRawAnthropicPath(pathName: string) {
  return (
    !pathName.startsWith('/multi/') &&
    !['/v1/messages', '/v1/messages/count_tokens'].includes(pathName)
  );
}

/**
 * Only the gateway's own loopback name and port are accepted as the `Host`. A web page
 * that rebinds its DNS name to 127.0.0.1 reaches the port with its own name in `Host`,
 * which is what keeps it from using the unauthenticated raw passthrough as a relay.
 */
function assertLoopbackHost(req: http.IncomingMessage) {
  const host = req.headers.host?.toLowerCase();
  const port = req.socket.localPort;
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!host || !allowed.includes(host)) {
    throw new ForbiddenHost('Forbidden host');
  }
}

/** A request body is present when the client declared one, whatever the method. */
function requestHasBody(req: http.IncomingMessage) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return false;
  }
  return (
    req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0
  );
}

/** The origin and path prefix Claude's traffic is forwarded to, without a trailing slash. */
function parseAnthropicBase(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The Anthropic base URL must be http or https');
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

/**
 * Display rows are Claude Code UI: no provider sees them as tools or history. A
 * request that only answers a reply's rows is marked as that reply's follow-up.
 */
function displayRowsRemoved(
  url: URL,
  request: { raw: Buffer; parsed: Record<string, unknown>; body: MessagesRequest },
) {
  if (isApprovalRequest(request.parsed)) {
    return {
      body: request.body,
      raw: request.raw,
      followUp: undefined,
      deliverHandback: false,
      handbackKind: undefined,
    };
  }
  const harness = harnessProvider(externalModel(request.body.model));
  const deliverHandback = Boolean(harness && handbackOffered(request.body));
  const handbackKind = harness ? handbackRequestKind(request.body) : undefined;
  const followUp = url.pathname === '/v1/messages' ? displayFollowUp(request.body) : undefined;
  const withoutRows = withoutDisplayTools(request.body);
  const body = harness ? withoutHarnessHandback(withoutRows) : withoutRows;
  const raw = body === request.body ? request.raw : Buffer.from(JSON.stringify(body));
  return { body, raw, followUp, deliverHandback, handbackKind };
}

function emitTerminal(emit: Emit, response: MessagesResponse): void {
  emit('message_delta', {
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
      ...(response.safeguard_results === undefined
        ? {}
        : { safeguard_results: response.safeguard_results }),
    },
    usage: response.usage,
  });
  emit('message_stop', {});
}

function harnessStreamEmitter(emit: Emit, deliverHandback: boolean): Emit {
  return (type, value) => {
    // The native reply is durable before its terminal event. Hold that event
    // until the gateway has appended Claude's delivery call to the final message.
    if (deliverHandback && (type === 'message_delta' || type === 'message_stop')) {
      return;
    }
    emit(type, value);
  };
}

function finishHarnessDelivery(
  nativeResult: MessagesResponse,
  deliverHandback: boolean,
  body: MessagesRequest,
  emit: Emit,
): MessagesResponse {
  if (!deliverHandback) {
    return nativeResult;
  }
  const result =
    nativeResult.multi_followup === undefined
      ? withHandback(nativeResult, recordedReport(nativeResult) ?? '', body.safeguards)
      : nativeResult;
  if (body.stream) {
    if (result !== nativeResult) {
      emitHandback(emit, result);
    }
    emitTerminal(emit, result);
  }
  return result;
}

function providerSignal(disconnected: AbortSignal, model: string | null, timeoutMs?: number) {
  // Native harness runs follow the client connection rather than an HTTP deadline.
  if (harnessProvider(model)) {
    return disconnected;
  }
  // Streamed OpenAI, Zen and Claude responses (including server-side advisor calls)
  // can outlive any fixed wall-clock deadline; only an explicit limit bounds them.
  if (timeoutMs === undefined) {
    return disconnected;
  }
  return AbortSignal.any([disconnected, AbortSignal.timeout(timeoutMs)]);
}

async function readRequest(req: http.IncomingMessage) {
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
  return { raw, parsed, body: parsed as MessagesRequest };
}

function errorStatus(error: unknown): number {
  if (error instanceof ProviderAuthError) {
    return 401;
  }
  if (error instanceof BadRequest) {
    return 400;
  }
  if (error instanceof FollowUpRefused || error instanceof ForbiddenHost) {
    return 403;
  }
  if (error instanceof FollowUpUnavailable) {
    return 404;
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
  if (!exchange.body.stream && !exchange.res.headersSent) {
    exchange.res.writeHead(200, { 'content-type': 'application/json' });
  }
  exchange.res.end(exchange.body.stream ? undefined : JSON.stringify(result));
}

/** Claude's PreToolUse input carries its mode at the moment the action was proposed. */
function reportedMode(parsed: Record<string, unknown>): { permissionMode?: string } {
  return typeof parsed.permission_mode === 'string'
    ? { permissionMode: parsed.permission_mode }
    : {};
}

function requestIdentity(
  parsed: Record<string, unknown>,
  agentId?: string,
  sessionHeader?: string,
  provider = true,
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
  // Session identity matters to provider routes and to classifier requests that go to
  // provider review (checked at dispatch). A Claude passthrough request is never refused
  // for it: Anthropic owns that request.
  const mismatch = Boolean(session && sessionHeader && session !== sessionHeader);
  if (provider && mismatch) {
    throw new BadRequest('Session header and metadata disagree');
  }
  session = session || sessionHeader || '';
  const identity = session || rawIdentity;
  return {
    identity,
    session,
    mismatch,
    scope: identity ? JSON.stringify([identity, agentId ?? 'main']) : undefined,
  };
}

function anthropicHeaders(req: http.IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const single = header(value);
    if (single !== undefined && !STRIPPED_REQUEST_HEADERS.includes(name)) {
      headers[name] = single;
    }
  }
  headers['accept-encoding'] = decodableEncodings(req.headers['accept-encoding']);
  return headers;
}

/**
 * Node's fetch decodes gzip, deflate and br before the gateway sees a byte, so the
 * observer and the relay always handle decoded bytes (the relay drops content-encoding
 * and content-length). Keep the client's own preference for those, so Anthropic
 * compresses as it would for Claude Code directly; anything else asks for identity.
 */
function decodableEncodings(value: string | string[] | undefined) {
  const wanted = (header(value) ?? '')
    .split(',')
    .map((entry) => entry.trim().split(';')[0].toLowerCase())
    .filter((entry) => ['gzip', 'deflate', 'br'].includes(entry));
  return wanted.length ? wanted.join(', ') : 'identity';
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
      '/multi/mod/session',
      '/multi/mod/worker',
      '/multi/mod/worker-model',
      '/multi/mod/mode',
      '/multi/mod/policy',
      '/multi/mod/offer',
      '/multi/mod/telemetry',
      '/multi/mod/lifecycle',
      '/multi/mod/display',
      '/multi/mod/display-tools',
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

function failResponse(
  res: http.ServerResponse,
  emit: Emit,
  error: unknown,
  jsonKeepAlive: boolean,
  model = '',
) {
  if (res.destroyed) {
    return;
  }
  const status = errorStatus(error);
  if (error instanceof RequestTooLarge) {
    // Anthropic's own 413 body, so Claude Code reads it as it would natively.
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'request_too_large',
          message: 'Request exceeds the maximum allowed number of bytes.',
        },
      }),
    );
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
  if (res.headersSent && jsonKeepAlive) {
    // The 200 and its headers are already out, so the failure has to be a valid message
    // for Claude Code to show; an error body under a 200 is read as a malformed reply.
    res.end(JSON.stringify(failureMessage(error, model)));
  } else if (res.headersSent) {
    emit('error', { error: failure.error });
    res.end();
  } else {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failure));
  }
}

/** The failure as an ordinary assistant message: it states the failure and claims no work. */
export function failureMessage(error: unknown, model: string): MessagesResponse {
  const provider = providerRoute(model);
  const detail = reason(error).replace(/\s+/g, ' ').trim().slice(0, 500);
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: `Multi: ${provider} failed: ${detail}` }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
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
