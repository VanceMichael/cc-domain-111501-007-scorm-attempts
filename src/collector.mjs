import { readFile } from 'node:fs/promises';
import { json, request } from './http.mjs';
import { preview } from './preview.mjs';
import { callKey, isComplete, reconcile } from './interpreter.mjs';
const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

export function parseCalls(text, format) {
  if (format === 'ndjson' || (format !== 'json')) {
    return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new Error(`unparseable call at line ${index + 1}: ${error.message}`); }
    });
  }
  const value = JSON.parse(text);
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.calls)) return value.calls;
  return [value];
}

// Read one source document, honoring ETag so an unchanged re-delivery is
// observed as 304 and reuses the retained bytes instead of re-parsing.
async function fetchDocument(base, document, priorEvidence) {
  const headers = priorEvidence?.etag ? { 'if-none-match': priorEvidence.etag } : {};
  const response = await request(base, document.href, { headers });
  if (response.status === 304) {
    if (!priorEvidence?.digest) throw new Error(`document ${document.id} answered 304 without retained bytes`);
    return { bytes: await priorEvidence.repository.raw(priorEvidence.digest), etag: priorEvidence.etag, notModified: true };
  }
  if (!response.ok) {
    const error = new Error(`document ${document.id} status ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    etag: response.headers.get('etag'),
    notModified: false
  };
}

// Managed intake: every document in the catalog is fetched, retained and
// interpreted as a call log. One failing document becomes an unresolved note
// instead of discarding the confirmed content of the others.
export async function collect({ base, repository, mode = 'legacy' }) {
  if (mode !== 'managed') return collectLegacy({ base, repository });

  const previous = repository.snapshot().interpretation ?? null;
  const catalog = await json(base, fixture.entry);
  const documents = Array.isArray(catalog.documents) ? catalog.documents : [];
  const observed = [];
  const notes = [];

  for (const document of documents) {
    // Only reuse retained bytes from the same revision; a new revision is a
    // new source fact even if the bytes happen to hash the same.
    const evidence = repository.evidenceFor(document.path)
      .filter(item => item.revision === document.revision);
    const priorEvidence = evidence.length ? evidence[evidence.length - 1] : undefined;
    let fetched;
    try {
      fetched = await fetchDocument(base, document, priorEvidence && { ...priorEvidence, repository });
    } catch (error) {
      notes.push({
        key: `source:${document.path}:revision-${document.revision}:${error.status ?? 'error'}`,
        level: 'unresolved', kind: error.status === 404 ? 'missing' : 'unavailable',
        source: document.path, revision: document.revision, message: error.message
      });
      await repository.note(notes.at(-1));
      continue;
    }

    let digest = priorEvidence?.digest;
    if (!fetched.notModified || !digest) {
      digest = await repository.retain(document.path, fetched.bytes, {
        etag: fetched.etag, revision: document.revision, document: document.id
      });
    }

    let calls;
    try {
      calls = parseCalls(fetched.bytes.toString('utf8'), document.format);
    } catch (error) {
      notes.push({
        key: `parse:${document.path}:revision-${document.revision}:${document.id}`,
        level: 'unresolved', kind: 'unparseable', source: document.path,
        revision: document.revision, message: error.message
      });
      await repository.note(notes.at(-1));
      continue;
    }

    for (const call of calls) {
      observed.push({
        call,
        provenance: {
          key: callKey(call, document.id, digest),
          document: document.id, path: document.path,
          revision: document.revision, digest, seq: call.seq ?? null
        }
      });
    }
  }

  const result = reconcile(previous, observed);
  const state = {
    ...result.value,
    documents: documents.map(document => ({
      id: document.id, path: document.path, revision: document.revision,
      status: notes.some(note => note.source === document.path) ? 'unresolved' : 'interpreted'
    })),
    updatedAt: new Date().toISOString()
  };
  await repository.interpret(state);

  return {
    imported: documents.length,
    added: result.added,
    complete: isComplete(state),
    mode: 'managed',
    records: state.attemptOrder.length,
    notes
  };
}

// seq is the source-owned call identity; see interpreter.callKey for the
// fallback used when an exported call carries no seq.

async function collectLegacy({ base, repository }) {
  const catalog = await json(base, fixture.entry);
  const first = catalog.documents[0];
  const response = await request(base, first.href);
  if (!response.ok) throw new Error(`document status ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = await repository.retain(first.path, bytes, { etag: response.headers.get('etag'), revision: first.revision });
  const result = preview(bytes.toString('utf8'), first.format);
  await repository.put({ id: first.id, path: first.path, ...result, digest });
  await repository.cursor('preview', { document: first.id, revision: first.revision });
  return { imported: 1, complete: false, mode: 'legacy' };
}
