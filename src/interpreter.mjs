import { createHash } from 'node:crypto';

// A revision of this module changes what the same bytes mean. Persisted
// interpretations carry the version so old results stay explainable.
export const INTERPRETATION = 'scorm-2004-call-log/1';

const SUCCESS = '0';
const INTERACTION = /^cmi\.interactions\.(\d+)\.(.+)$/;
const OBJECTIVE = /^cmi\.objectives\.(\d+)\.(.+)$/;

function clone(value) {
  return structuredClone(value);
}

// A GetValue answer is an observation, not a write. An empty answer is only
// an empty value when the error code says so; 403 means the model was not
// initialized, which is a distinct observation from `''`.
export function readOutcome(call) {
  if (call.error === SUCCESS) {
    return call.result === ''
      ? { kind: 'empty-value', value: '' }
      : { kind: 'value', value: call.result };
  }
  if (call.error === '403') return { kind: 'uninitialized', value: '' };
  return { kind: 'error', value: call.result ?? '', error: call.error };
}

// Attempts are the unit of business identity. Re-entering the same
// learner/course/attempt resolves to the same record, so pausing and
// resuming can never count as a second attempt or a second completion.
export function attemptId(identity) {
  return `${identity.learner}:${identity.course}:${identity.attempt}`;
}

// seq is unique across the exported source and is the stable identity of one
// call for de-duplication. It is deliberately not the business record id.
// Calls without a seq fall back to a content hash qualified by their document
// and digest, so re-delivery still resolves to the same ledger entry.
export function callKey(call, document = null, digest = null) {
  if (call.seq !== undefined && call.seq !== null && call.seq !== '') return `seq:${call.seq}`;
  const material = JSON.stringify([document, digest, call.session, call.operation, call.arguments, call.result, call.error]);
  return 'call:' + createHash('sha256').update(material).digest('hex');
}

// Project a flat model map onto the business groupings an administrator
// reviews: interactions and objectives by array index, plus the recovery
// position. Array indexes are reused across attempts, so grouping is always
// performed within one attempt record, never globally.
function views(flat) {
  const interactions = {};
  const objectives = {};
  const recovery = {};
  for (const [model, value] of Object.entries(flat)) {
    const interaction = INTERACTION.exec(model);
    if (interaction) {
      const [, index, field] = interaction;
      interactions[index] = { ...interactions[index], [field]: value };
      continue;
    }
    const objective = OBJECTIVE.exec(model);
    if (objective) {
      const [, index, field] = objective;
      objectives[index] = { ...objectives[index], [field]: value };
      continue;
    }
    if (model === 'cmi.location') recovery.location = value;
    else if (model === 'cmi.suspend_data') recovery.suspendData = value;
  }
  return { interactions, objectives, recovery };
}

function refresh(record) {
  // Only the working projection is recomputed per call. The confirmed
  // projection is rebuilt exclusively by confirmWorking, so an uncommitted
  // SetValue can never leak into confirmed output.
  record.workingViews = views(record.working);
  return record;
}

function emptyAttempt(identity) {
  return {
    id: attemptId(identity),
    learner: identity.learner,
    course: identity.course,
    attempt: identity.attempt,
    session: identity.session,
    sessions: [identity.session],
    confirmed: {},
    working: {},
    confirmedViews: views({}),
    workingViews: views({}),
    reads: {},
    rejected: [],
    submitted: false,
    confirmedAtSeq: null,
    completion: null,
    terminated: false,
    terminatedAtSeq: null,
    lastSeq: null,
    callCount: 0
  };
}

// One confirmed completion fact per attempt. Re-delivery of the same Commit is
// filtered by the ledger before replay, and re-entry resolves to this record,
// so an interrupted intake plus a resend cannot create a second completion.
function markCompleted(record, seq) {
  if (!record.completion && record.confirmed['cmi.completion_status'] === 'completed') {
    record.completion = { status: 'completed', seq };
  }
}

