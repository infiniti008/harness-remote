// Bounded data cache only: never retains an ACP client, native writer, or full transcript.
export class RevisionPageCache {
  constructor({ maxBytes = 16 * 1024 * 1024, maxEntryBytes = 2 * 1024 * 1024, maxEntries = 64 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntryBytes = Math.min(maxEntryBytes, maxBytes);
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.pending = new Map();
    this.bytes = 0;
    this.counts = { hits: 0, misses: 0, loads: 0, coalesced: 0, evictions: 0, oversized: 0 };
  }

  // Conservative payload estimate without serializing a potentially huge message to one string.
  weight(value) {
    let bytes = 0;
    const stack = [value];
    const seen = new Set();
    while (stack.length) {
      const item = stack.pop();
      if (typeof item === 'string') bytes += 32 + item.length * 2;
      else if (item && typeof item === 'object') {
        if (seen.has(item)) continue;
        seen.add(item);
        bytes += 128;
        for (const [key, child] of Object.entries(item)) {
          bytes += 32 + key.length * 2;
          stack.push(child);
        }
      } else bytes += 16;
      if (bytes > this.maxEntryBytes) return bytes;
    }
    return bytes;
  }

  remove(key, evicted = false) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    if (evicted) this.counts.evictions++;
  }

  invalidate(scope) {
    for (const [key, entry] of this.entries) {
      if (entry.scope === scope) this.remove(key);
    }
  }

  read({ scope, revision, query, load, current }) {
    const key = JSON.stringify([scope, revision, query]);
    const cached = this.entries.get(key);
    if (cached) {
      this.counts.hits++;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return Promise.resolve(cached.value);
    }
    const active = this.pending.get(key);
    if (active) { this.counts.coalesced++; return active; }
    this.counts.misses++;
    this.counts.loads++;
    const work = Promise.resolve().then(load).then(async (value) => {
      if (value === undefined || (current && !await current())) return value;
      const bytes = this.weight(value);
      if (bytes > this.maxEntryBytes) { this.counts.oversized++; return value; }
      for (const [oldKey, entry] of this.entries) {
        if (entry.scope === scope && entry.revision !== revision) this.remove(oldKey);
      }
      this.entries.set(key, { scope, revision, value, bytes });
      this.bytes += bytes;
      while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
        this.remove(this.entries.keys().next().value, true);
      }
      return value;
    });
    this.pending.set(key, work);
    void work.finally(() => { if (this.pending.get(key) === work) this.pending.delete(key); }).catch(() => {});
    return work;
  }

  diagnostics() { return { ...this.counts, entries: this.entries.size, estimatedBytes: this.bytes, inFlight: this.pending.size, maxBytes: this.maxBytes }; }
}
