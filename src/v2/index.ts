/**
 * OpenCode v2 plugin entry for opencode-peers.
 *
 * V2 calls setup() on the default export; v1 calls server() (see
 * src/index.ts, which combines both). Everything durable — registry,
 * spool, outbox, listener, transport — is shared with the v1 entry; only
 * the host integration surface differs:
 *
 *   - session discovery is event-driven (ctx.event.subscribe) plus the
 *     session "prompt" hook, because ctx.session has no list/status APIs
 *   - injection goes through ctx.session.synthetic with a deterministic
 *     message id
 *   - permissions use the ctx.permission "evaluate" hook instead of
 *     watching permission events and replying over HTTP
 *   - tools and commands register through their transform editors
 */

import type { Plugin } from "@opencode/plugin/promise/plugin"
import { resolveConfig, defaultPeerName } from "../config.js"
import { Registry, newInboxToken, newInstanceId } from "../registry.js"
import { InboxListener } from "../listener.js"
import { RateLimiter } from "../queue.js"
import { Outbox } from "../outbox.js"
import { Sender } from "../sender.js"
import { LocalTransport } from "../transport.js"
import { errorMessage } from "../feedback.js"
import type { InboundPolicy, Logger, PluginConfig, ReceiveStatus } from "../types.js"
import { V2SessionRuntime } from "./runtime.js"
import { V2PeerPermissions } from "./permissions.js"
import { registerPeerTools } from "./tools.js"
import { registerPeerCommands } from "./commands.js"

const PLUGIN_VERSION = "0.1.0"

/**
 * The v2 plugin context has no logging API; write to the console with a
 * service prefix and never throw.
 */
export function createConsoleLogger(): Logger {
  return async (level, message, extra) => {
    try {
      const detail = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : ""
      const line = `[opencode-peers] ${level}: ${message}${detail}`
      if (level === "warn" || level === "error") console.error(line)
      else console.log(line)
    } catch {
      // Logging must never interrupt messaging.
    }
  }
}

