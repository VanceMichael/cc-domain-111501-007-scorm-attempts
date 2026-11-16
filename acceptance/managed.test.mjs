import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSource } from '../simulator/source.mjs';
import { collect, parseCalls } from '../src/collector.mjs';
import { Repository } from '../src/repository.mjs';
const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

async function session(run) {
  const directory = await mkdtemp(join(tmpdir(), 'structured-intake-'));
  const source = await createSource({ scenario: 'feature' });
  try { await run(source, await new Repository(directory).open(), directory); }
  finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
}

test('source records retain the product relationships rather than a file preview', async () => {
  await session(async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const records = repository.records();
    assert.deepEqual(records.map(record => record.id).sort(), [...fixture.expectedIds].sort());
    assert.equal(records[0].confirmed['cmi.completion_status'], 'incomplete');
    assert.equal(records[0].working['cmi.completion_status'], 'completed');
    assert.equal(records[0].confirmed['cmi.interactions.0.id'], 'question-a');
  });
});

test('repeated delivery after reopen preserves business identities and original evidence', async () => {
  await session(async (source, repository, directory) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const evidence = Object.keys(repository.snapshot().evidence);
    const reopened = await new Repository(directory).open();
    await collect({ base: source.base, repository: reopened, mode: 'managed' });
    assert.deepEqual(reopened.records().map(record => record.id).sort(), [...fixture.expectedIds].sort());
    assert.ok(evidence.every(digest => reopened.snapshot().evidence[digest]));
  });
});

test('a failed Commit does not confirm, and a later success confirms once', async () => {
  await session(async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const record = repository.records()[0];
    assert.deepEqual(record.rejected.map(item => item.error), ['391']);
    assert.equal(record.confirmed['cmi.completion_status'], 'incomplete');
    assert.equal(record.working['cmi.completion_status'], 'completed');
    assert.equal(record.completion, null, 'no completion fact without a confirming commit');
    assert.equal(record.terminated, false, 'the log has no Terminate');
    assert.equal((await collect({ base: source.base, repository, mode: 'managed' })).complete, false);
  });
});

test('the raw call order is retained for audit independently of the business result', async () => {
  await session(async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const calls = repository.snapshot().interpretation.calls;
    const seqs = calls.map(entry => entry.call.seq);
    assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(calls.every(entry => entry.provenance.digest && entry.provenance.path));
  });
});

test('a revision adds exactly one confirming event, not a second identity', async () => {
  await session(async (source, repository, directory) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    source.state.round = 2;
    const reopened = await new Repository(directory).open();
    await collect({ base: source.base, repository: reopened, mode: 'managed' });
    const records = reopened.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].confirmed['cmi.completion_status'], 'completed');
    assert.deepEqual(records[0].completion, { status: 'completed', seq: 10 });
    // Importing round=2 again must not append a second confirming event.
    await collect({ base: source.base, repository: reopened, mode: 'managed' });
    assert.equal(reopened.records()[0].completion.seq, 10);
    assert.equal(reopened.snapshot().interpretation.calls.length, 10);
  });
});

test('the same seq delivered with different content is reported as a conflict', async () => {
  await session(async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const before = repository.snapshot().interpretation;
    assert.equal(before.conflicts.length, 0);
    // Seed a stored reading of seq 8 that disagrees with what the source will
    // deliver, and drop the retained continuation so it is fetched again.
    const seeded = before.calls
      .filter(entry => entry.call.seq !== 8)
      .concat({
        call: { seq: 8, session: 's1', operation: 'GetValue', arguments: ['cmi.score.raw'], result: '42', error: '0' },
        provenance: { key: 'seq:8', document: 'continuation', path: 'later.ndjson', revision: 1, digest: 'seeded', seq: 8, arrival: 7 }
      });
    await repository.interpret({ ...before, calls: seeded });
    for (const digest of Object.keys(repository.snapshot().evidence)) delete repository.snapshot().evidence[digest];
    await repository.save();

    const result = await collect({ base: source.base, repository, mode: 'managed' });
    const conflicts = repository.snapshot().interpretation.conflicts;
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].seq, 8);
    assert.equal(result.complete, false, 'a conflict cannot be reported as complete');
    // The first reading is kept; the conflicting reading is not applied.
    assert.equal(repository.snapshot().interpretation.calls.find(entry => entry.call.seq === 8).call.result, '42');
  });
});

