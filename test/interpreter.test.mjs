import test from 'node:test';
import assert from 'node:assert/strict';
import { isComplete, readOutcome, reconcile } from '../src/interpreter.mjs';

function call(seq, fields) {
  return { seq, session: 's1', ...fields };
}

function observe(calls, document = 'calls') {
  return calls.map((value, position) => ({
    call: value,
    provenance: { key: `seq:${value.seq}`, document, path: `${document}.ndjson`, revision: 1, digest: 'd', seq: value.seq, arrival: position }
  }));
}

function attemptOf(state, id = 'learner-1:course-1:attempt-1') {
  return state.attempts[id];
}

test('SetValue is a working value until a successful Commit confirms it', () => {
  const state = reconcile(null, observe([
    call(1, { learner: 'learner-1', course: 'course-1', attempt: 'attempt-1', operation: 'Initialize', arguments: [''], result: 'true', error: '0' }),
    call(2, { operation: 'SetValue', arguments: ['cmi.completion_status', 'completed'], result: 'true', error: '0' }),
    call(3, { operation: 'Commit', arguments: [''], result: 'false', error: '391' }),
    call(4, { operation: 'SetValue', arguments: ['cmi.completion_status', 'incomplete'], result: 'true', error: '0' }),
    call(5, { operation: 'Commit', arguments: [''], result: 'true', error: '0' })
  ])).value;
  const record = attemptOf(state);
  assert.equal(record.working['cmi.completion_status'], 'incomplete');
  assert.equal(record.confirmed['cmi.completion_status'], 'incomplete');
  assert.equal(record.rejected.at(-1).error, '391');
  assert.equal(record.completion, null, 'incomplete is not a completion fact');
});

test('an uncommitted value never reaches the confirmed snapshot', () => {
  const state = reconcile(null, observe([
    call(1, { learner: 'learner-1', course: 'course-1', attempt: 'attempt-1', operation: 'Initialize', arguments: [''], result: 'true', error: '0' }),
    call(2, { operation: 'SetValue', arguments: ['cmi.completion_status', 'completed'], result: 'true', error: '0' })
  ])).value;
  const record = attemptOf(state);
  assert.equal(record.working['cmi.completion_status'], 'completed');
  assert.equal(record.confirmed['cmi.completion_status'], undefined);
  assert.equal(record.completion, null);
});

test('a successful Terminate commits and produces at most one completion fact', () => {
  const calls = [
    call(1, { learner: 'learner-1', course: 'course-1', attempt: 'attempt-1', operation: 'Initialize', arguments: [''], result: 'true', error: '0' }),
    call(2, { operation: 'SetValue', arguments: ['cmi.completion_status', 'completed'], result: 'true', error: '0' }),
    call(3, { operation: 'Terminate', arguments: [''], result: 'true', error: '0' })
  ];
  const once = reconcile(null, observe(calls)).value;
  assert.equal(attemptOf(once).confirmed['cmi.completion_status'], 'completed');
  assert.deepEqual(attemptOf(once).completion, { status: 'completed', seq: 3 });
  assert.equal(isComplete(once), true);

  // Re-delivering the same source calls must not create a second completion
  // or a second attempt.
  const twice = reconcile(once, observe(calls)).value;
  assert.equal(twice.attemptOrder.length, 1);
  assert.equal(attemptOf(twice).completion.seq, 3);
  assert.equal(attemptOf(twice).callCount, 3);
  assert.equal(twice.calls.length, 3);
});

test('re-entry after a pause resumes the confirmed snapshot, not the working set', () => {
  const state = reconcile(null, observe([
    call(1, { learner: 'learner-1', course: 'course-1', attempt: 'attempt-1', operation: 'Initialize', arguments: [''], result: 'true', error: '0' }),
    call(2, { operation: 'SetValue', arguments: ['cmi.location', 'page-2'], result: 'true', error: '0' }),
    call(3, { operation: 'Commit', arguments: [''], result: 'true', error: '0' }),
    // Unsaved work at the pause: must not be restored.
    call(4, { operation: 'SetValue', arguments: ['cmi.completion_status', 'completed'], result: 'true', error: '0' }),
    call(5, { operation: 'Terminate', arguments: [''], result: 'false', error: '391' }),
    // Re-entry resolves to the same attempt.
    call(6, { learner: 'learner-1', course: 'course-1', attempt: 'attempt-1', operation: 'Initialize', arguments: [''], result: 'true', error: '0' })
  ])).value;
  const record = attemptOf(state);
  assert.equal(record.attempt, 'attempt-1');
  assert.equal(record.working['cmi.location'], 'page-2');
  assert.equal(record.working['cmi.completion_status'], undefined);
  assert.equal(record.confirmed['cmi.completion_status'], undefined);
  assert.equal(record.completion, null);
  assert.equal(record.resumedAfterSeq, 5);
  assert.equal(record.terminated, false, 'a failed Terminate does not end the session');
  assert.equal(state.attemptOrder.length, 1, 're-entry is not a second attempt');
});

