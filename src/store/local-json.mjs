// Local store: a sorted in-memory map, optionally written to one JSON file (data/store.json) after each write.
// Same semantics as the DynamoDB store, including the conditional put used for idempotency.
import fs from 'node:fs';
import path from 'node:path';

export class LocalJsonStore {
  constructor({ file } = {}) {
    this.kind = file === null ? 'memory' : 'json';
    this.file = file === null ? null : file || path.join(path.resolve(process.env.MANDAT_DATA || 'data'), 'store.json');
    this.rows = new Map(); // "pk\u0000sk" -> value
    if (this.file) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))) this.rows.set(k, v);
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn('[store] could not read', this.file, e.message);
      }
    }
  }
  key(pk, sk) { return pk + '\u0000' + sk; }
  clone(v) { return v === undefined || v === null ? null : structuredClone(v); }
  async get(pk, sk) { return this.clone(this.rows.get(this.key(pk, sk))); }
  async put(pk, sk, value) { this.rows.set(this.key(pk, sk), this.clone(value)); this.flush(); }
  async putIfAbsent(pk, sk, value) {
    const k = this.key(pk, sk);
    if (this.rows.has(k)) return false;
    this.rows.set(k, this.clone(value));
    this.flush();
    return true;
  }
  async query(pk, prefix = '') {
    const head = pk + '\u0000' + prefix;
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(head))
      .map(([k, v]) => ({ sk: k.slice(pk.length + 1), value: this.clone(v) }))
      .sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
  }
  async delete(pk, sk) { this.rows.delete(this.key(pk, sk)); this.flush(); }
  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(Object.fromEntries(this.rows)), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
