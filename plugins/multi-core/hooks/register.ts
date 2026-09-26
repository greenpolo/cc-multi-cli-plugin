import type { EngineInterface, Register } from 'claude-code';
import { register as registerCompaction } from './compact.ts';
import { register as registerLifecycle } from './lifecycle.ts';
import { type PolicyClient, type PolicyState, recordPrompt } from './policy.ts';
import { isHarnessModel } from './provider.ts';
import { type RowsClient, register as registerRows, syncDisplayTools } from './rows.ts';
import { register as registerUsage } from './usage.ts';
import { register as registerWorkers } from './workers.ts';

const maxBody = 32000;

type GatewayResponse = {
  refused?: true;
  httpStatus?: number;
  error?: string;
  accepted?: boolean;
  generation?: number | string;
  status?: string;
  stale?: boolean;
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
  registerRows(on);
  on('session.start', async ($, event, next) => {
    if (!(await active($))) {
      return next(event);
    }
    await $.command.register({
      name: 'multi-usage',
      description: 'Open provider quotas, spend, and session receipts.',
      immediate: true,
    });
    const response = await request($, '/multi/mod/session', {
      sessionId: await $.session.id(),
      cwd: await $.session.cwd(),
      model: await $.session.model(),
      event: 'start',
    });
    policyState.generation =
      typeof response?.generation === 'number' ? response.generation : undefined;
    // Display rows for native harness actions; awaited so the first run's rows anchor.
    await syncDisplayTools(rowsClient($));
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
  const isGet = route.includes('?');
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

function rowsClient($: EngineInterface): RowsClient {
  return {
    sessionId: () => $.session.id(),
    catalog: () => request($, '/multi/mod/display-tools?', {}),
    register: (tool) => $.tool.register(tool),
    acknowledge: (payload) => request($, '/multi/mod/display-tools', payload),
  };
}

async function policyClient($: EngineInterface): Promise<PolicyClient> {
  return {
    model: await $.session.model(),
    request: (route, payload) => request($, route, payload),
  };
}