test('array indexes are grouped per attempt so reuse across attempts does not collide', () => {
  const state = reconcile(null, observe([
    call(1, { session: 's1', learner: 'learner-1', course: 'course-1', attempt: 'a', operation: 'Initialize', arguments: [''], result: 'true', error: '0' }),
    call(2, { session: 's1', operation: 'SetValue', arguments: ['cmi.interactions.0.id', 'q1'], result: 'true', error: '0' }),
    call(3, { session: 's1', operation: 'SetValue', arguments: ['cmi.objectives.0.id', 'o1'], result: 'true', error: '0' }),
    call(4, { session: 's1', operation: 'Commit', arguments: [''], result: 'true', error: '0' }),
    call(5, { session: 's2', learner: 'learner-1', course: 'course-1', attempt: 'b', operation: 'Initialize', arguments: [''], result: 'true', error: '0' }),
    call(6, { session: 's2', operation: 'SetValue', arguments: ['cmi.interactions.0.id', 'q2'], result: 'true', error: '0' }),
    call(7, { session: 's2', operation: 'SetValue', arguments: ['cmi.objectives.0.id', 'o2'], result: 'true', error: '0' }),
    call(8, { session: 's2', operation: 'Commit', arguments: [''], result: 'true', error: '0' })
  ]), 'calls').value;
  assert.deepEqual(state.attemptOrder, ['learner-1:course-1:a', 'learner-1:course-1:b']);
  assert.equal(attemptOf(state, 'learner-1:course-1:a').confirmedViews.interactions['0'].id, 'q1');
  assert.equal(attemptOf(state, 'learner-1:course-1:b').confirmedViews.interactions['0'].id, 'q2');
  assert.equal(attemptOf(state, 'learner-1:course-1:a').confirmedViews.objectives['0'].id, 'o1');
  assert.equal(attemptOf(state, 'learner-1:course-1:b').confirmedViews.objectives['0'].id, 'o2');
});

test('an empty GetValue is distinguished from an uninitialized model by error code', () => {
  const state = reconcile(null, observe([
    call(1, { learner: 'learner-1', course: 'course-1', attempt: 'attempt-1', operation: 'Initialize', arguments: [''], result: 'true', error: '0' }),
    call(2, { operation: 'GetValue', arguments: ['cmi.score.raw'], result: '', error: '403' }),
    call(3, { operation: 'GetValue', arguments: ['cmi.score.raw'], result: '', error: '0' }),
    call(4, { operation: 'GetValue', arguments: ['cmi.completion_status'], result: 'incomplete', error: '0' })
  ])).value;
  const reads = attemptOf(state).reads['cmi.score.raw'];
  assert.equal(reads.length, 2, 'both observations are retained in order');
  assert.equal(reads[0].kind, 'uninitialized');
  assert.equal(reads[1].kind, 'empty-value');
  assert.equal(reads[1].value, '');
  assert.equal(attemptOf(state).reads['cmi.completion_status'][0].kind, 'value');
  assert.equal(readOutcome({ result: '', error: '403' }).kind, 'uninitialized');
  assert.equal(readOutcome({ result: '', error: '0' }).kind, 'empty-value');
});

test('a call before an Initialize surfaces as unresolved instead of inventing an attempt', () => {
  const state = reconcile(null, observe([
    call(1, { operation: 'SetValue', arguments: ['cmi.completion_status', 'completed'], result: 'true', error: '0' }),
    call(2, { operation: 'Initialize', arguments: [''], result: 'true', error: '0' })
  ])).value;
  assert.equal(state.attemptOrder.length, 0);
  assert.equal(state.unresolved.length, 2);
  assert.equal(isComplete(state), false);
});

test('the recovery position is a confirmed business value, not a working-only one', () => {
  const state = reconcile(null, observe([
    call(1, { learner: 'learner-1', course: 'course-1', attempt: 'attempt-1', operation: 'Initialize', arguments: [''], result: 'true', error: '0' }),
    call(2, { operation: 'SetValue', arguments: ['cmi.location', 'sco-3'], result: 'true', error: '0' }),
    call(3, { operation: 'SetValue', arguments: ['cmi.suspend_data', 'blob'], result: 'true', error: '0' }),
    call(4, { operation: 'Commit', arguments: [''], result: 'true', error: '0' })
  ])).value;
  const record = attemptOf(state);
  assert.deepEqual(record.confirmedViews.recovery, { location: 'sco-3', suspendData: 'blob' });
  assert.deepEqual(record.workingViews.recovery, { location: 'sco-3', suspendData: 'blob' });
});

test('the same seq with different content is surfaced as a conflict, not overwritten', () => {
  const first = reconcile(null, observe([
    call(1, { learner: 'learner-1', course: 'course-1', attempt: 'attempt-1', operation: 'Initialize', arguments: [''], result: 'true', error: '0' }),
    call(2, { operation: 'SetValue', arguments: ['cmi.completion_status', 'incomplete'], result: 'true', error: '0' })
  ])).value;
  const conflict = observe([
    call(2, { operation: 'SetValue', arguments: ['cmi.completion_status', 'completed'], result: 'true', error: '0' })
  ], 'continuation');
  const merged = reconcile(first, conflict);
  assert.equal(merged.value.conflicts.length, 1);
  assert.equal(merged.value.conflicts[0].seq, 2);
  assert.equal(merged.value.attempts['learner-1:course-1:attempt-1'].working['cmi.completion_status'], 'incomplete');
  assert.equal(isComplete(merged.value), false);
});
