import { createHash } from 'node:crypto';
import type { HarnessResponse } from './harness-response.ts';
import type {
  ContentBlock,
  MessagesRequest,
  MessagesResponse,
  RequestMessage,
} from './messages.ts';

const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export function interruptedNotice(tag: string): string {
  return `[${tag}] The previous turn was interrupted. Report its state and do not repeat completed actions.`;
}

/**
 * The notices that open a native turn: the policy in force, an unfinished
 * previous turn, and an outer history that no longer contains the last answer.
 * `notice` is optional because not every provider announces its policy.
 */
export function writeNotices(
  response: HarnessResponse,
  args: {
    tag: string;
    interrupted: boolean;
    rewound: boolean;
    notice?: string;
    noticeChanged: boolean;
  },
): void {
  if (args.notice !== undefined && args.noticeChanged) {
    response.text(`[${args.tag}] ${args.notice}\n`);
  }
  if (args.interrupted) {
    response.text(`${interruptedNotice(args.tag)}\n`);
  }
  if (args.rewound) {
    response.text(
      `[${args.tag}] Outer history changed; the native conversation continues with its own record.\n`,
    );
  }
}

/** Diagnostics keep no credentials and no terminal control bytes. */
export function safeText(value: string): string {
  return (
    value
      .replace(/bearer\s+[^\s]+/gi, 'Bearer [redacted]')
      .replace(/((?:api[_-]?key|token|password|secret)[=:])[^\s,;]+/gi, '$1[redacted]')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: diagnostics must remove terminal control bytes.
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500)
  );
}

/** The native run's own warnings, filtered out of its stderr. */
export function stderrDiagnostics(stderr: string): string {
  const diagnostics = stderr
    .split(/\r?\n/)
    .filter((line) => /warn|error|denied|permission|fail/i.test(line))
    .join('\n');
  return diagnostics.trim() ? safeText(diagnostics) : '';
}

/**
 * The newest turn: everything after the last assistant message. The native session
 * already holds everything before it, so only the delta is sent on resume.
 */
export function continuation(body: MessagesRequest): RequestMessage[] {
  const messages = body.messages ?? [];
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  if (lastAssistant === messages.length - 1) {
    throw new Error('Native continuation requires a message after the last assistant turn');
  }
  const delta = messages.slice(lastAssistant + 1);
  if (!delta.some((message) => message.role === 'user')) {
    throw new Error('Native continuation requires a new user message');
  }
  return delta;
}

/** True when the outer history no longer contains the previous turn's response. */
export function historyRewound(
  session: { response?: MessagesResponse },
  messages: RequestMessage[],
  historyHash: (messages: MessagesRequest['messages']) => string,
): boolean {
  const response = session.response;
  if (!response) {
    return false;
  }
  const expected = historyHash([{ role: 'assistant', content: response.content }]);
  return !messages.some(
    (message) => message.role === 'assistant' && historyHash([message]) === expected,
  );
}

/**
 * Cache markers are transport metadata; moving them must not fork native history.
 * With `stripReminders`, identity follows the prompt actually typed, so a retry
 * carrying only a fresh system reminder is the same request and never reruns.
 */
export function harnessHistoryHash(
  messages: MessagesRequest['messages'],
  options: { stripReminders?: boolean } = {},
): string {
  const normalize = (content: unknown): unknown =>
    Array.isArray(content)
      ? content.map((block) => {
          if (!block || typeof block !== 'object') {
            return block;
          }
          const { cache_control: _cache, ...rest } = block as ContentBlock;
          if (options.stripReminders && rest.type === 'text' && typeof rest.text === 'string') {
            return { ...rest, text: rest.text.replace(SYSTEM_REMINDER, '') };
          }
          return rest.type === 'tool_result' ? { ...rest, content: normalize(rest.content) } : rest;
        })
      : content;
  return hash(messages?.map((message) => ({ ...message, content: normalize(message.content) })));
}

/** The part of a terminal answer the stream did not already deliver. */
export function terminalSuffix(streamed: string, terminal: string): string {
  if (streamed && terminal.startsWith(streamed)) {
    return terminal.slice(streamed.length);
  }
  if (streamed.endsWith(terminal)) {
    return '';
  }
  return terminal;
}
