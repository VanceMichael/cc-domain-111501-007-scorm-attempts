import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class Repository {
  constructor(directory) {
    this.directory = directory;
    this.state = { records: {}, cursors: {}, evidence: {}, notes: [] };
  }

  async open() {
    await mkdir(join(this.directory, 'raw'), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  async save() {
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, join(this.directory, 'state.json'));
  }

  async put(record) {
    if (!record.id) throw new Error('record id required');
    this.state.records[record.id] = structuredClone(record);
    await this.save();
  }

  async retain(origin, body, metadata = {}) {
    const bytes = Buffer.from(body);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(this.directory, 'raw', digest), bytes);
    this.state.evidence[digest] = { origin, ...metadata, size: bytes.length };
    await this.save();
    return digest;
  }

  async cursor(name, value) {
    this.state.cursors[name] = structuredClone(value);
    await this.save();
  }

  async note(value) {
    // A keyed note describes one stable observation. Re-delivery of the same
    // source position must not grow the diagnostic log.
    if (value?.key && this.state.notes.some(note => note.key === value.key)) return;
    this.state.notes.push(structuredClone(value));
    await this.save();
  }

  async raw(digest) {
    return readFile(join(this.directory, 'raw', digest));
  }

  evidenceFor(origin) {
    return Object.entries(this.state.evidence)
      .filter(([, evidence]) => evidence.origin === origin)
      .map(([digest, evidence]) => ({ digest, ...structuredClone(evidence) }));
  }

  async interpret(state) {
    this.state.interpretation = structuredClone(state);
    const records = {};
    for (const id of state.attemptOrder ?? []) {
      const attempt = state.attempts[id];
      if (!attempt) continue;
      // The admin-facing record mirrors the attempt. `confirmed` is what the
      // platform acknowledged; `working` includes values not yet committed.
      records[id] = structuredClone(attempt);
    }
    // Legacy preview records are owned by `put`, not by the managed
    // interpretation. Replace only the records this layer manages so old
    // records (and their raw bytes) stay readable after a managed import.
    const managed = new Set(this.state.managedIds ?? []);
    for (const [id, record] of Object.entries(this.state.records)) {
      if (!managed.has(id) && !(id in records)) records[id] = record;
    }
    this.state.records = records;
    this.state.managedIds = [...state.attemptOrder ?? []];
    await this.save();
  }

  records() {
    return Object.values(structuredClone(this.state.records));
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