// Successful Commit / Terminate replace the confirmed snapshot with the
// working set. A failed Commit or Terminate leaves the confirmed snapshot
// untouched. SetValue success only ever writes the working set.
function confirmWorking(record, seq) {
  record.submitted = true;
  if (record.confirmedAtSeq === null) record.confirmedAtSeq = seq;
  record.confirmed = clone(record.working);
  record.confirmedViews = views(record.confirmed);
  markCompleted(record, seq);
}

function replayCall(record, call) {
  record.callCount += 1;
  if (typeof call.session === 'string' && !record.sessions.includes(call.session)) {
    record.sessions.push(call.session);
  }

  switch (call.operation) {
    case 'Initialize': {
      if (call.result === 'true' && call.error === SUCCESS) {
        // The LMS restores the persistent, confirmed snapshot at session
        // start. Uncommitted values from a prior session do not survive the
        // pause, so nothing from the working set is carried across.
        record.working = clone(record.confirmed);
        record.workingViews = views(record.working);
        if (record.lastSeq !== null) record.resumedAfterSeq = record.lastSeq;
      } else {
        record.rejected.push({
          operation: 'Initialize', result: call.result ?? null, error: call.error ?? null, seq: call.seq ?? null
        });
      }
      break;
    }

    case 'SetValue': {
      const [model, value] = Array.isArray(call.arguments) ? call.arguments : [];
      if (typeof model !== 'string' || typeof value !== 'string') {
        record.rejected.push({
          operation: 'SetValue', model: model ?? null, result: call.result ?? null,
          error: call.error ?? null, seq: call.seq ?? null, reason: 'malformed arguments'
        });
        break;
      }
      if (call.result === 'true' && call.error === SUCCESS) {
        record.working[model] = value;
      } else {
        record.rejected.push({
          operation: 'SetValue', model, value, result: call.result ?? null,
          error: call.error ?? null, seq: call.seq ?? null
        });
      }
      break;
    }

    case 'Commit': {
      if (call.result === 'true') confirmWorking(record, call.seq ?? null);
      else record.rejected.push({ operation: 'Commit', result: call.result ?? null, error: call.error ?? null, seq: call.seq ?? null });
      break;
    }

    case 'Terminate': {
      if (call.result === 'true' && call.error === SUCCESS) {
        // A successful Terminate also confirms before ending the session.
        confirmWorking(record, call.seq ?? null);
        record.terminated = true;
        record.terminatedAtSeq = call.seq ?? null;
      } else {
        // A failed Terminate neither ends the session nor confirms.
        record.rejected.push({ operation: 'Terminate', result: call.result ?? null, error: call.error ?? null, seq: call.seq ?? null });
      }
      break;
    }

    case 'GetValue': {
      const model = Array.isArray(call.arguments) ? call.arguments[0] : undefined;
      if (typeof model !== 'string') {
        record.rejected.push({
          operation: 'GetValue', model: model ?? null, result: call.result ?? null,
          error: call.error ?? null, seq: call.seq ?? null, reason: 'malformed arguments'
        });
        break;
      }
      // Keep every observation verbatim, including '' paired with an error
      // code, so "empty value" and "not initialized yet" stay distinguishable
      // and auditable rather than collapsing into one empty string.
      (record.reads[model] ??= []).push({ ...readOutcome(call), seq: call.seq ?? null });
      break;
    }

    default: {
      // Unknown operations stay as unresolved evidence rather than being
      // silently mapped onto a known lifecycle step.
      record.rejected.push({
        operation: call.operation ?? null, result: call.result ?? null,
        error: call.error ?? null, seq: call.seq ?? null, reason: 'unknown operation'
      });
    }
  }

  record.lastSeq = call.seq ?? record.lastSeq;
  refresh(record);
  return record;
}

