import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { Repository } from '../src/repository.mjs';
import { collect } from '../src/collector.mjs';

const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
const source = await createSource({ scenario: 'feature' });
try {
  const repository = await new Repository(directory).open();
  const result = await collect({ base: source.base, repository, mode: 'managed' });
  const records = repository.records().map(record => ({
    id: record.id,
    learner: record.learner, course: record.course, attempt: record.attempt,
    confirmed: record.confirmed,
    working: record.working,
    interactions: record.confirmedViews.interactions,
    objectives: record.confirmedViews.objectives,
    recovery: record.confirmedViews.recovery,
    reads: record.reads,
    rejected: record.rejected,
    completion: record.completion
  }));
  const calls = repository.snapshot().interpretation.calls
    .map(entry => ({ seq: entry.call.seq, operation: entry.call.operation, path: entry.provenance.path, revision: entry.provenance.revision }));
  console.log(JSON.stringify({ result, records, calls, requests: source.requests }, null, 2));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
