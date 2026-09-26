import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { LivePlan } from './live.ts';
import type { TtyDriver } from './tty.ts';

export type JsonObject = Record<string, unknown>;
export type Provider = 'anthropic' | 'openai' | 'zen';
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
export interface UpstreamRequest {
  provider: Provider;
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: JsonObject;
  aborted: boolean;
}
export interface Reply {
  text?: string;
  tool?: { name: string; input: JsonObject; id?: string };
  delayMs?: number;
  status?: number;
  json?: unknown;
}
export type UpstreamScript = (request: UpstreamRequest, index: number) => Reply | Promise<Reply>;
export interface NativeInvocation {
  name: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}
export interface NativeReply {
  stdout?: string;
  stderr?: string;
  code?: number;
}
export type NativeScript = (
  request: NativeInvocation,
  index: number,
) => NativeReply | Promise<NativeReply>;
export interface Scenario {
  name: string;
  model?: string;
  prompt?: string;
  permissionMode?: PermissionMode;
  cliArgs?: string[];
  fixtures?: Record<string, string>;
  upstream?: Partial<Record<Provider, UpstreamScript>>;
  native?: Partial<Record<'agy' | 'grok' | 'codex', NativeScript>>;
  /** An absolute fixture module exporting Cursor; only the launcher loader sees it. */
  cursorModule?: string;
  enabledProviders?: string[];
  gatewayTimeoutMs?: number;
  timeoutMs?: number;
  direct?: boolean;
  driver?: { kind: 'tty'; run(driver: TtyDriver): Promise<void> };
  /** Allowlisted additional dummy child environment, never inherited credentials. */
  env?: Record<string, string>;
  /** Live variants are bounded and skipped individually when credentials are absent. */
  tier?: 'hermetic' | 'live';
  live?: LivePlan;
}
export interface FakeServer {
  url: string;
  requests: UpstreamRequest[];
  nativeInvocations: NativeInvocation[];
  errors: string[];
  close(): Promise<void>;
}
export type ReplyWriter = (
  response: ServerResponse,
  request: UpstreamRequest,
  reply: Reply,
) => Promise<void>;
