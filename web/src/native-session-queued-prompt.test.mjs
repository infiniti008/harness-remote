import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * A prompt the daemon queues behind the running turn is not a turn of the conversation. The
 * conversation keeps tracking the running turn - so its reply, "getting started" and "working"
 * states stay where they belong - and the queued prompt becomes the newest turn only once the
 * transcript shows the daemon started it. The daemon's `info.queued` flag is the authority, so the
 * hand-over survives a remount and adopts rows another client queued.
 */

class MemoryStorage {
  #values = new Map()
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null }
  setItem(key, value) { this.#values.set(key, String(value)) }
  removeItem(key) { this.#values.delete(key) }
  clear() { this.#values.clear() }
}

const originalStorage = globalThis.localStorage
const originalWindow = globalThis.window
const originalFetch = globalThis.fetch
const storage = new MemoryStorage()
globalThis.window ??= globalThis
globalThis.localStorage = storage

const { api } = await import('./api.ts')
const originalLoadMessagePage = api.loadMessagePage
const originalListStatuses = api.listStatuses
const originalSendQueuedPromptNow = api.sendQueuedPromptNow
const originalEditQueuedPrompt = api.editQueuedPrompt
const { registerNativeSessionV3Adapter } = await import('./native-session-v3-adapter.ts')

const CONFIG = { backend: 'claude', host: '127.0.0.1', port: 4097, username: 'harness', password: 'pw', agentId: 'claude' }
const MODEL = { providerID: 'claude', modelID: 'default' }
const DIRECTORY = '/repo'

function target(sessionID) {
  return {
    key: `machine:claude:${sessionID}`,
    ref: { machineID: 'machine', agentID: 'claude', sessionID, directory: DIRECTORY },
    machineID: 'machine',
    agentID: 'claude',
    agentLabel: 'Claude Code',
    backend: 'claude',
    transport: 'acp',
    sessionID,
    directory: DIRECTORY,
    title: 'Queued prompt Session',
    external: false,
    modelsSupported: true,
    model: MODEL,
    requiresExplicitClaim: false,
    canStop: true,
    config: CONFIG
  }
}

function user(sessionID, id, text, queued = false) {
  return {
    info: { id, role: 'user', sessionID, time: { created: Date.now() }, ...(queued ? { queued: true } : {}) },
    parts: [{ id: `${id}:text`, messageID: id, type: 'text', text }]
  }
}

function assistant(sessionID, id, text) {
  return {
    info: { id, role: 'assistant', sessionID, time: { created: Date.now() } },
    parts: [{ id: `${id}:text`, messageID: id, type: 'text', text }]
  }
}

function respondWith(results, onRequest) {
  globalThis.fetch = async (url, options) => {
    onRequest?.(url, options)
    const body = results.shift()
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

function restore() {
  api.loadMessagePage = originalLoadMessagePage
  api.listStatuses = originalListStatuses
  api.sendQueuedPromptNow = originalSendQueuedPromptNow
  api.editQueuedPrompt = originalEditQueuedPrompt
  globalThis.fetch = originalFetch
}

async function startQueuedPrompt(registration, sessionID, prompt, clientRequestId, messageID) {
  let queuedClientRequestId
  respondWith([
    { status: 'accepted', clientRequestId: `running-${clientRequestId}`, result: { disposition: 'started', messageID: `running-${messageID}` } },
    { status: 'accepted', clientRequestId, result: { disposition: 'queued', messageID } }
  ], (url, options) => {
    if (String(url).endsWith(`/session/${sessionID}/prompt`)) {
      queuedClientRequestId = JSON.parse(options.body).clientRequestId
    }
  })
  await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY)
  await registration.controller.continueConversation(CONFIG, registration.conversation.id, { prompt: 'already running', model: MODEL })
  const conversation = await registration.controller.continueConversation(CONFIG, registration.conversation.id, { prompt, model: MODEL })
  assert.equal(conversation.turns.length, 1)
  assert.equal(conversation.currentTurn.prompt, 'already running')
  return { conversation, clientRequestId: queuedClientRequestId }
}

test('a queued prompt stays out of the turns until the transcript shows it started, across a remount', async () => {
  storage.clear()
  const sessionID = 'queued-session-1'
  let page = { messages: [], hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [sessionID]: { type: 'busy' } })
  respondWith([
    { status: 'accepted', clientRequestId: 'request-a', result: { disposition: 'started', messageID: 'bridge-a' } },
    { status: 'accepted', clientRequestId: 'request-b', result: { disposition: 'queued', messageID: 'bridge-b' } }
  ])

  let registration = registerNativeSessionV3Adapter(target(sessionID), () => {})
  try {
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY)
    const started = await registration.controller.continueConversation(CONFIG, registration.conversation.id, { prompt: 'first', model: MODEL })
    assert.equal(started.currentTurn.prompt, 'first')

    const queued = await registration.controller.continueConversation(CONFIG, registration.conversation.id, { prompt: 'second', model: MODEL })
    assert.equal(queued.turns.length, 1, 'a queued prompt is not a turn')
    assert.equal(queued.currentTurn.prompt, 'first', 'the running turn stays current while the prompt waits')

    page = { messages: [user(sessionID, 'bridge-a', 'first'), assistant(sessionID, 'reply-a', 'working on it'), user(sessionID, 'bridge-b', 'second', true)], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)

    // Switching Session and back remounts the view; the conversation must still not treat the
    // queued prompt as its current turn.
    registration.dispose()
    // A remount starts from a fresh controller that rebuilds the turns from its first page, as the
    // view does; the daemon's queued flag is what keeps the waiting prompt out of them.
    registration = registerNativeSessionV3Adapter(target(sessionID), () => {})
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY)
    const remounted = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(remounted.turns.map((turn) => turn.prompt), ['first'])
    assert.equal(remounted.currentTurn.prompt, 'first')

    page = { messages: [
      user(sessionID, 'bridge-a', 'first'),
      assistant(sessionID, 'reply-a', 'done'),
      user(sessionID, 'bridge-b', 'second'),
      assistant(sessionID, 'reply-b', 'starting the second')
    ], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    const after = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(after.turns.length, 2, 'the dequeued prompt became a turn')
    assert.equal(after.currentTurn.prompt, 'second', 'and it is now the current turn')
    assert.equal(after.currentTurn.id.endsWith(':native-user:bridge-b'), true, 'identified by its native row after the remount')
  } finally {
    registration.dispose()
    restore()
  }
})

test('a queued row this client never sent is adopted, and a Stop discards waiting prompts', async () => {
  storage.clear()
  const sessionID = 'queued-session-2'
  let page = { messages: [
    user(sessionID, 'native-1', 'running elsewhere'),
    assistant(sessionID, 'reply-1', 'thinking'),
    user(sessionID, 'native-2', 'queued elsewhere', true)
  ], hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [sessionID]: { type: 'busy' } })
  respondWith([{ status: 'accepted', clientRequestId: 'stop-1' }])

  const registration = registerNativeSessionV3Adapter(target(sessionID), () => {})
  try {
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY)
    let conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['running elsewhere'], 'the initial page never turns a queued row into a turn')

    page = { messages: [
      user(sessionID, 'native-1', 'running elsewhere'),
      assistant(sessionID, 'reply-1', 'done'),
      user(sessionID, 'native-2', 'queued elsewhere'),
      assistant(sessionID, 'reply-2', 'now on it')
    ], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['running elsewhere', 'queued elsewhere'])

    page = { messages: [...page.messages, user(sessionID, 'native-3', 'third', true)], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    await registration.controller.stopConversation(CONFIG, registration.conversation.id)
    page = { messages: page.messages.slice(0, -1), hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.turns.some((turn) => turn.prompt === 'third'), false, 'a stopped queued prompt never becomes a turn')
  } finally {
    registration.dispose()
    restore()
    if (originalStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = originalStorage
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})

test('Send now keeps a queued request tracked until the tail clears queued and promotes it exactly once', async () => {
  storage.clear()
  const sessionID = 'queued-send-now-session'
  let page = { messages: [], hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [sessionID]: { type: 'busy' } })
  const registration = registerNativeSessionV3Adapter(target(sessionID), () => {})
  let sendNowCalls = 0
  api.sendQueuedPromptNow = async () => {
    sendNowCalls += 1
    return { disposition: 'steered', messageID: 'bridge-queued-now' }
  }

  try {
    const { clientRequestId } = await startQueuedPrompt(registration, sessionID, 'wait for me', 'request-queued-now', 'bridge-queued-now')
    page = { messages: [user(sessionID, 'bridge-queued-now', 'wait for me', true)], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)

    await registration.controller.sendQueuedPromptNow(CONFIG, registration.conversation.id, 'bridge-queued-now')
    assert.equal(sendNowCalls, 1)
    let conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.turns.length, 1, 'the queued entry remains pending while the tail still marks it queued')
    assert.equal(conversation.currentTurn.prompt, 'already running')

    page = { messages: [user(sessionID, 'bridge-queued-now', 'wait for me')], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.turns.length, 2)
    assert.equal(conversation.currentTurn.id, `${registration.conversation.id}:request:${clientRequestId}`)
    assert.equal(conversation.currentTurn.prompt, 'wait for me')

    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.turns.length, 2, 'a second tail refresh does not create another turn')
    assert.equal(conversation.turns.filter((turn) => turn.id === `${registration.conversation.id}:request:${clientRequestId}`).length, 1)
  } finally {
    registration.dispose()
    restore()
  }
})