// A session belongs to the attempt whose Initialize declared it. Later calls
// only carry the session, so this map is the link back to the business
// attempt. A session declared again by a later Initialize re-points it, which
// keeps exported session reuse from silently landing on a stale attempt.
function identityFor(call, attempts, sessions) {
  if (call.operation === 'Initialize') {
    if (typeof call.learner === 'string' && typeof call.course === 'string' && call.attempt !== undefined && call.attempt !== null) {
      return {
        learner: call.learner, course: call.course,
        attempt: String(call.attempt), session: call.session
      };
    }
    return null;
  }
  if (typeof call.session !== 'string') return null;
  const id = sessions.get(call.session);
  const known = id ? attempts[id] : undefined;
  if (!known) return null;
  return { learner: known.learner, course: known.course, attempt: known.attempt, session: known.session };
}

function compareCalls(left, right) {
  const leftSeq = left.call.seq;
  const rightSeq = right.call.seq;
  const leftNumber = typeof leftSeq === 'number' ? leftSeq : NaN;
  const rightNumber = typeof rightSeq === 'number' ? rightSeq : NaN;
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  // Calls without a usable seq keep the order in which they were observed.
  return left.provenance.arrival - right.provenance.arrival;
}

// Rebuild the whole interpretation from the union of previously stored and
// newly observed calls, sorted by the source sequence. Rebuilding makes the
// result independent of which document arrived first and of repeated
// delivery; it also means a late continuation document can be integrated
// without rewriting the business identity of earlier calls.
export function reconcile(previous, observed) {
  const stored = Array.isArray(previous?.calls) ? clone(previous.calls) : [];
  const byKey = new Map(stored.map(entry => [entry.provenance.key, entry]));
  const conflicts = [];
  let added = 0;
  for (const entry of observed) {
    const existing = byKey.get(entry.provenance.key);
    if (existing) {
      // The same seq must describe the same call. If the source re-delivers
      // that position with different content, the two readings conflict; the
      // first reading is kept and the conflict is surfaced for review rather
      // than silently overwritten.
      const material = call => JSON.stringify([
        call.session, call.operation, call.arguments, call.result, call.error
      ]);
      if (material(existing.call) !== material(entry.call)) {
        conflicts.push({
          key: entry.provenance.key, seq: entry.call.seq ?? null,
          kept: existing.provenance, conflict: entry.provenance
        });
      }
      continue;
    }
    byKey.set(entry.provenance.key, {
      call: clone(entry.call),
      provenance: { ...entry.provenance, arrival: byKey.size }
    });
    added += 1;
  }
  const calls = [...byKey.values()].sort(compareCalls);

  const attempts = {};
  const attemptOrder = [];
  const sessions = new Map();
  const unresolved = [];
  for (const { call, provenance } of calls) {
    const identity = identityFor(call, attempts, sessions);
    if (!identity) {
      unresolved.push({
        key: provenance.key, seq: call.seq ?? null, source: provenance.path,
        reason: call.operation === 'Initialize'
          ? 'Initialize did not declare a complete learner/course/attempt identity'
          : 'call session has no Initialize declaring its attempt'
      });
      continue;
    }
    const id = attemptId(identity);
    if (!attempts[id]) {
      attempts[id] = emptyAttempt(identity);
      attemptOrder.push(id);
    }
    if (typeof call.session === 'string') sessions.set(call.session, id);
    replayCall(attempts[id], call);
  }

  return {
    changed: added > 0 || !previous,
    added,
    value: {
      interpretation: INTERPRETATION,
      calls,
      attemptOrder,
      attempts,
      unresolved,
      conflicts
    }
  };
}

// Complete means every attempt has a checked termination and a confirmed
// snapshot, and no source call is left unresolved. It is never inferred from
// an HTTP 200 or from a preview succeeding.
export function isComplete(state) {
  const records = (state?.attemptOrder ?? []).map(id => state.attempts[id]).filter(Boolean);
  if (records.length === 0) return false;
  if ((state.unresolved ?? []).length > 0) return false;
  if ((state.conflicts ?? []).length > 0) return false;
  return records.every(record => record.terminated && record.submitted);
}
