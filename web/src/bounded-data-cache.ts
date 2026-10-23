/** Memory-only transcript data. Never stores a native runtime, subscriptions or permissions. */
export class BoundedDataCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>()
  private bytes = 0

  constructor(private maxBytes = 16 * 1024 * 1024, private maxEntryBytes = 2 * 1024 * 1024, private maxEntries = 64) {}

  private weight(value: unknown): number {
    const stack = [value]
    const seen = new Set<object>()
    let bytes = 0
    while (stack.length) {
      const item = stack.pop()
      if (typeof item === "string") bytes += 32 + item.length * 2
      else if (item && typeof item === "object") {
        if (seen.has(item)) continue
        seen.add(item)
        bytes += 128
        for (const [key, child] of Object.entries(item)) {
          bytes += key.length * 2 + 32
          stack.push(child)
        }
      } else bytes += 16
      if (bytes > this.maxEntryBytes) break
    }
    return bytes
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T): void {
    this.delete(key)
    const bytes = this.weight(value)
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return
    this.entries.set(key, { value, bytes })
    this.bytes += bytes
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.bytes -= entry.bytes
    this.entries.delete(key)
  }

  clear(): void { this.entries.clear(); this.bytes = 0 }
  stats() { return { entries: this.entries.size, estimatedBytes: this.bytes, maxBytes: this.maxBytes } }
}