test('a missing document stays unresolved until the complement arrives', async () => {
  await session(async (source, repository) => {
    source.state.missingDoc = 'calls';
    const partial = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(partial.complete, false);
    assert.equal(repository.records().length, 0, 'no attempt is invented without Initialize');
    assert.ok(partial.notes.some(note => note.kind === 'missing'));
    assert.ok(repository.snapshot().notes.some(note => note.kind === 'missing'));

    source.state.missingDoc = null;
    await collect({ base: source.base, repository, mode: 'managed' });
    const records = repository.records();
    assert.deepEqual(records.map(record => record.id), [...fixture.expectedIds]);
    assert.equal(repository.snapshot().interpretation.unresolved.length, 0);
    assert.equal(records[0].confirmed['cmi.completion_status'], 'incomplete');
  });
});

test('a temporary source failure does not remove already-confirmed content', async () => {
  await session(async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const before = repository.records()[0].confirmed;
    source.state.failDoc = 'calls';
    const result = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(result.complete, false);
    assert.deepEqual(repository.records()[0].confirmed, before);
    assert.ok(result.notes.some(note => note.kind === 'unavailable'));
  });
});

test('an interruption after raw retention is recognized and completed by a resend', async () => {
  await session(async (source, repository, directory) => {
    // Keep only the first document to model an intake that stopped before the
    // continuation was delivered, then simulate a process restart.
    source.state.missingDoc = 'continuation';
    const partial = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(partial.complete, false);
    assert.equal(repository.records()[0].completion, null);
    assert.ok(Object.keys(repository.snapshot().evidence).length > 0, 'raw bytes survived');

    source.state.missingDoc = null;
    const restarted = await new Repository(directory).open();
    const done = await collect({ base: source.base, repository: restarted, mode: 'managed' });
    assert.equal(restarted.records().length, 1);
    assert.equal(restarted.snapshot().interpretation.calls.length, 9);
    assert.equal(done.added, 2, 'only the two new continuation calls are new');
    assert.equal(done.complete, false);
  });
});

test('a corrupt call log is reported without discarding retained evidence', async () => {
  await session(async (source, repository) => {
    // Unparseable continuation bytes are a data-boundary problem, not an
    // import success. They must surface as a located, unresolved note.
    source.state.failDoc = 'continuation';
    const failing = await collect({ base: source.base, repository, mode: 'managed' });
    assert.equal(failing.complete, false);
    assert.equal(repository.records().length, 1);
    assert.ok(Object.keys(repository.snapshot().evidence).length >= 1);
    assert.ok(failing.notes.every(note => note.source && note.revision));

    assert.throws(() => parseCalls('{"seq":1}\nnot-json', 'ndjson'), /unparseable call at line 2/);
    assert.deepEqual(parseCalls('{"calls":[{"seq":1}]}', 'json'), [{ seq: 1 }]);
  });
});

test('a restart after raw retention but before interpretation rebuilds from stored bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'structured-restart-'));
  const source = await createSource({ scenario: 'feature' });
  try {
    const crashed = await new Repository(directory).open();
    const catalog = await (await fetch(source.base + fixture.entry)).json();
    // Model a termination after each document was retained but before the
    // interpretation transaction committed.
    for (const document of catalog.documents) {
      const response = await fetch(source.base + document.href);
      await crashed.retain(document.path, Buffer.from(await response.arrayBuffer()), {
        etag: response.headers.get('etag'), revision: document.revision
      });
    }
    assert.equal(crashed.snapshot().interpretation, undefined);
    assert.equal(Object.keys(crashed.snapshot().evidence).length, catalog.documents.length);

    const reopened = await new Repository(directory).open();
    const result = await collect({ base: source.base, repository: reopened, mode: 'managed' });
    assert.equal(result.complete, false);
    assert.deepEqual(reopened.records().map(record => record.id).sort(), [...fixture.expectedIds].sort());
    assert.equal(reopened.records()[0].working['cmi.completion_status'], 'completed');
    assert.equal(reopened.records()[0].confirmed['cmi.completion_status'], 'incomplete');
    assert.equal(reopened.snapshot().interpretation.calls.length, 9);
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('stored state reopens in a separate process without losing the confirmed snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'structured-reopen-'));
  const source = await createSource({ scenario: 'feature' });
  try {
    const repository = await new Repository(directory).open();
    await collect({ base: source.base, repository, mode: 'managed' });
    const script = `
      import { Repository } from ${JSON.stringify(new URL('../src/repository.mjs', import.meta.url).href)};
      const reopened = await new Repository(${JSON.stringify(directory)}).open();
      const record = reopened.records()[0];
      process.stdout.write(JSON.stringify({
        confirmed: record.confirmed['cmi.completion_status'],
        working: record.working['cmi.completion_status'],
        calls: reopened.snapshot().interpretation.calls.length
      }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const observed = JSON.parse(child.stdout);
    assert.equal(observed.confirmed, 'incomplete');
    assert.equal(observed.working, 'completed');
    assert.equal(observed.calls, 9);
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});
