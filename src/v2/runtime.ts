/**
 * V2 session runtime: endpoint bookkeeping for the OpenCode v2 plugin
 * context (src/v2/index.ts), mirroring src/session-runtime.ts.
 *
 * The v2 plugin context has no session.list/status APIs, so discovery is
 * event-driven instead of polled:
 *
 *   - session.created / deleted (with child cascade) upsert and remove
 *     endpoints; session.execution.* and session.idle drive busy/idle
 *   - the session "prompt" hook (wired in src/v2/index.ts) marks activity
 *   - startup spool recovery adopts sessions holding undelivered records
 *     (restart recovery, same intent as v1's initialize())
 *
 * The event stream is server-wide, so every event is filtered to this
 * plugin's own location directory. Sessions are not enumerable in v2;
 * only sessions with signs of life are advertised — which the README
 * already promises.
 */

import { readdir } from "node:fs/promises"
import type { ResolvedConfig } from "../config.js"
import { gateMessage } from "../gating.js"
import {
  createSessionMessageQueue,
  hasSpoolRecords,
  migrateWorkspaceSpool,
  stableSpoolEndpointId,
  type QueueInstance,
} from "../queue.js"
import type { RegistryEndpoint } from "../registry.js"
import { sameDirectory } from "../format.js"
import { SessionTracker, type SessionTrackerInstance } from "../session-tracker.js"
import type {
  InboundMessage,
  InboundPolicy,
  Logger,
  PeerAcknowledgementV2,
  ReceiveStatus,
  SessionEndpointStatus,
} from "../types.js"
import { V2Delivery, type V2DeliveryInstance, type V2SyntheticSession } from "./delivery.js"

/** Session.Info fields the runtime consumes (structural port of ctx.session.get). */
export interface V2SessionInfo {
  id: string
  parentID?: string
  title?: string
  time: { created: number; updated: number }
  location: { directory: string }
}

/** Envelope shape of the v2 server event stream (structural port). */
export interface V2ServerEvent {
  type: string
  location?: { directory: string }
  data?: Record<string, unknown> | null
}

/** Structural port of the ctx.session methods the runtime needs. */
export interface V2SessionReader {
  get(input: { sessionID: string }): Promise<V2SessionInfo>
}

/** Everything the runtime itself plus its per-session deliveries need. */
export interface V2SessionPort extends V2SessionReader, V2SyntheticSession {}

export interface V2SessionRuntimeOptions {
  session: V2SessionPort
  config: ResolvedConfig
  directory: string
  name: () => string
  logger: Logger
}

interface RuntimeEndpoint {
  session: V2SessionInfo
  endpointId: string
  status: SessionEndpointStatus
  updatedAt: number
  queue: QueueInstance
  delivery: V2DeliveryInstance
  tracker: SessionTrackerInstance
}

export interface V2SessionRuntimeInstance {
  initialize: () => Promise<void>
  /** Resolves once the first initialize() attempt has settled (never rejects). */
  whenReady: () => Promise<void>
  stop: () => Promise<void>
  registryEndpoints: () => RegistryEndpoint[]
  compatibilityEndpointId: () => string | null
  hasEndpoint: (endpointId: string) => boolean
  endpointIdForSession: (sessionId: string) => string | null
  receive: (message: InboundMessage, endpointId: string, policy: InboundPolicy) => Promise<ReceiveStatus>
  handleEvent: (event: V2ServerEvent) => Promise<boolean>
  noteActivity: (sessionId: string) => Promise<void>
  queueForSession: (sessionId: string) => QueueInstance | null
  deliveryForSession: (sessionId: string) => V2DeliveryInstance | null
  sweep: () => Promise<void>
  pendingAcknowledgements: () => Array<{ queue: QueueInstance; acknowledgement: PeerAcknowledgementV2 }>
}

