/**
 * V2 auto-resolution of permission requests that originate from a
 * peer-triggered turn, mirroring src/permissions.ts.
 *
 * The v2 plugin context replaces v1's permission.asked event-watch plus
 * HTTP-reply hack with a first-class evaluate hook: the callback receives
 * the evaluation and may mutate `event.effect`. The README's security
 * semantics are preserved exactly:
 *
 *   - mode "allow": effect becomes "allow" ONLY when the turn is
 *     peer-triggered AND the current effect is "ask" (a native "deny" —
 *     or an existing "allow" — is never overridden)
 *   - mode "deny": effect becomes "deny" when the turn is peer-triggered
 *     (protected or not — the carve-out only withholds auto-approval)
 *   - mode "ask": never mutates
 *   - protected categories (isProtectedPermission) are never auto-APPROVED
 *     and stay under OpenCode's native policy/UI
 *
 * Provenance: ctx.session.context returns the session's ordered, flat
 * message list (no parentID links). From the assistant message holding the
 * tool call (event.source.messageID) the walk scans BACKWARD to the nearest
 * preceding user/synthetic message and checks its metadata.peerMessage —
 * the metadata V2 delivery stamps on every injected peer message.
 */

import { isProtectedPermission } from "../permissions.js"
import { sameDirectory } from "../format.js"
import type { Logger, PeerPermissionMode } from "../types.js"

/** Structural port of the context messages ctx.session.context returns. */
export interface V2ContextMessage {
  id: string
  type: string
  metadata?: Record<string, unknown> | null
}

/** Structural port of ctx.session.context. */
export interface V2ContextReader {
  context(input: { sessionID: string }): Promise<V2ContextMessage[]>
}

/** Structural port of ctx.session.get (directory resolution only). */
export interface V2SessionLookup {
  get(input: { sessionID: string }): Promise<{ location?: { directory?: string } | null }>
}

/** Structural port of the permission evaluate event. */
export interface V2PermissionEvaluation {
  sessionID: string
  agent?: string
  action: string
  resources: ReadonlyArray<string>
  metadata?: Record<string, unknown>
  source?: { type: string; messageID?: string; id?: string }
  effect: "allow" | "deny" | "ask"
  message?: string
}

export interface V2PeerPermissionsOptions {
  session: V2ContextReader & V2SessionLookup
  /** Read dynamically so a future config reload could change behavior. */
  mode: () => PeerPermissionMode
  directory: string
  logger: Logger
}

export interface V2PeerPermissionsInstance {
  /** Register as ctx.permission.hook("evaluate", permissions.evaluate). */
  evaluate: (event: V2PermissionEvaluation) => Promise<void>
}

const CACHE_CAP = 200

export function V2PeerPermissions(opts: V2PeerPermissionsOptions): V2PeerPermissionsInstance {
  // messageID -> whether that message's turn is peer-triggered. Verdicts are
  // stable per message, and one turn typically raises several permission
  // requests against the same messageID.
  const turnCache = new Map<string, boolean>()
  // sessionID -> whether the session belongs to this plugin's location. The
  // v2 evaluate hook is server-wide, so a shared service running several
  // projects must not have every location's plugin instance mutate every
  // evaluation (v1 never faced this: its process WAS the directory scope).
  const ownsCache = new Map<string, boolean>()

  async function ownsSession(sessionID: string): Promise<boolean> {
    const hit = ownsCache.get(sessionID)
    if (hit !== undefined) return hit
    let owns: boolean
    try {
      const session = await opts.session.get({ sessionID })
      owns = sameDirectory(session?.location?.directory || opts.directory, opts.directory)
    } catch {
      return false // transient failure: stay out of the way, do not cache
    }
    if (ownsCache.size >= CACHE_CAP) {
      const oldest = ownsCache.keys().next().value
      if (oldest !== undefined) ownsCache.delete(oldest)
    }
    ownsCache.set(sessionID, owns)
    return owns
  }

  function peerMetadata(message: V2ContextMessage | undefined): unknown {
    return message?.metadata?.peerMessage
  }

  async function isPeerTurn(sessionID: string, messageID: string): Promise<boolean> {
    const key = `${sessionID}:${messageID}`
    const hit = turnCache.get(key)
    if (hit !== undefined) return hit
    let verdict = false
    let transient = false
    try {
      const messages = await opts.session.context({ sessionID })
      const index = messages.findIndex((message) => message.id === messageID)
      if (index === -1) {
        // Message not visible yet (evaluation raced storage) — the verdict
        // is not stable, so do not cache it.
        transient = true
      } else {
        for (let cursor = index; cursor >= 0; cursor--) {
          const message = messages[cursor]
          if (message.type !== "user" && message.type !== "synthetic") continue
          verdict = Boolean(peerMetadata(message))
          break
        }
      }
    } catch (err) {
      // Context unreadable, server unreachable, ... — stay out of the way.
      await opts.logger("debug", "peer-message lookup failed; leaving permission to default", {
        error: String(err),
        sessionID,
        messageID,
      })
      return false // not cached: a transient failure may succeed next time
    }
    if (transient) return false // not cached: re-evaluate on the next event
    if (turnCache.size >= CACHE_CAP) {
      const oldest = turnCache.keys().next().value
      if (oldest !== undefined) turnCache.delete(oldest)
    }
    turnCache.set(key, verdict)
    return verdict
  }

  return {
    async evaluate(event) {
      const mode = opts.mode()
      if (mode === "ask") return
      if (event.source?.type !== "tool" || !event.source.messageID) return
      if (!event.sessionID) return
      // Only evaluate for sessions in this plugin's own location directory.
      if (!(await ownsSession(event.sessionID))) return

      if (!(await isPeerTurn(event.sessionID, event.source.messageID))) return

      const props = {
        permission: event.action,
        action: event.action,
        resources: [...event.resources],
        ...(event.metadata ? { metadata: event.metadata } : {}),
      }

      if (mode === "allow") {
        // v1 parity: the protected-category carve-out only withholds
        // auto-APPROVAL — auto-deny still rejects peer-triggered requests.
        if (isProtectedPermission(props)) {
          await opts.logger("warn", "protected peer permission left to OpenCode policy", {
            permission: event.action,
            sessionID: event.sessionID,
          })
          return
        }
        // Never override a native "deny" (or an already-granted "allow").
        if (event.effect !== "ask") return
        event.effect = "allow"
      } else {
        event.effect = "deny"
      }
      await opts.logger("info", `auto-${mode} permission in peer-triggered turn`, {
        permission: event.action,
        sessionID: event.sessionID,
      })
    },
  }
}
