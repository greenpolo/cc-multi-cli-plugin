import type { MessagesRequest } from '../../multi-core/src/gateway/messages.ts';
import type { ReviewInput } from '../../multi-core/src/gateway/verdicts.ts';

const requestBudget = 768 * 1024;
const actionBudget = 128 * 1024;
const messageBudget = 64 * 1024;

/** Bound cost without refusing long sessions; omissions are explicit evidence gaps. */
export function reviewEvidence(cwd: string, context: ReviewInput) {
  if (context.worker && !context.rootRequest) {
    throw new Error('Worker review is missing root authorization context');
  }
  const reviewCwd = context.cwd ?? cwd;
  const perRequest = context.worker ? requestBudget / 2 : requestBudget;
  const evidence = JSON.stringify({
    planned_action: boundedValue({ [context.tool.name]: context.tool.input }, actionBudget),
    original_request: requestEvidence(context.request, perRequest),
    root_request:
      context.worker && context.rootRequest
        ? requestEvidence(context.rootRequest, perRequest)
        : undefined,
    cwd: reviewCwd.slice(0, 4096),
  });
  return { reviewCwd, evidence };
}

function requestEvidence(request: MessagesRequest, budget: number) {
  // Schemas and wire settings add cost, not authorization. Preserve roles and history.
  const system = boundedValue(request.system, 16 * 1024, true);
  const model = request.model?.slice(0, 256);
  const messages: unknown[] = [];
  let remaining = budget - bytes({ system, model, messages }) - 128;
  const history = request.messages ?? [];
  for (let index = history.length - 1; index >= 0 && remaining >= 512; index--) {
    const message = history[index];
    const role = message.role.slice(0, 64);
    const content = boundedValue(message.content, Math.min(messageBudget, remaining - 128));
    const candidate = { role, content };
    remaining -= bytes(candidate) + 1;
    messages.push(candidate);
  }
  return {
    model,
    system,
    messages: messages.reverse(),
    ...(messages.length === history.length
      ? {}
      : { omitted_messages: history.length - messages.length }),
  };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null');
}

function boundedValue(value: unknown, budget: number, headOnly = false): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) <= budget) {
    return value;
  }
  // A UTF-16 unit uses at most six bytes when JSON-escaped, even for lone surrogates.
  const units = Math.max(0, Math.floor((budget - 128) / 6));
  const head = headOnly ? units : Math.floor(units / 3);
  return {
    truncated: true,
    original_bytes: Buffer.byteLength(encoded),
    json_head: encoded.slice(0, head),
    ...(headOnly ? {} : { json_tail: encoded.slice(-(units - head)) }),
  };
}
