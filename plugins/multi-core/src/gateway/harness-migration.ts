import { isRecord } from './record.ts';

/** Retain native state; only the retired transport verdicts and terminal events go. */
export function migrateHarnessSession(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const response = withoutVerdicts(value.response);
  const replay = migrateEventsField(value.replay);
  return response === value.response && replay === value.replay
    ? value
    : { ...value, response, replay };
}

/** An archived reply carries its content events directly instead of under replay. */
export function migrateHarnessReply(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const response = withoutVerdicts(value.response);
  return migrateEventsField(response === value.response ? value : { ...value, response });
}

function withoutVerdicts(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, 'safeguard_results')) {
    return value;
  }
  const { safeguard_results: _retired, ...response } = value;
  return response;
}

function migrateEventsField(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    return value;
  }
  const events: unknown[] = [];
  let changed = false;
  for (const event of value.events) {
    const migrated = migrateEvent(event);
    changed ||= migrated !== event;
    if (migrated !== undefined) {
      events.push(migrated);
    }
  }
  return changed ? { ...value, events } : value;
}

function migrateEvent(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 2 || !isRecord(value[1])) {
    return value;
  }
  const [name, body] = value;
  if (name === 'message_delta' || name === 'message_stop') {
    return undefined;
  }
  if (name !== 'message_start') {
    return value;
  }
  const message = withoutVerdicts(body.message);
  return message === body.message ? value : [name, { ...body, message }];
}