test('a queued row edited by another client updates the tracked prompt from the tail', async () => {
  storage.clear()
  const sessionID = 'queued-external-edit-session'
  let page = { messages: [], hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [sessionID]: { type: 'busy' } })
  const registration = registerNativeSessionV3Adapter(target(sessionID), () => {})

  try {
    const { clientRequestId } = await startQueuedPrompt(registration, sessionID, 'original queued text', 'request-external-edit', 'bridge-external-edit')
    page = { messages: [user(sessionID, 'bridge-external-edit', 'original queued text', true)], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)

    // Another client edits the daemon row. This controller learns about it from the authoritative tail.
    page = { messages: [user(sessionID, 'bridge-external-edit', 'edited in another window', true)], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    page = { messages: [user(sessionID, 'bridge-external-edit', 'edited in another window')], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)

    const conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.turns.length, 2)
    assert.equal(conversation.currentTurn.id, `${registration.conversation.id}:request:${clientRequestId}`)
    assert.equal(conversation.currentTurn.prompt, 'edited in another window')
  } finally {
    registration.dispose()
    restore()
  }
})

test('a failed queued-row edit leaves the tracked entry available for tail promotion', async () => {
  storage.clear()
  const sessionID = 'queued-edit-failure-session'
  let page = { messages: [], hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [sessionID]: { type: 'busy' } })
  api.editQueuedPrompt = async () => { throw new Error('edit rejected') }
  const registration = registerNativeSessionV3Adapter(target(sessionID), () => {})

  try {
    const { clientRequestId } = await startQueuedPrompt(registration, sessionID, 'keep this prompt', 'request-edit-failure', 'bridge-edit-failure')
    page = { messages: [user(sessionID, 'bridge-edit-failure', 'keep this prompt', true)], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)

    await assert.rejects(
      registration.controller.editQueuedPrompt(CONFIG, registration.conversation.id, 'bridge-edit-failure', 'rejected edit'),
      /edit rejected/
    )
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    let conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.turns.length, 1, 'a failed edit keeps the row queued')

    page = { messages: [user(sessionID, 'bridge-edit-failure', 'keep this prompt')], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.turns.length, 2)
    assert.equal(conversation.currentTurn.id, `${registration.conversation.id}:request:${clientRequestId}`, 'the failed edit did not discard the request identity')
    assert.equal(conversation.currentTurn.prompt, 'keep this prompt')
  } finally {
    registration.dispose()
    restore()
  }
})
