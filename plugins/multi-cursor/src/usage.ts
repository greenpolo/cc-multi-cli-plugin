interface CursorUsageRecord {
  agentId: string;
  scope: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
  cost?: { rawCostCents: number; chargedCents: number };
  runs: readonly { runId: string }[];
}

export interface CursorUsageView {
  summary: string;
  details: string[];
}

export type CursorUsageReader = (sessionId: string) => Promise<readonly CursorUsageRecord[]>;

/** Account quota and agent billing settle independently; retain either successful lookup. */
export async function readCursorAccountUsage(
  sessionId: string,
  quotaReader: () => Promise<CursorUsageView>,
  billingReader?: CursorUsageReader,
): Promise<CursorUsageView & { status: 'ready' | 'error' }> {
  const [quota, billing] = await Promise.allSettled([
    quotaReader(),
    billingReader ? readCursorUsage(sessionId, billingReader) : Promise.resolve(undefined),
  ]);
  const details: string[] = [];
  if (quota.status === 'fulfilled') {
    details.push(...quota.value.details);
  } else {
    details.push('Check the Cursor SDK login and connection, then refresh.');
  }
  if (billing.status === 'fulfilled' && billing.value) {
    details.push(billing.value.summary, ...billing.value.details);
  } else if (billing.status === 'rejected') {
    details.push('Agent billing could not be refreshed; previously recorded tokens remain below.');
  }
  return {
    status: quota.status === 'fulfilled' ? 'ready' : 'error',
    summary: quota.status === 'fulfilled' ? quota.value.summary : 'Subscription quota unavailable',
    details,
  };
}

async function readCursorUsage(
  sessionId: string,
  reader: CursorUsageReader,
): Promise<CursorUsageView> {
  const records = await reader(sessionId);
  const unique = new Map<string, CursorUsageRecord>();
  for (const record of records) {
    if (!unique.has(record.agentId)) {
      unique.set(record.agentId, record);
    }
  }
  if (!unique.size) {
    return { summary: 'Cursor billed usage unavailable (no active agents).', details: [] };
  }
  return formatCursorUsage([...unique.values()]);
}

function formatCursorUsage(records: readonly CursorUsageRecord[]): CursorUsageView {
  if (!records.length) {
    return { summary: 'Cursor billed usage unavailable (no active agents).', details: [] };
  }
  const totals = records.reduce(
    (result, record) => ({
      input: result.input + record.usage.inputTokens,
      output: result.output + record.usage.outputTokens,
      total: result.total + record.usage.totalTokens,
      charged: result.charged + (validCost(record.cost) ? record.cost.chargedCents : 0),
      knownCosts: result.knownCosts + (validCost(record.cost) ? 1 : 0),
    }),
    { input: 0, output: 0, total: 0, charged: 0, knownCosts: 0 },
  );
  const cost = totals.knownCosts
    ? `$${(totals.charged / 100).toFixed(2)} charged${
        totals.knownCosts < records.length ? ' (partial)' : ''
      }`
    : 'cost pending';
  return {
    summary:
      `Active agents in this session; billed totals cover each agent's lifetime, not account quota. ` +
      `Cursor billed usage: ${totals.total.toLocaleString('en-US')} tokens; ${cost}.`,
    details: records.map(
      (record, index) =>
        `Agent ${index + 1}: ${record.usage.totalTokens.toLocaleString('en-US')} tokens ` +
        `(${record.usage.inputTokens.toLocaleString('en-US')} in, ${record.usage.outputTokens.toLocaleString('en-US')} out); ` +
        (validCost(record.cost)
          ? `$${(record.cost.chargedCents / 100).toFixed(2)} charged ` +
            `(raw $${(record.cost.rawCostCents / 100).toFixed(2)})`
          : 'cost pending'),
    ),
  };
}

function validCost(
  cost: CursorUsageRecord['cost'],
): cost is NonNullable<CursorUsageRecord['cost']> {
  return (
    cost !== undefined &&
    Number.isFinite(cost.chargedCents) &&
    cost.chargedCents >= 0 &&
    Number.isFinite(cost.rawCostCents) &&
    cost.rawCostCents >= 0
  );
}