export function V2SessionRuntime(opts: V2SessionRuntimeOptions): V2SessionRuntimeInstance {
  const endpoints = new Map<string, RuntimeEndpoint>()
  const pendingOperations = new Set<Promise<unknown>>()
  let lifecycle: "running" | "stopping" | "stopped" = "running"
  let stopPromise: Promise<void> | null = null
  let readyPromise: Promise<void> | null = null
  let markReady: () => void = () => {}
  // True when a legacy workspace spool holds records but no adoptable target
  // session existed at startup; the first endpoint creation migrates it.
  let migrationPending = false

  function whileRunning<T>(fallback: T, operation: () => Promise<T>): Promise<T> {
    if (lifecycle !== "running") return Promise.resolve(fallback)
    const pending = operation()
    pendingOperations.add(pending)
    void pending.finally(() => pendingOperations.delete(pending)).catch(() => {})
    return pending
  }

  function compatibilityEndpoint(candidates = [...endpoints.values()]): RuntimeEndpoint | null {
    const roots = candidates.filter((candidate) => !candidate.session.parentID)
    return (roots.length > 0 ? roots : candidates).slice().sort((a, b) =>
      b.updatedAt - a.updatedAt ||
      b.session.time.created - a.session.time.created ||
      b.session.id.localeCompare(a.session.id)
    )[0] ?? null
  }

  async function maybeMigrateWorkspaceSpool(session: V2SessionInfo): Promise<void> {
    if (!migrationPending) return
    migrationPending = false
    try {
      await migrateWorkspaceSpool({
        config: opts.config,
        directory: opts.directory,
        targetSessionId: session.id,
        logger: opts.logger,
      })
    } catch (err) {
      migrationPending = true
      await opts.logger("warn", "workspace spool migration failed; will retry", {
        error: String(err),
        targetSessionId: session.id,
      })
    }
  }

  async function upsert(
    session: V2SessionInfo,
    status?: SessionEndpointStatus
  ): Promise<RuntimeEndpoint> {
    const current = endpoints.get(session.id)
    if (current) {
      current.session = session
      current.updatedAt = Math.max(current.updatedAt, session.time.updated)
      if (status) setStatus(current, status)
      return current
    }

    const queue = createSessionMessageQueue({ config: opts.config, sessionId: session.id, logger: opts.logger })
    await queue.loadHeld()
    const tracker = SessionTracker()
    tracker.noteIdle(session.id)
    const endpoint: RuntimeEndpoint = {
      session,
      endpointId: session.id,
      status: status ?? "idle",
      updatedAt: session.time.updated,
      queue,
      tracker,
      delivery: undefined as unknown as V2DeliveryInstance,
    }
    if (endpoint.status !== "idle") tracker.noteBusy(session.id)
    endpoint.delivery = V2Delivery({
      session: opts.session,
      sessionId: session.id,
      tracker,
      queue,
      directory: session.location?.directory || opts.directory,
      logger: opts.logger,
      immediate: true,
    })
    endpoints.set(session.id, endpoint)
    await maybeMigrateWorkspaceSpool(session)
    return endpoint
  }

  function setStatus(endpoint: RuntimeEndpoint, status: SessionEndpointStatus): void {
    endpoint.status = status
    endpoint.updatedAt = Math.max(endpoint.updatedAt, Date.now())
    if (status === "idle") endpoint.tracker.noteIdle(endpoint.session.id)
    else endpoint.tracker.noteBusy(endpoint.session.id)
  }

  /**
   * No event replay exists in v2, so stale-history protection matters less
   * than in v1; it still guards against adopting long-dead sessions that
   * appear through cross-location noise.
   */
  function staleHistory(session: V2SessionInfo): boolean {
    return !endpoints.has(session.id) &&
      session.time.updated < Date.now() - 2 * opts.config.staleMs
  }

  async function fetchSession(sessionId: string): Promise<V2SessionInfo | null> {
    try {
      const session = await opts.session.get({ sessionID: sessionId })
      if (!session?.id) return null
      if (!sameDirectory(session.location?.directory || opts.directory, opts.directory)) return null
      return session
    } catch {
      return null
    }
  }

  async function findSession(sessionId: string): Promise<RuntimeEndpoint | null> {
    const known = endpoints.get(sessionId)
    if (known) return known
    const session = await fetchSession(sessionId)
    if (!session || staleHistory(session)) return null
    return upsert(session)
  }

  /** Spool session dirs that hold any records (queued/held/inflight/done). */
  async function listSpoolSessionIds(): Promise<string[]> {
    try {
      const entries = await readdir(opts.config.spoolDir)
      return entries.filter((sessionId) => hasSpoolRecords(opts.config, sessionId))
    } catch {
      return []
    }
  }

  return {
    initialize() {
      if (!readyPromise) {
        readyPromise = new Promise<void>((resolve) => {
          markReady = resolve
        })
      }
      return whileRunning(undefined, async () => {
        // Restart recovery: adopt sessions with undelivered peer state.
        // done/ records count too — post-restart retries must dedupe, and
        // loadHeld() needs them for that. Nothing else is enumerable in v2.
        const candidates = await listSpoolSessionIds()
        const sessions: V2SessionInfo[] = []
        for (const sessionId of candidates) {
          const session = await fetchSession(sessionId)
          if (session) sessions.push(session)
        }
        if (sessions.length > 0) {
          const roots = sessions.filter((candidate) => !candidate.parentID)
          const target = (roots.length > 0 ? roots : sessions).slice().sort((a, b) =>
            b.time.updated - a.time.updated || b.time.created - a.time.created || b.id.localeCompare(b.id)
          )[0]
          try {
            await migrateWorkspaceSpool({
              config: opts.config,
              directory: opts.directory,
              targetSessionId: target.id,
              logger: opts.logger,
            })
          } catch (err) {
            await opts.logger("warn", "workspace spool migration failed", { error: String(err) })
          }
          for (const session of sessions) {
            const endpoint = await upsert(session)
            // Deliver what the previous run could not.
            await endpoint.delivery.flush()
          }
        } else if (hasSpoolRecords(opts.config, stableSpoolEndpointId(opts.directory))) {
          // Legacy workspace spool exists but no session to migrate into yet;
          // migrate lazily when the first endpoint appears.
          migrationPending = true
        }
      }).finally(() => markReady())
    },

    whenReady() {
      // Ready means "the first discovery pass has settled". Never rejects;
      // callers should bound their wait if a hang would be a problem.
      if (!readyPromise) {
        readyPromise = new Promise<void>((resolve) => {
          markReady = resolve
        })
      }
      return readyPromise
    },

    stop() {
      if (stopPromise) return stopPromise
      lifecycle = "stopping"
      markReady() // release whenReady waiters; no discovery will happen now
      stopPromise = (async () => {
        await Promise.allSettled([...pendingOperations])
        lifecycle = "stopped"
      })()
      return stopPromise
    },

    registryEndpoints() {
      return [...endpoints.values()].map((endpoint) => ({
        endpointId: endpoint.endpointId,
        sessionId: endpoint.session.id,
        ...(endpoint.session.parentID ? { parentSessionId: endpoint.session.parentID } : {}),
        title: endpoint.session.title ?? "",
        name: opts.name(),
        directory: endpoint.session.location?.directory || opts.directory,
        status: endpoint.status,
        startedAt: endpoint.session.time.created,
        updatedAt: endpoint.updatedAt,
        queuedCount: endpoint.queue.size(),
      }))
    },

    compatibilityEndpointId() {
      return compatibilityEndpoint()?.endpointId ?? null
    },

    hasEndpoint(endpointId) {
      return [...endpoints.values()].some((endpoint) => endpoint.endpointId === endpointId)
    },

    endpointIdForSession(sessionId) {
      return endpoints.get(sessionId)?.endpointId ?? null
    },

    receive(message, endpointId, policy) {
      return whileRunning<ReceiveStatus>("dropped", async () => {
        const endpoint = [...endpoints.values()].find((candidate) => candidate.endpointId === endpointId)
        if (!endpoint) return "dropped"
        const existing = endpoint.queue.existingStatus(message)
        if (existing) return existing
        if (endpoint.queue.isDebounced(message)) return "duplicate"
        const decision = gateMessage(policy, message, endpoint.session.location?.directory || opts.directory)
        if (decision === "refuse") return (await endpoint.queue.refuse(message)).status
        if (decision === "hold") {
          if (!(await endpoint.queue.hold(message))) return "full"
          void endpoint.delivery.notice(`📥 Held message from "${message.from.name}" — /peers-inbox to review`)
          return "held"
        }
        if (!endpoint.queue.enqueue(message)) return endpoint.queue.existingStatus(message) ?? "full"
        await endpoint.delivery.flush()
        return endpoint.queue.existingStatus(message) ?? "queued"
      })
    },

    async handleEvent(event) {
      return whileRunning(false, async () => {
        // The stream is server-wide; ignore other locations' sessions.
        if (event.location && !sameDirectory(event.location.directory, opts.directory)) return false
        const data = (event.data ?? {}) as Record<string, unknown>
        const sessionId = typeof data.sessionID === "string" ? data.sessionID : null
        if (!sessionId) return false

        if (event.type === "session.created") {
          const endpoint = await findSession(sessionId)
          return Boolean(endpoint)
        }
        if (event.type === "session.deleted") {
          const deleted = new Set([sessionId])
          let changed = true
          while (changed) {
            changed = false
            for (const endpoint of endpoints.values()) {
              if (endpoint.session.parentID && deleted.has(endpoint.session.parentID) && !deleted.has(endpoint.session.id)) {
                deleted.add(endpoint.session.id)
                changed = true
              }
            }
          }
          let removed = false
          for (const id of deleted) {
            if (endpoints.delete(id)) removed = true
          }
          return removed
        }
        if (event.type === "session.renamed") {
          const endpoint = endpoints.get(sessionId) ?? (await findSession(sessionId))
          if (!endpoint) return false
          const title = typeof data.title === "string" ? data.title : null
          if (!title || endpoint.session.title === title) return false
          endpoint.session = { ...endpoint.session, title }
          endpoint.updatedAt = Math.max(endpoint.updatedAt, Date.now())
          return true
        }
        if (
          event.type === "session.execution.started" ||
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed" ||
          event.type === "session.execution.interrupted" ||
          event.type === "session.idle"
        ) {
          const status: SessionEndpointStatus = event.type === "session.execution.started" ? "busy" : "idle"
          const endpoint = endpoints.get(sessionId) ?? (await findSession(sessionId))
          if (!endpoint) return false
          if (endpoint.status !== status) setStatus(endpoint, status)
          return true
        }
        return false
      })
    },

    noteActivity(sessionId) {
      return whileRunning(undefined, async () => {
        const known = endpoints.get(sessionId)
        // Genuine user activity is a sign of life even for an old session,
        // so the prompt hook bypasses the stale-history guard.
        const session = known?.session ?? (await fetchSession(sessionId))
        if (!session) return
        const endpoint = known ?? (await upsert(session))
        setStatus(endpoint, "busy")
      })
    },

    queueForSession(sessionId) {
      return endpoints.get(sessionId)?.queue ?? null
    },

    deliveryForSession(sessionId) {
      return endpoints.get(sessionId)?.delivery ?? null
    },

    sweep() {
      return whileRunning(undefined, async () => {
        for (const endpoint of endpoints.values()) {
          await endpoint.queue.expireHeld()
          await endpoint.delivery.flush()
        }
      })
    },

    pendingAcknowledgements() {
      return [...endpoints.values()].flatMap((endpoint) => endpoint.queue.pendingAcknowledgements()
        .map((acknowledgement) => ({ queue: endpoint.queue, acknowledgement })))
    },
  }
}
