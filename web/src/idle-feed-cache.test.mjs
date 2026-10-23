import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workThread = readFileSync(new URL('./components/work-thread-conversation.tsx', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('./native-session-v3-adapter.ts', import.meta.url), 'utf8')

// Root-cause fix: re-opening an idle (non-running) Session must not re-read its full transcript window
// from the network - that second read only causes an empty-window flash and a scroll reset. The render
// layer keeps the last fetched window per Session so an in-app navigation away and back shows the exact
// same transcript instantly. This is a cache of durable *transcript data only*, never a keep-alive of
// the projection/runtime, so the clean-start invariant stays intact.
assert.ok(workThread.includes('const idleFeedCache = new Map<string, SessionFeed>()'), 'idle transcripts live in a module store so they survive a surface remount')
assert.ok(workThread.includes('IDLE_FEED_CACHE_LIMIT'), 'the idle transcript store is LRU-capped so a long session list does not leak')
assert.ok(workThread.includes('function readIdleFeedCache('), 'the clean-start path must be able to read the remembered window')
assert.ok(workThread.includes('function upsertIdleFeedCache('), 'every successful read must mirror its window back to the store')
assert.ok(workThread.includes('if (idleFeedCache.size > IDLE_FEED_CACHE_LIMIT)'), 'the store must evict its oldest window past the cap')
assert.ok(workThread.includes('const oldest = idleFeedCache.keys().next().value'), 'eviction must drop the least-recently-used window')

// The idle gate must use the canonical "is this Session still running" predicate so a live turn is never
// served from a stale window. A Session that is still working is always read live below.
assert.ok(workThread.includes('import { nativeSessionIsWorking }'), 'the working predicate must come from the v3 adapter so it matches every other surface')
assert.ok(workThread.includes('if (!nativeSessionIsWorking(conversation.status))'), 'only a settled Session is allowed to be served from the idle cache')

// A re-open of a settled Session seeds its window synchronously and skips the network page entirely.
assert.ok(workThread.includes('setFeeds(seeded)'), 'the cached window must seed the feeds synchronously to avoid the empty-window flash')
assert.ok(workThread.includes('feedsRef.current = seeded'), 'the loader must see the seed so it never re-fetches')
assert.ok(workThread.includes('setLoading(Object.keys(seeded).length === 0)'), 'a hit must not flash the loading spinner; a miss still loads from the network')
assert.ok(workThread.includes('const cached = readIdleFeedCache(target.sessionID)'), 'each target Session is seeded by its own remembered window')

// The seed must happen *synchronously at mount* (in the lazy initializers), not only in a post-commit
// effect. A post-commit seed paints an empty "Loading conversation…" frame first and then drops the
// window in under it; that layout change is exactly what reset the scroll, so the window has to be on
// the very first committed frame for a settled re-open.
assert.ok(workThread.includes('function seedIdleFeeds('), 'the on-mount seed helper centralizes the idle window read')
assert.ok(workThread.includes('useState<Record<string, SessionFeed>>(mountFeedSeed)'), 'the feeds window must be seeded synchronously in the initializer, before the first commit')
assert.ok(workThread.includes('useState(Object.keys(mountFeedSeed).length === 0)'), 'loading must come from the mount seed so a hit never flashes the spinner on frame one')

// Every successful read (initial load, tail refresh, older paging) must keep the store current so the
// next re-open reflects the latest settled window.
assert.ok(workThread.includes('for (const [session, feed] of Object.entries(feeds)) upsertIdleFeedCache(session, feed)'), 'the rendered window must mirror back to the store on every change')

// The loader must stay authoritative: an unseeded (live) Session still reads the page from the network.
assert.ok(workThread.includes('controller.loadMessagePage'), 'the mature controller remains the only transcript source for an unseeded target')

// The cache must not reintroduce the banned keep-alive machinery, and the clean-start invariant on the
// adapter must stay intact: a projection is still discarded on teardown.
assert.equal(workThread.includes('MAX_CACHED_PROJECTIONS'), false, 'the idle feed cache must not bring back a projection cache')
assert.equal(workThread.includes('pruneInactiveProjections'), false, 'the idle feed cache must not bring back idle-projection pruning')

assert.ok(adapter.includes('if (entry && entry.listeners.size === 0) conversations.delete(id)'), 'a clean start must still discard a retired projection when its last listener leaves')

console.log('idle-feed-cache.test.mjs: 20 assertions passed')
