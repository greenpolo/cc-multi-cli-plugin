import type { EngineInterface, Register } from 'claude-code';
import { register as registerCompaction } from './compact.ts';
import { register as registerLifecycle } from './lifecycle.ts';
import { type PolicyClient, type PolicyState, recordPrompt } from './policy.ts';
import { isHarnessModel } from './provider.ts';
import { register as registerUsage } from './usage.ts';
import { register as registerWorkers } from './workers.ts';

const displayTools = [
  ['read', 'Display-only Cursor file read.'],
  ['search', 'Display-only Cursor search.'],
  ['edit', 'Display-only Cursor edit.'],
  ['shell', 'Display-only Cursor shell action.'],
  ['other', 'Display-only Cursor action.'],
  ['note', 'Display-only Cursor progress note.'],
] as const;
const prefix = 'mcp__multi-core__cursor_';
const maxBody = 32000;

type DisplayInput = {
  description?: string;
  toolUseId?: string;
  output?: string;
  isError?: boolean;
};

type GatewayResponse = {
  refused?: true;
  httpStatus?: number;
  error?: string;
  output?: string;
  isError?: boolean;
  terminal?: boolean;
  accepted?: boolean;
  generation?: number | string;
  status?: string;
  stale?: boolean;
  events?: Array<{
    sequence: number;
    toolUseId: string;
    tool: string;
    phase: string;
    input: DisplayInput;
    output?: string;
    isError?: boolean;
  }>;
  nextCursor?: number;
};

// Claude Code 2.1.272 loads exactly one entry from hooks.json `modules`; compose here.
export const register: Register = (on, options) => {
  const policyState: PolicyState = {};
  registerUsage(on, options);
  // Detaching makes the gateway forget this session's mode; keeping its generation
  // here would leave every later prompt stale against a gateway holding nothing.
  const agentModels = new Map<string, string>();
  const spawnModels = new Map<string, string>();
  registerLifecycle(
    on,
    options,
    () => {
      policyState.generation = undefined;
      policyState.prompt = undefined;
      policyState.harnessReady = false;
      policyState.preparing = undefined;
    },
    agentModels,
    spawnModels,
  );
  registerCompaction(on, options, agentModels);
  registerWorkers(on, options, agentModels, policyState, spawnModels);
  for (const [name, _description] of displayTools) {
    const tool = `${prefix}${name}` as const;
    on('tool.call', { tool }, async (_$, event) => {
      // The tool's own arguments sit beside the reserved keys on the envelope.
      const input = event as unknown as DisplayInput;
      return {
        result: {
          type: 'text',
          text: input.output ?? 'Display result unavailable.',
          is_error: input.isError === true,
        },
      };
    });
    on('tool.check', { tool }, () => ({
      decision: 'allow' as const,
      reason: 'Display-only row; it never executes a Cursor action.',
    }));
    on('ui.render', { component: 'ToolUse', props: { tool } }, async ($, event, next) => {
      const { Box, Text } = $.ui.resolve(event);
      const input = event.props.input as DisplayInput;
      const row = await next(event);
      return Box({
        flexDirection: 'column',
        children: [
          Text({ color: 'cyan', children: `Cursor ${name}: ${input.description ?? ''}` }),
          row,
        ],
      });
    });
    on('ui.render', { component: 'ToolResult', props: { tool } }, async ($, event, next) => {
      const { Box, Text } = $.ui.resolve(event);
      const row = await next(event);
      return Box({
        flexDirection: 'column',
        children: [Text({ color: 'cyan', children: `Cursor ${name} complete` }), row],
      });
    });
  }
  on('session.start', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    await $.command.register({
      name: 'multi-usage',
      description: 'Open provider quotas, spend, and session receipts.',
      immediate: true,
    });
    const cursorAvailable = (await $.env.get('MULTI_CURSOR_DISPLAY_TOOLS')) === '1';
    for (const [name, description] of cursorAvailable ? displayTools : []) {
      try {
        await $.tool.register({
          name: `cursor_${name}`,
          description,
          inputSchema: {
            type: 'object',
            properties: {
              description: { type: 'string', maxLength: 160 },
              output: { type: 'string', maxLength: 4096 },
              isError: { type: 'boolean' },
              toolUseId: { type: 'string', maxLength: 512 },
            },
            required: ['description', 'output', 'isError', 'toolUseId'],
            additionalProperties: false,
          },
        });
      } catch {
        // Toolless slash-command sessions still need the gateway lifecycle hooks.
      }
    }
    const response = await request($, '/multi/mod/session', {
      sessionId: await $.session.id(),
      cwd: await $.session.cwd(),
      model: await $.session.model(),
      event: 'start',
    });
    policyState.generation =
      typeof response?.generation === 'number' ? response.generation : undefined;
    return next(event);
  });
  on('classic.UserPromptSubmit', async ($, event, next) => {
    if (await active($)) {
      policyState.prompt = snapshotOf(event);
      policyState.harnessReady = false;
      policyState.preparing = undefined;
      policyState.generation = await recordPrompt(
        await policyClient($),
        policyState.prompt,
        policyState.generation,
      );
      policyState.harnessReady =
        policyState.generation !== undefined && isHarnessModel(await $.session.model());
    }
    return next(event);
  });
  on('classic.SessionStart', async ($, event, next) => {
    if ((await active($)) && typeof event.permission_mode === 'string') {
      policyState.prompt = snapshotOf(event);
      policyState.harnessReady = false;
      policyState.preparing = undefined;
      policyState.generation = await recordPrompt(
        await policyClient($),
        policyState.prompt,
        policyState.generation,
      );
      policyState.harnessReady =
        policyState.generation !== undefined && isHarnessModel(await $.session.model());
    }
    return next(event);
  });
};

async function active($: EngineInterface): Promise<boolean> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  return Boolean(base && token);
}

async function request($: EngineInterface, route: string, payload: Record<string, unknown>) {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  const body = JSON.stringify(payload);
  if (encodeURIComponent(body).replace(/%[A-F\d]{2}/gi, 'x').length > maxBody) {
    return undefined;
  }
  const isGet = route.startsWith('/multi/mod/display?') || route.startsWith('/multi/mod/mode?');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = $.http.fetch(`${base}${route}`, {
      method: isGet ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
      ...(isGet ? {} : { body }),
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('gateway request timeout')), 1500);
    });
    const result = await Promise.race([response, timeout]);
    return result.ok ? (JSON.parse(result.text) as GatewayResponse) : refusal(result);
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// A refused reply keeps the gateway's reason; `refused` stops polling callers.
function refusal(result: { text: string; status: number }): GatewayResponse {
  let error: string | undefined;
  try {
    const parsed: unknown = JSON.parse(result.text);
    if (parsed && typeof parsed === 'object') {
      error = (parsed as { error?: unknown }).error as string | undefined;
    }
  } catch {
    // A non-JSON body still names the status below.
  }
  return {
    refused: true,
    httpStatus: result.status,
    error: error ?? `gateway ${result.status}`,
  };
}

function snapshotOf(event: { session_id: string; cwd: string; permission_mode?: string }) {
  return { sessionId: event.session_id, cwd: event.cwd, permissionMode: event.permission_mode };
}

async function policyClient($: EngineInterface): Promise<PolicyClient> {
  return {
    model: await $.session.model(),
    request: (route, payload) => request($, route, payload),
  };
}
