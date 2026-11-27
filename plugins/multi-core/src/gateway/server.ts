import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  anthropicHeaders,
  DEFAULT_ANTHROPIC_URL,
  isRawAnthropicPath,
  parseAnthropicBase,
  STRIPPED_RESPONSE_HEADERS,
} from './anthropic.ts';
import {
  DisplayRows,
  FollowUpUnavailable,
  followUpFallback,
  isDisplayTool,
  recordedFollowUp,
  unavailableFollowUp,
} from './display-rows.ts';
import type { GatewayFetch } from './fetch.ts';
import { viaFrontDoor } from './front-door.ts';
import {
  emitHandback,
  handbackOffered,
  type handbackRequestKind,
  recordedReport,
  withHandback,
} from './harness-handback.ts';
import type { NativeObservation } from './harness-progress.ts';
import type {
  MessagesRequest,
  MessagesResponse,
  ServedReply,
  StopReason,
  TerminalEmit,
} from './messages.ts';
import { ModBridge } from './mod-bridge.ts';
import { ModSessionKeys } from './mod-keys.ts';
import { handleModRoute } from './mod-routes.ts';
import type { PermissionContext, PermissionModes } from './mode-hook.ts';
import type { NativeHarness } from './native-harness.ts';
import { harnessProvider, isHarnessProvider, providerManifest, providerOf } from './provider.ts';
import type { ConnectedProvider } from './provider-adapter.ts';
import type { PreparedRequest } from './provider-request.ts';
import { UpstreamFailure } from './provider-request.ts';
import { ProviderUsageDashboard } from './provider-usage.ts';
import { ReceiptLedger } from './receipts.ts';
import {
  displayRowsRemoved,
  emitTerminal,
  explainUpstreamFailure,
  failResponse,
  failureMessage,
  finishHarnessDelivery,
  ReplyKeepAlive,
  sendResult,
} from './reply.ts';
import {
  admitModRequest,
  assertLoopbackHost,
  assertProviderEnabled,
  assertStatelessRequest,
  authorizeRequest,
  BadRequest,
  carriesGatewayToken,
  externalModel,
  header,
  type ProviderRequest,
  providerSignal,
  readRequest,
  reason,
  requestHasBody,
  requestIdentity,
  routeOf,
  unavailable,
  validateHarness,
} from './request.ts';
import { forAnthropic } from './responses.ts';
import { verdictsFor } from './verdicts.ts';
import {
  stripWorkerJson,
  stripWorkerModel,
  stripWorkerSse,
  WorkerModels,
} from './worker-models.ts';

/** What the gateway reports to `onEvent`; routing only, never credentials or bodies. */
export interface GatewayEvent {
  /** `anthropic`, a provider's name, or a provider's own request route. */
  route: string;
  model?: string;
  agentId?: string | null;
  path?: string;
  effort?: string;
  status?: number;
  stopReason?: StopReason | null;
  tools?: string[];
  tool?: string;
  outcome?: 'allow' | 'deny';
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
  token: string;
  /** How long a non-streamed provider reply may stay silent before its headers go out. */
  jsonKeepAliveMs?: number;
  /** Where Claude's own traffic goes: Anthropic by default, or the caller's own base URL. */
  anthropicBaseUrl?: string;
  enabledProviders?: readonly string[];
  fetchImpl?: GatewayFetch;
  onEvent?: (event: GatewayEvent) => void;
  timeoutMs?: number;
  /** The providers connected in this session, by name: what runs and meters each. */
  providers?: Readonly<Record<string, GatewayProvider>>;
  /** Reasoning-signature prefixes providers write; they mean nothing to Anthropic and are stripped. */
  signaturePrefixes?: readonly string[];
  /** No Anthropic credentials: block Anthropic passthrough. */
  blockAnthropic?: boolean;
  permissionModes?: PermissionModes;
  modBridge?: ModBridge;
  /** Display rows for native harness actions. */
  displayRows?: DisplayRows;
  /** A gateway its mod started (serve.ts) ends when the mod asks: `/multi/mod/stop`. */
  onStop?: () => void;
}

/** What the gateway uses of a connected provider. */
type GatewayProvider = Pick<
  ConnectedProvider,
  'harness' | 'displayTools' | 'prepare' | 'usage' | 'billed'
> & { harness?: NativeHarness };

