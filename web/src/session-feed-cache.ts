import { BoundedDataCache } from "./bounded-data-cache"
import type { MessageEnvelope, ModelSelection, ServerConfig } from "./types"

export type SessionFeed = {
  messages: MessageEnvelope[]
  before?: string
  hasMore: boolean
  model?: ModelSelection
}

// Keys are private in-memory values; never persist/log them because credentials partition users.
export function sessionDataScope(config: ServerConfig, sessionID: string, directory?: string): string {
  return JSON.stringify([config.host, config.port, config.backend, config.agentId ?? "", config.username,
    config.password, directory ?? "", sessionID])
}

export const sessionFeedCache = new BoundedDataCache<SessionFeed>(16 * 1024 * 1024, 2 * 1024 * 1024, 64)
