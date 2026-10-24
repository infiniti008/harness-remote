import assert from 'node:assert/strict'
import { api } from './api.ts'
import { nativeSessionSurfaceTarget } from './native-session-discovery.ts'
import { registerNativeSessionV3Adapter } from './native-session-v3-adapter.ts'
import { sessionDataScope, sessionFeedCache } from './session-feed-cache.ts'
import { buildConversationTimeline } from './work-thread-timeline.ts'

const config = { host: 'cache-fixture', port: 1, username: '', password: '', backend: 'codex', agentId: 'codex' }
const record = { key: 'codex:cached', agentId: 'codex', agentLabel: 'Codex', backend: 'codex', transport: 'acp', session: { id: 'cached', title: 'Cached', directory: '/fixture' }, status: { type: 'idle' } }
const target = nativeSessionSurfaceTarget('machine', config, record)
const message = (id, role, text, created) => ({ info: { id, role, sessionID: target.sessionID, time: { created } }, parts: [{ id: `${id}-text`, type: 'text', text }] })
const cached = { messages: [message('u1', 'user', 'Original prompt', 1), message('a1', 'assistant', 'Cached answer', 2)], hasMore: false }
const scope = sessionDataScope(target.config, target.sessionID, target.directory)
sessionFeedCache.clear()
sessionFeedCache.set(scope, cached)
const registration = registerNativeSessionV3Adapter(target, () => {})
const original = api.loadMessagePage
try {
  const timeline = buildConversationTimeline(registration.conversation, { [target.sessionID]: cached.messages }, { codex: { label: 'Codex', backend: 'codex' } })
  assert.ok(timeline.some(m => m.parts.some(p => p.text === 'Cached answer')), 'cached answer renders on the first runtime snapshot, before any RPC')
  assert.ok(registration.conversation.turns.some(t => t.prompt === 'Original prompt'))
  api.loadMessagePage = async () => ({ messages: [...cached.messages, message('u2', 'user', 'External CLI append', 3), message('a2', 'assistant', 'New answer', 4)], hasMore: false })
  await registration.controller.loadMessagePage(target.config, target.sessionID, target.directory)
  const updated = await registration.controller.refreshConversation(target.config, registration.conversation.id)
  assert.ok(updated.turns.some(t => t.prompt === 'External CLI append'), 'cached seed does not suppress the initial authoritative turn discovery')
} finally {
  registration.dispose()
  api.loadMessagePage = original
}
for (const [changedTarget, label] of [
  [{ ...target, config: { ...target.config, password: 'other' } }, 'different credentials'],
  [{ ...target, status: { type: 'busy' } }, 'live session']
]) {
  const next = registerNativeSessionV3Adapter(changedTarget, () => {})
  assert.ok(!next.conversation.turns.some(t => t.prompt === 'Original prompt'), `${label} must not reuse an idle window`)
  next.dispose()
}
sessionFeedCache.clear()
console.log('cached native open: synchronous turn boundaries, authoritative refresh, live/account isolation passed')