export function createNativeGateway({
  token,
  anthropicBaseUrl = DEFAULT_ANTHROPIC_URL,
  jsonKeepAliveMs = 30000,
  enabledProviders,
  fetchImpl = fetch,
  onEvent: observer = () => {},
  timeoutMs,
  providers = {},
  signaturePrefixes = [],
  blockAnthropic,
  permissionModes,
  modBridge = new ModBridge(),
  displayRows = new DisplayRows(),
  receipts = new ReceiptLedger(),
  usageDashboard,
  onStop,
}: GatewayOptions): Server {
  const dashboard =
    usageDashboard ??
    new ProviderUsageDashboard({
      enabled: Object.keys(providers).filter(
        (provider) => !enabledProviders || enabledProviders.includes(provider),
      ),
      readers: Object.fromEntries(
        Object.entries(providers).map(([provider, { usage }]) => [provider, usage]),
      ),
    });
  const billed = Object.values(providers).find((provider) => provider.billed)?.billed;
  const onEvent = (event: GatewayEvent) => {
    receipts.observe(event);
    observer(event);
  };
  if (!token) {
    throw new Error('Gateway token required');
  }
  const anthropicOrigin = parseAnthropicBase(anthropicBaseUrl);
  const anthropicUrl = (url: URL) => anthropicOrigin + url.pathname + url.search;
  const modKeys = new ModSessionKeys();
  const workerModels = new WorkerModels();
  const fallbackSession = randomUUID();
  const harnessFor = (provider: string | undefined) =>
    provider !== undefined && isHarnessProvider(provider)
      ? providers[provider]?.harness
      : undefined;
  // Offer the mod rows only for the harnesses this gateway runs.
  for (const { harness, displayTools } of Object.values(providers)) {
    if (harness && displayTools) {
      displayRows.announce(displayTools);
    }
  }

  async function serveReply(exchange: ProviderRequest, reply: MessagesResponse) {
    for (const block of reply.content) {
      stripWorkerModel(block, workerModels.remember(exchange.identity.session));
    }
    const provider = providerOf(exchange.body.model);
    if (provider === undefined) {
      throw new Error('Cannot finalise an upstream reply');
    }
    const safeguard_results = verdictsFor(exchange.body, reply);
    const served = {
      ...reply,
      ...(safeguard_results === undefined ? {} : { safeguard_results }),
    } as ServedReply;
    if (exchange.body.stream) {
      emitTerminal(exchange.emit, served);
    }
    sendResult(exchange, served);
  }
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
  async function handleHarness(exchange: ProviderRequest, provider: string) {
    const { res, body, url, signal, agentId, emit, identity } = exchange;
    const bridge = harnessFor(provider);
    if (!bridge) {
      throw refuseHarness(exchange, provider, new BadRequest(unavailable(provider)));
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
    const nativeResult = await bridge
      .handle(
        body,
        scope,
        signal,
        body.stream ? emit : undefined,
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
    onEvent(
      completionEvent(exchange, result, provider, providerManifest(provider)?.endpoint ?? provider),
    );
    await serveReply(exchange, result);
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
    const followUp = await pendingFollowUp(exchange, ids, routeOf(external));
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
    const result = deliverHandback ? withHandback(plain, text) : plain;
    if (body.stream) {
      exchange.startStream();
      emit('message_start', { message: { ...result, content: [], stop_reason: null } });
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
      emit('content_block_stop', { index: 0 });
      if (deliverHandback) {
        emitHandback(emit, result);
      }
    }
    await serveReply(exchange, result);
  }
  async function answerHandbackOnly(exchange: ProviderRequest, external: string | null) {
    const harness = harnessFor(providerOf(external));
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
    const result = withHandback(plain, report);
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
    }
    await serveReply(exchange, result);
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
    await dispatch(exchange, external);
  }
  /**
   * The deferred answer the rows' own reply holds, for the scope and provider that
   * wrote them only: from this gateway, or after a restart or an eviction from the
   * harness's durable record of that reply. Anything else is an explicit error.
   */
  async function pendingFollowUp(
    exchange: ProviderRequest,
    ids: readonly string[],
    provider: string,
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
   * A hosted-API provider: the provider's adapter prepares the request,
   * this owns keepalive, events, failure mapping and the reply.
   */
  async function handleHosted(exchange: ProviderRequest, route: string) {
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
    const upstreamAbort = new AbortController();
    const upstream = await prepared.send(
      AbortSignal.any([signal, upstreamAbort.signal]),
      fetchImpl,
    );
    if (!upstream.ok) {
      // Do not print upstream bodies or credentials in gateway diagnostics.
      onEvent(prepared.failureEvent(upstream.status, agentId));
      throw new UpstreamFailure(
        upstream.status,
        upstream.headers.get('retry-after'),
        prepared.label,
        prepared.authHelp,
        await explainUpstreamFailure(prepared, upstream),
      );
    }
    if (!upstream.body) {
      throw new Error(`${prepared.label} returned no response stream.`);
    }
    exchange.startStream();
    const result = await prepared.translate(
      upstream.body,
      body.stream ? emit : undefined,
      workerModels.remember(exchange.identity.session),
    );
    if (result.stop_reason === 'stop_sequence') {
      upstreamAbort.abort();
    }
    onEvent({
      ...completionEvent(exchange, result, prepared.route, prepared.endpoint),
      ...prepared.completion,
    });
    await serveReply(exchange, result);
  }
  function prepareHosted(exchange: ProviderRequest, route: string): PreparedRequest {
    const { req, url, body, identity, agentId } = exchange;
    const prepare = providers[route]?.prepare;
    if (!prepare) {
      throw new BadRequest(unavailable(route));
    }
    try {
      return prepare(
        {
          method: req.method,
          pathname: url.pathname,
          body,
          session: identity.session,
          fallbackSession,
          clientSession: header(req.headers['x-claude-code-session-id']),
          agentId,
        },
        String(body.model),
      );
    } catch (error) {
      throw new BadRequest(reason(error));
    }
  }
  async function handleAnthropic(exchange: ProviderRequest) {
    const { req, res, body, url, raw, signal } = exchange;
    const headers = anthropicHeaders(req);
    const cleaned = forAnthropic(body, signaturePrefixes);
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
      await relayAnthropic(upstream, res, exchange);
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
    exchange?: ProviderRequest,
  ) {
    const responseHeaders = Object.fromEntries(upstream.headers);
    for (const name of STRIPPED_RESPONSE_HEADERS) {
      delete responseHeaders[name];
    }
    const normalize = upstream.status === 200 && exchange?.url.pathname === '/v1/messages';
    const contentType = upstream.headers.get('content-type') ?? '';
    const remember = workerModels.remember(exchange?.identity.session ?? '');
    if (normalize && contentType.includes('application/json')) {
      const raw = Buffer.from(await upstream.arrayBuffer());
      const body = stripWorkerJson(raw, remember);
      responseHeaders['content-length'] = String(body.length);
      res.writeHead(upstream.status, responseHeaders);
      res.end(body);
      return;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }
    const source = Readable.fromWeb(upstream.body);
    if (normalize && contentType.includes('text/event-stream')) {
      await pipeline(Readable.from(stripWorkerSse(source, remember)), res);
    } else {
      await pipeline(source, res);
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
      await relayAnthropic(upstream, res);
    } catch (error) {
      onEvent({ route: 'anthropic', path: url.pathname, diagnostic: reason(error) });
      res.destroy();
    }
  }
  async function dispatch(exchange: ProviderRequest, external: string | null) {
    if (!external && blockAnthropic) {
      throw new BadRequest('Anthropic is not signed in. Select an external model.');
    }
    return forwardProvider(exchange, external);
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
    const route = routeOf(external);
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
    return handleHosted(exchange, route);
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
      workerModels,
      forgetSession: (session) => workerModels.forgetSession(session),
      permissionModes,
      receipts,
      billed,
      dashboard,
      rows: displayRows,
      keys: modKeys,
      stop: onStop,
    });
  }
  async function serveFailure(
    exchange: ProviderRequest | undefined,
    error: unknown,
    jsonStarted: boolean,
    res: http.ServerResponse,
    emit: TerminalEmit,
    model: string,
  ) {
    try {
      if (res.destroyed) {
        return;
      }
      if (jsonStarted && exchange) {
        await serveReply(exchange, failureMessage(error, model));
      } else {
        failResponse(res, emit, error);
      }
    } catch {
      // A broken failure delivery cannot be reported through the same transport.
      // Drop it without a second reply or an unhandled request-listener rejection.
      res.destroy();
    }
  }
  return http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abort.abort();
      }
    });
    let sourceModel = '';
    let exchange: ProviderRequest | undefined;
    const replies = new ReplyKeepAlive(res, (type) => emit(type, {}), jsonKeepAliveMs);
    const emit: TerminalEmit = (type, value) => {
      return res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    };
    try {
      assertLoopbackHost(req);
      const url = new URL(req.url ?? '', 'http://localhost');
      // Through the front door, only Claude Code's own requests carry the token; anything
      // else that inherited the proxy settings goes to Anthropic untouched.
      if (
        isRawAnthropicPath(url.pathname) ||
        (viaFrontDoor(req) && !carriesGatewayToken(req, token))
      ) {
        return await handleRawAnthropic(req, res, url, abort);
      }
      if (!authorizeRequest(req, res, token)) {
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
      assertStatelessRequest(parsed, external);
      const signal = providerSignal(abort.signal, external, timeoutMs);
      const agentId = header(req.headers['x-claude-code-agent-id']);
      const metadata = requestIdentity(
        parsed,
        agentId,
        header(req.headers['x-claude-code-session-id']),
        external !== null,
      );
      sourceModel = String(body.model ?? '');
      exchange = {
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
        startStream: () => replies.startStream(body.stream),
        keepAlive: () => replies.keepAlive(body.stream),
      };
      await dispatchGatewayMessage(exchange, followUp, external, deliverHandback, handbackKind);
    } catch (error) {
      abort.abort();
      await serveFailure(exchange, error, replies.jsonStarted, res, emit, sourceModel);
    } finally {
      replies.stop();
    }
  });
}
