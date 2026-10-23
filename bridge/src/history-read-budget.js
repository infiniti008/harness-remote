import { performance } from "node:perf_hooks"

export class HistoryReadError extends Error {
  constructor(message, code = "HISTORY_READ_LIMIT", status = 413) {
    super(message)
    this.name = "HistoryReadError"
    this.code = code
    this.status = status
  }
}

export function isHistoryReadError(error) {
  return error instanceof HistoryReadError || ["HISTORY_READ_LIMIT", "HISTORY_READ_BUSY", "INVALID_HISTORY_CURSOR"].includes(error?.code)
}

/** Limits journal viewing only; never imposes a deadline on an agent's turn. */
export class HistoryReadBudget {
  constructor({ maxReadBytes = 32 * 1024 * 1024, maxLineBytes = 16 * 1024 * 1024,
    maxTextBytes = 4 * 1024 * 1024, maxMessages = 10_000, maxDurationMs = 20_000 } = {}) {
    Object.assign(this, { maxReadBytes, maxLineBytes, maxTextBytes, maxMessages })
    this.deadline = performance.now() + maxDurationMs
    this.readBytes = 0
    this.textBytes = 0
    this.messages = 0
  }

  check() {
    if (performance.now() > this.deadline) throw new HistoryReadError("History read exceeded its time budget; existing history was not changed")
  }

  read(bytes) {
    this.check()
    this.readBytes += bytes
    if (this.readBytes > this.maxReadBytes) throw new HistoryReadError("History read exceeded its byte budget; use a smaller page")
  }

  line(bytes) {
    this.check()
    if (bytes > this.maxLineBytes) throw new HistoryReadError("A history record exceeds the safe record size")
  }

  message(message) {
    this.check()
    this.messages++
    // Account for UTF-16 retained text without allocating a second encoded copy.
    this.textBytes += 512 + message.parts.reduce((sum, part) => sum + (part.text?.length || 0) * 2 + 128, 0)
    if (this.messages > this.maxMessages || this.textBytes > this.maxTextBytes) {
      throw new HistoryReadError("History output exceeds the safe window size; use a smaller page")
    }
  }
}

/** A shared gate bounds cold reads across every session handled by this loader. */
export class HistoryReadGate {
  constructor({ maxActive = 1, maxQueued = 8 } = {}) {
    this.maxActive = maxActive
    this.maxQueued = maxQueued
    this.active = 0
    this.waiters = []
  }

  async run(work) {
    if (this.active >= this.maxActive) {
      if (this.waiters.length >= this.maxQueued) throw new HistoryReadError("History reader is busy; retry shortly", "HISTORY_READ_BUSY", 503)
      await new Promise((resolve) => this.waiters.push(resolve))
    } else this.active++
    try { return await work() }
    finally {
      const next = this.waiters.shift()
      if (next) next()
      else this.active--
    }
  }

  diagnostics() { return { active: this.active, queued: this.waiters.length, maxActive: this.maxActive, maxQueued: this.maxQueued } }
}
