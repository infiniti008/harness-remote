import { BoundedDataCache } from "./bounded-data-cache"
import type { MessagePage } from "./api"
import type { MessageEnvelope } from "./types"

type CachedPage = { revision: string; page: MessagePage }
type PageResponse = { data: MessageEnvelope[]; headers: Record<string, string> }

/** Revision validation happens on every call; there is no stale-time assumption for idle sessions. */
export class MessagePageCache {
  private data = new BoundedDataCache<CachedPage>(16 * 1024 * 1024, 2 * 1024 * 1024, 64)
  private pending = new Map<string, Promise<MessagePage>>()

  load(key: string, fetchPage: (revision?: string) => Promise<PageResponse>, decode: (response: PageResponse) => MessagePage): Promise<MessagePage> {
    const active = this.pending.get(key)
    if (active) return active
    const cached = this.data.get(key)
    const work = Promise.resolve().then(() => fetchPage(cached?.revision)).then((response) => {
      if (response.headers["x-history-not-modified"] === "1" && cached) return cached.page
      const page = decode(response)
      const revision = response.headers["x-history-revision"]
      if (revision) this.data.set(key, { page, revision })
      else this.data.delete(key) // Live/legacy sources cannot validate a saved window.
      return page
    })
    this.pending.set(key, work)
    void work.finally(() => { if (this.pending.get(key) === work) this.pending.delete(key) }).catch(() => {})
    return work
  }

  stats() { return { ...this.data.stats(), inFlight: this.pending.size } }
}
