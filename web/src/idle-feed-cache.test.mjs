import assert from 'node:assert/strict'
import { BoundedDataCache } from './bounded-data-cache.ts'
import { sessionDataScope, sessionFeedCache } from './session-feed-cache.ts'
import { MessagePageCache } from './message-page-cache.ts'

const config = { host: 'machine-a', port: 4902, backend: 'codex', agentId: 'codex', username: 'user', password: 'test-only' }
const scope = sessionDataScope(config, 'same-id', '/project')
for (const change of [{ host: 'machine-b' }, { port: 4903 }, { backend: 'pi' }, { agentId: 'other' }, { username: 'other' }, { password: 'changed' }]) {
  assert.notEqual(sessionDataScope({ ...config, ...change }, 'same-id', '/project'), scope)
}
assert.notEqual(sessionDataScope(config, 'same-id', '/other-project'), scope)
assert.notEqual(sessionDataScope(config, 'other-id', '/project'), scope)
const feed = { messages: [], before: '123', hasMore: true, model: { providerID: 'codex', modelID: 'native-model' } }
sessionFeedCache.clear()
sessionFeedCache.set(scope, feed)
assert.equal(sessionFeedCache.get(scope), feed, 'a remount gets its window, cursor and model synchronously')
assert.equal(sessionFeedCache.get(sessionDataScope({ ...config, host: 'machine-b' }, 'same-id', '/project')), undefined)

const small = new BoundedDataCache(2000, 1000, 2)
small.set('a', 'a'); small.set('b', 'b'); small.get('a'); small.set('c', 'c')
assert.equal(small.get('b'), undefined, 'least recently viewed entry is evicted')
small.set('huge', 'x'.repeat(1000))
assert.equal(small.get('huge'), undefined, 'oversized windows do not remain in memory')
assert.ok(small.stats().estimatedBytes <= small.stats().maxBytes)

const pages = new MessagePageCache()
let release
let loads = 0
const firstResponse = { data: [], headers: { 'x-history-revision': 'r1' } }
const first = pages.load(scope, () => { loads++; return new Promise(resolve => { release = resolve }) }, () => feed)
const second = pages.load(scope, () => { throw new Error('duplicate fetch') }, () => feed)
await Promise.resolve()
assert.equal(loads, 1)
release(firstResponse)
assert.equal(await first, feed)
assert.equal(await second, feed)
let seenRevision
assert.equal(await pages.load(scope, async revision => {
  seenRevision = revision
  return { data: true, headers: { 'x-history-not-modified': '1' } }
}, () => { throw new Error('unchanged response must not decode an empty body') }), feed)
assert.equal(seenRevision, 'r1')
const updated = { ...feed, messages: [{ info: { id: 'external-cli-append' }, parts: [] }] }
assert.equal(await pages.load(scope, async () => ({ data: updated.messages, headers: { 'x-history-revision': 'r2' } }), () => updated), updated)
await assert.rejects(pages.load(scope, async () => { throw new Error('offline') }, () => updated), /offline/)
assert.equal(pages.stats().inFlight, 0)
await pages.load(scope, async revision => { assert.equal(revision, 'r2'); return { data: [], headers: {} } }, () => feed)
await pages.load(scope, async revision => { assert.equal(revision, undefined, 'live responses invalidate saved revisions'); return { data: [], headers: {} } }, () => feed)
sessionFeedCache.clear()
console.log('idle-feed-cache: scoped windows, LRU/byte bounds, coalescing, conditional reads, external updates and failure recovery passed')