export const peersV2Plugin: Plugin = {
  id: "opencode-peers",

  async setup(ctx) {
    const logger = createConsoleLogger()
    const config = resolveConfig(ctx.options as Partial<PluginConfig> | undefined)
    const directory = ctx.location.directory

    const instanceId = newInstanceId()
    const inboxToken = newInboxToken()

    // Default name: <dir-name>-<hex4> (matches Claude Code's "my-app-3f"
    // pattern). Only auto-generated names get the suffix; an explicit
    // config.name or /peers-name override replaces it entirely.
    let currentName = config.name || defaultPeerName(directory, instanceId)
    let policy: InboundPolicy = config.inboundPolicy
    const runtime = V2SessionRuntime({
      session: ctx.session,
      config,
      directory,
      name: () => currentName,
      logger,
    })

    const recvLimit = RateLimiter(config.recvRatePerMin)
    const sendLimit = RateLimiter(config.sendRatePerMin)
    const outbox = Outbox({ storageDir: config.storageDir })
    let dispatchAcknowledgements: () => Promise<void> = async () => {}

    const listener = InboxListener({
      token: inboxToken,
      maxBodyBytes: config.maxMessageBytes * 2 + 4096,
      maxMessageBytes: config.maxMessageBytes,
      maxMessageAgeMs: config.maxMessageAgeMs,
      processId: instanceId,
      resolveEndpoint: async ({ version, toEndpointId }) => {
        const resolve = () =>
          version === 1
            ? runtime.compatibilityEndpointId()
            : toEndpointId && runtime.hasEndpoint(toEndpointId)
              ? toEndpointId
              : null
        const immediate = resolve()
        if (immediate) return immediate
        // Startup window: the listener is up before deferred session
        // recovery finishes. Wait (bounded) for it instead of returning a
        // terminal 404 for an endpoint that exists moments later.
        let timeout: ReturnType<typeof setTimeout> | null = null
        try {
          await Promise.race([
            runtime.whenReady(),
            new Promise<void>((res) => {
              timeout = setTimeout(res, 10_000)
              timeout.unref?.()
            }),
          ])
        } finally {
          if (timeout) clearTimeout(timeout)
        }
        return resolve()
      },
      logger,
      onMessage: async (msg, endpointId): Promise<ReceiveStatus> => {
        if (!recvLimit(msg.from.instanceId)) return "full"
        const status = await runtime.receive(msg, endpointId!, policy)
        // Fire-and-forget, but never let a rejection escape: an unhandled
        // rejection would crash the host opencode process.
        void dispatchAcknowledgements().catch((err) =>
          logger("warn", "acknowledgement dispatch failed; will retry", { error: String(err) })
        )
        return status
      },
      onAcknowledgement: async (acknowledgement) => {
        if (!(await outbox.applyAcknowledgement(acknowledgement))) {
          await logger("warn", "ignored unmatched peer acknowledgement", {
            messageId: acknowledgement.messageId,
            fromEndpointId: acknowledgement.fromEndpointId,
            toEndpointId: acknowledgement.toEndpointId,
          })
        }
      },
    })

    const { url: transportUrl, compatibilityUrl: inboxUrl, address: transport } = await listener.start()

    const latestEndpoint = () => {
      const compatibilityId = runtime.compatibilityEndpointId()
      return runtime.registryEndpoints().find((endpoint) => endpoint.endpointId === compatibilityId)
    }

    const registry = Registry({
      peersDir: config.peersDir,
      instanceId,
      pid: process.pid,
      directory,
      serverUrl: "", // informational only; v2 has no server URL on the context
      inboxUrl,
      inboxToken,
      pluginVersion: PLUGIN_VERSION,
      heartbeatMs: config.heartbeatMs,
      staleMs: config.staleMs,
      getDynamic: () => {
        const latest = latestEndpoint()
        return {
          name: currentName,
          inboundPolicy: policy,
          activeSessionId: latest?.sessionId ?? null,
          activeSessionTitle: latest?.title ?? null,
          busy: latest ? latest.status !== "idle" : false,
          queuedCount: latest?.queuedCount ?? 0,
        }
      },
      getEndpoints: runtime.registryEndpoints,
      getCompatibilityEndpointId: runtime.compatibilityEndpointId,
      transport,
      peerPermissions: config.peerPermissions,
      logger,
    })

    await registry.start()

    const acknowledgementTransport = LocalTransport()
    dispatchAcknowledgements = async (): Promise<void> => {
      const pending = runtime.pendingAcknowledgements()
      if (pending.length === 0) return
      const peers = await registry.list()
      for (const { queue, acknowledgement } of pending) {
        const target = peers.find((peer) => peer.alive && peer.entry.version === 2 &&
          peer.entry.endpointId === acknowledgement.fromEndpointId)?.entry
        if (!target || target.version !== 2) continue
        try {
          await acknowledgementTransport.ack(target, acknowledgement)
          await queue.markAcknowledgementSent(acknowledgement)
        } catch (err) {
          await logger("warn", "failed to return peer acknowledgement; will retry", {
            error: String(err),
            messageId: acknowledgement.messageId,
            senderEndpointId: acknowledgement.fromEndpointId,
          })
        }
      }
    }

    const sender = Sender({
      self: {
        get instanceId() {
          return instanceId
        },
        get name() {
          return currentName
        },
        directory,
      },
      outbox,
    })

    const sweepReliability = async (): Promise<void> => {
      if (disposing) return
      try {
        await runtime.sweep()
        await dispatchAcknowledgements()
      } catch (err) {
        await logger("error", "reliability sweep failed", { error: errorMessage(err) })
      }
    }

    const permissions = V2PeerPermissions({
      session: ctx.session,
      mode: () => config.peerPermissions,
      directory,
      logger,
    })

    let disposing = false
    let cleanupPromise: Promise<void> | null = null
    let discoveryTimer: ReturnType<typeof setTimeout> | null = null
    const registrations: Array<{ dispose: () => Promise<void> }> = []
    const eventAbort = new AbortController()

    // Fallback sweep: session.idle is not guaranteed on every
    // version/scenario, so retry deliveries periodically as a safety net.
    const sweeper = setInterval(() => {
      void sweepReliability()
    }, config.sweepMs)
    sweeper.unref?.()

    // Peer-triggered permission auto-resolution (replaces v1's
    // permission.asked event watch + HTTP reply).
    registrations.push(
      await ctx.permission.hook("evaluate", (event) => permissions.evaluate(event))
    )

    // "noteActivity" signal: fires for every admitted USER prompt (never
    // for synthetic injections, so peer messages cannot feed back).
    registrations.push(
      await ctx.session.hook("prompt", async (event) => {
        if (disposing) return
        await runtime.noteActivity(event.sessionID)
        if (!disposing) await registry.heartbeat()
      })
    )

    // The three LLM-callable tools (shared handlers, v2 registration shape).
    registrations.push(
      await ctx.tool.transform((editor) =>
        registerPeerTools(editor, {
          registry,
          sender,
          sendLimit,
          maxMessageBytes: config.maxMessageBytes,
          selfName: () => currentName,
          selfInstanceId: instanceId,
          endpointForSession: (sessionId) => {
            const endpointId = runtime.endpointIdForSession(sessionId)
            const endpoint = runtime.registryEndpoints().find((entry) => entry.sessionId === sessionId)
            return endpointId && endpoint
              ? { endpointId, name: endpoint.name, directory: endpoint.directory }
              : null
          },
          outbox,
        })
      )
    )

    registrations.push(
      await ctx.command.transform((editor) =>
        registerPeerCommands(editor, {
          session: ctx.session,
          runtime,
          registry,
          outbox,
          getName: () => currentName,
          setName: async (name) => {
            currentName = name
            await registry.heartbeat()
            return { name, changed: false }
          },
          selfInstanceId: instanceId,
          dispatchAcknowledgements,
          disposing: () => disposing,
          logger: (level, message, extra) => logger(level, message, extra),
        })
      )
    )

    // Server-wide event stream (no replay): endpoint upsert/removal and
    // busy/idle transitions. Directory filtering happens in the runtime.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventAbort.signal })) {
          if (disposing) break
          const changed = await runtime.handleEvent(event)
          if (changed && !disposing) await registry.heartbeat()
        }
      } catch (err) {
        if (!disposing) {
          await logger("warn", "event stream failed", { error: String(err) })
        }
      }
    })()

    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise
      disposing = true
      eventAbort.abort()
      if (discoveryTimer) clearTimeout(discoveryTimer)
      discoveryTimer = null
      clearInterval(sweeper)
      cleanupPromise = Promise.all([
        registry.stop(),
        runtime.stop(),
        listener.stop(),
        acknowledgementTransport.close(),
        ...registrations.map((registration) => registration.dispose()),
      ]).then(() => undefined)
      return cleanupPromise
    }

    await logger("info", "opencode-peers started", {
      instanceId,
      name: currentName,
      inboxUrl,
      transportUrl,
      policy,
    })

    // Avoid touching the host's session APIs while it is still constructing
    // this plugin; recover spool state only after bootstrap unwinds.
    discoveryTimer = setTimeout(() => {
      discoveryTimer = null
      if (disposing) return
      void runtime.initialize()
        .then(async () => {
          if (!disposing) await registry.heartbeat()
        })
        .catch((err) => logger("warn", "deferred session recovery failed", { error: String(err) }))
    }, 0)
    discoveryTimer.unref?.()

    return cleanup
  },
}
