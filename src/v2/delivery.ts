/**
 * V2 delivery: inject durable queued messages into one exact local session
 * via ctx.session.synthetic, mirroring src/delivery.ts.
 *
 * A deterministic message id (must match ^msg_) makes retries idempotent —
 * the same peer message can never be injected twice. The peerMessage
 * metadata is persisted on the synthetic message and is what the V2
 * permission provenance walk (src/v2/permissions.ts) detects.
 */

import type { InboundMessage, Logger } from "../types.js"
import type { QueueInstance } from "../queue.js"
import type { SessionTrackerInstance } from "../session-tracker.js"
import { deterministicPeerMessageId, formatMessages } from "../delivery.js"

/** Structural port of ctx.session.synthetic. */
export interface V2SyntheticSession {
  synthetic(input: {
    sessionID: string
    id?: string | null
    text: string
    description?: string | null
    metadata?: Record<string, unknown> | null
    delivery?: "steer" | "queue" | null
  }): Promise<unknown>
}

export interface V2DeliveryOptions {
  session: V2SyntheticSession
  sessionId: string
  tracker: SessionTrackerInstance
  queue: QueueInstance
  directory: string
  logger: Logger
  /** Protocol-v2 delivery targets this session immediately, even while busy. */
  immediate?: boolean
  /**
   * Max time one synthetic injection may take before it is treated as a
   * delivery failure and the message is requeued. Default 30s.
   */
  injectTimeoutMs?: number
}

export interface V2DeliveryInstance {
  /** Flush queued messages. Returns true when at least one message was delivered. */
  flush: () => Promise<boolean>
  /**
   * Show a display-only notification inline (e.g. "held message awaiting
   * review"). Injected only when the session is idle; otherwise it is
   * logged and skipped — the same information is visible via /peers.
   */
  notice: (text: string) => Promise<void>
}

// Mirrors the private NOTICE_FOOTER in src/delivery.ts (kept byte-identical
// there; duplicated because v1 sources are frozen).
const NOTICE_FOOTER =
  "---\n" +
  "This is an automated notification from the opencode-peers plugin. " +
  "Show it to the user verbatim, then stop. Do not take further action."

const DEFAULT_INJECT_TIMEOUT_MS = 30_000

export function V2Delivery(opts: V2DeliveryOptions): V2DeliveryInstance {
  let flushing = false
  const injectTimeoutMs = opts.injectTimeoutMs ?? DEFAULT_INJECT_TIMEOUT_MS

  /** Race the synthetic call against a timeout; on expiry the call is abandoned and treated as a failure. */
  function withTimeout<T>(call: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const expiry = new Promise<never>((_, reject) => {
      // Deliberately NOT unref'd: when the call genuinely hangs this timer
      // may be the only thing that can unblock the delivery chain.
      timer = setTimeout(() => reject(new Error(`synthetic injection timed out after ${injectTimeoutMs}ms`)), injectTimeoutMs)
    })
    return Promise.race([call, expiry]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  async function inject(text: string, message?: InboundMessage): Promise<void> {
    await withTimeout(opts.session.synthetic({
      sessionID: opts.sessionId,
      ...(message ? { id: deterministicPeerMessageId(opts.sessionId, message) } : {}),
      text,
      metadata: {
        peerMessage: message ? {
          version: 2,
          messageId: message.id,
          fromEndpointId: message.from.instanceId,
          toSessionId: opts.sessionId,
        } : true,
      },
      delivery: "steer",
    }))
  }

  async function flushOnce(): Promise<boolean> {
    if (flushing) return false
    const sessionId = opts.tracker.activeSessionId()
    if (!sessionId) return false
    if (opts.queue.size() === 0) return false
    if (!opts.immediate && !opts.tracker.isIdle()) return false

    flushing = true
    try {
      const messages = opts.queue.drain()
      if (opts.immediate) {
        let delivered = 0
        for (let index = 0; index < messages.length; index++) {
          const message = messages[index]
          try {
            await inject(formatMessages([message]), message)
            await opts.queue.complete([message])
            delivered++
          } catch (err) {
            await opts.queue.requeue(messages.slice(index))
            await opts.logger("error", "failed to deliver peer message", {
              error: String(err),
              sessionId,
              messageId: message.id,
            })
            return delivered > 0
          }
        }
        await opts.logger("info", "delivered peer messages", { count: delivered, sessionId })
        return delivered > 0
      }
      try {
        await inject(formatMessages(messages))
        await opts.queue.complete(messages)
        await opts.logger("info", "delivered peer messages", {
          count: messages.length,
          sessionId,
        })
        return true
      } catch (err) {
        // Put messages back (order preserved) so a later flush can retry.
        await opts.queue.requeue(messages)
        await opts.logger("error", "failed to deliver peer messages", {
          error: String(err),
          sessionId,
        })
        return false
      }
    } finally {
      flushing = false
    }
  }

  let immediateTail: Promise<boolean> = Promise.resolve(false)

  return {
    flush() {
      if (!opts.immediate) return flushOnce()
      const pending = immediateTail.then(flushOnce, flushOnce)
      immediateTail = pending.catch(() => false)
      return pending
    },

    async notice(text: string) {
      if (!opts.tracker.isIdle()) {
        await opts.logger("debug", "notice skipped (session busy)", { text })
        return
      }
      const sessionId = opts.tracker.activeSessionId()
      if (!sessionId) {
        await opts.logger("debug", "notice skipped (no active session)", { text })
        return
      }
      try {
        await inject(
          `[notification from opencode-peers]\n${text}\n\n${NOTICE_FOOTER}`
        )
      } catch (err) {
        await opts.logger("warn", "failed to deliver notice", {
          error: String(err),
          sessionId,
        })
      }
    },
  }
}
