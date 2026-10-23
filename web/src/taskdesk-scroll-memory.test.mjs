import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const component = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")
const controller = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")
const observer = readFileSync(new URL("./components/native-session-observer.tsx", import.meta.url), "utf8")

test("reopening a recent transcript restores its scroll instead of jumping to the bottom", () => {
  // A per-Session, LRU-capped module store remembers the position ...
  assert.match(component, /scrollMemory\s*=\s*new Map/, "remembers scroll position in a module store")
  assert.match(component, /SCROLL_MEMORY_LIMIT/, "the remembered positions are bounded so a long session list does not leak")
  assert.match(component, /function writeScrollMemory\(/, "persists the position while scrolling and on unmount")
  assert.match(component, /function readScrollMemory\(/, "reads the remembered position")
  // ... and a re-opened transcript seeds its bottom-intent from that position instead of hard-true.
  assert.doesNotMatch(component, /nearBottomRef\s*=\s*useRef\(true\)/, "does not hard-start every transcript at the bottom")
  assert.match(component, /nearBottomRef\s*=\s*useRef\(restoreScrollRef\.current\?\.nearBottom \?\? true\)/, "seeds the bottom-intent from the remembered position")
  assert.match(component, /const restoredRef/, "restores the exact saved position at most once per mount")
  // The in-memory store cannot survive a reload or PWA teardown, so the remembered positions must be
  // mirrored to a durable store and rehydrated on the next open.
  assert.match(component, /SCROLL_MEMORY_STORAGE_KEY/, "persists the remembered position to localStorage")
  assert.match(component, /scrollMemoryHydrated/, "rehydrates the in-memory store after a reload")
})

test("the scroll memory is keyed per Session and written back to the shared transcript", () => {
  // The owning Session identity flows down the chain; an omitted scope means "no memory" (old behavior).
  assert.match(observer, /scrollScope=\{target\.key\}/, "the observer keys memory per Session")
  assert.match(controller, /scrollScope=\{scrollScope\}/, "the controller forwards the scope to the shared transcript")
  assert.match(component, /writeScrollMemory\(scrollScope, element/, "the transcript writes its position back when scrolling")
  assert.match(component, /onScroll=\{\(event\)/, "the scroll handler is where position is persisted")
})

test("the scroll scope participates in the transcript memo comparator", () => {
  // scrollScope is stable per mount, so it must not cause a diff, but must be part of the contract.
  assert.match(component, /previous\.scrollScope === next\.scrollScope/, "scroll scope is part of transcriptPropsEqual")
})
