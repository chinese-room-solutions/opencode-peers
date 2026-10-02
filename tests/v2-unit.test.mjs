import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../dist/config.js"
import { createSessionMessageQueue } from "../dist/queue.js"
import { deterministicPeerMessageId } from "../dist/delivery.js"
import { SessionTracker } from "../dist/session-tracker.js"
import { V2SessionRuntime } from "../dist/v2/runtime.js"
import { V2Delivery } from "../dist/v2/delivery.js"
import { V2PeerPermissions } from "../dist/v2/permissions.js"
import { registerPeerTools } from "../dist/v2/tools.js"
import { registerPeerCommands, commandArguments } from "../dist/v2/commands.js"
import { peersV2Plugin } from "../dist/v2/index.js"
import pluginModule from "../dist/index.js"

const noopLogger = async () => {}
const DIRECTORY = "/workspace/project"

const session = (id, over = {}) => ({
  id,
  title: `session ${id}`,
  time: { created: Date.now() - 60_000, updated: Date.now() - 1_000 },
  location: { directory: DIRECTORY },
  ...over,
})

const message = (id, text = `hello ${id}`) => ({
  id,
  from: { instanceId: "ses_sender", name: "sender", directory: "/workspace/sender" },
  text,
  via: ["ses_sender"],
  sentAt: Date.now(),
})

const event = (type, data, over = {}) => ({
  id: `evt_${type}_${JSON.stringify(data)}`,
  created: Date.now(),
  type,
  location: { directory: DIRECTORY },
  data,
  ...over,
})

function fakeSessionDomain({ sessions = new Map(), contexts = new Map() } = {}) {
  const syntheticCalls = []
  const promptCalls = []
  const contextCalls = []
  const getCalls = []
  return {
    syntheticCalls,
    promptCalls,
    contextCalls,
    getCalls,
    sessions,
    contexts,
    async get({ sessionID }) {
      getCalls.push(sessionID)
      const info = sessions.get(sessionID)
      if (!info) throw new Error(`session ${sessionID} not found`)
      return info
    },
    async synthetic(input) {
      syntheticCalls.push(input)
      return { id: input.id ?? "msg_generated", sessionID: input.sessionID, type: "synthetic" }
    },
    async context({ sessionID }) {
      contextCalls.push(sessionID)
      return contexts.get(sessionID) ?? []
    },
    async prompt(input) {
      promptCalls.push(input)
      return {}
    },
  }
}

/** Pushable async iterable standing in for ctx.event.subscribe. */
function makeEventStream() {
  const queue = []
  const waiters = []
  let ended = false
  const settle = () => waiters.splice(0).forEach((resolve) => resolve())
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0 && !ended) await new Promise((resolve) => waiters.push(resolve))
          if (queue.length > 0) return { value: queue.shift(), done: false }
          return { done: true }
        },
      }
    },
  }
  return {
    stream,
    push: (value) => {
      queue.push(value)
      settle()
    },
    end: () => {
      ended = true
      settle()
    },
  }
}

test("dual-package default export carries v2 setup and v1 server", async () => {
  assert.equal(pluginModule.id, "opencode-peers")
  assert.equal(typeof pluginModule.setup, "function")
  assert.equal(typeof pluginModule.server, "function")
  assert.equal(peersV2Plugin.id, "opencode-peers")
  assert.equal(pluginModule.setup, peersV2Plugin.setup)
})

test("v2 runtime adopts sessions by events, filters directories, and cascades deletes", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-v2-runtime-"))
  try {
    const domain = fakeSessionDomain({
      sessions: new Map([
        ["ses_root", session("ses_root")],
        ["ses_child", session("ses_child", { parentID: "ses_root" })],
        ["ses_foreign", session("ses_foreign", { location: { directory: "/workspace/other" } })],
      ]),
    })
    const runtime = V2SessionRuntime({
      session: domain,
      config: resolveConfig({ storageDir }),
      directory: DIRECTORY,
      name: () => "project",
      logger: noopLogger,
    })

    // created events upsert endpoints
    assert.equal(await runtime.handleEvent(event("session.created", { sessionID: "ses_root" })), true)
    assert.equal(await runtime.handleEvent(event("session.created", { sessionID: "ses_child" })), true)
    let endpoints = runtime.registryEndpoints()
    assert.deepEqual(endpoints.map((entry) => entry.sessionId).sort(), ["ses_child", "ses_root"])
    assert.equal(endpoints.find((entry) => entry.sessionId === "ses_child").parentSessionId, "ses_root")
    assert.ok(endpoints.every((entry) => entry.name === "project"))

    // events from another location are ignored (stream is server-wide)
    assert.equal(
      await runtime.handleEvent(event("session.created", { sessionID: "ses_elsewhere" }, { location: { directory: "/workspace/other" } })),
      false
    )
    // ...and so are same-envelope events whose session lives elsewhere
    assert.equal(await runtime.handleEvent(event("session.created", { sessionID: "ses_foreign" })), false)
    assert.equal(runtime.registryEndpoints().length, 2)

    // busy/idle transitions via execution events
    assert.equal(await runtime.handleEvent(event("session.execution.started", { sessionID: "ses_root" })), true)
    assert.equal(runtime.registryEndpoints().find((entry) => entry.sessionId === "ses_root").status, "busy")
    assert.equal(await runtime.handleEvent(event("session.execution.succeeded", { sessionID: "ses_root" })), true)
    assert.equal(runtime.registryEndpoints().find((entry) => entry.sessionId === "ses_root").status, "idle")
    assert.equal(await runtime.handleEvent(event("session.execution.failed", { sessionID: "ses_root" })), true)
    assert.equal(runtime.registryEndpoints().find((entry) => entry.sessionId === "ses_root").status, "idle")

    // renames refresh the registry title
    assert.equal(await runtime.handleEvent(event("session.renamed", { sessionID: "ses_root", title: "renamed!" })), true)
    assert.equal(runtime.registryEndpoints().find((entry) => entry.sessionId === "ses_root").title, "renamed!")
    assert.equal(await runtime.handleEvent(event("session.renamed", { sessionID: "ses_root", title: "renamed!" })), false)

    // the prompt hook path marks activity busy
    await runtime.noteActivity("ses_child")
    assert.equal(runtime.registryEndpoints().find((entry) => entry.sessionId === "ses_child").status, "busy")

    // delete cascades to children by parentID
    assert.equal(await runtime.handleEvent(event("session.deleted", { sessionID: "ses_root" })), true)
    endpoints = runtime.registryEndpoints()
    assert.equal(endpoints.length, 0)
    assert.equal(runtime.hasEndpoint("ses_root"), false)
    assert.equal(runtime.endpointIdForSession("ses_child"), null)
    await runtime.stop()
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("v2 receive injects via synthetic with a deterministic id and peerMessage metadata", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-v2-receive-"))
  try {
    const domain = fakeSessionDomain({ sessions: new Map([["ses_root", session("ses_root")]]) })
    const runtime = V2SessionRuntime({
      session: domain,
      config: resolveConfig({ storageDir }),
      directory: DIRECTORY,
      name: () => "project",
      logger: noopLogger,
    })
    await runtime.handleEvent(event("session.created", { sessionID: "ses_root" }))

    const msg = message("peer-1", "the API contract changed")
    assert.equal(await runtime.receive(msg, "ses_root", "accept"), "delivered")
    assert.equal(domain.syntheticCalls.length, 1)
    const call = domain.syntheticCalls[0]
    assert.equal(call.sessionID, "ses_root")
    assert.equal(call.id, deterministicPeerMessageId("ses_root", msg))
    assert.match(call.id, /^msg_/)
    assert.deepEqual(call.metadata.peerMessage, {
      version: 2,
      messageId: "peer-1",
      fromEndpointId: "ses_sender",
      toSessionId: "ses_root",
    })
    assert.match(call.text, /the API contract changed/)
    assert.match(call.text, /peer message from "sender"/)
    assert.equal(call.delivery, "steer")

    // retries are idempotent end to end: same message returns the recorded
    // outcome and never triggers a second injection
    assert.equal(await runtime.receive(msg, "ses_root", "accept"), "delivered")
    assert.equal(domain.syntheticCalls.length, 1)
    await runtime.stop()
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("v2 startup recovers undelivered spool records for sessions that still exist", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-v2-spool-"))
  try {
    const config = resolveConfig({ storageDir })
    // A previous run left an undelivered record for ses_root and one for a
    // session that no longer exists on this server.
    const queue = createSessionMessageQueue({ config, sessionId: "ses_root", logger: noopLogger })
    assert.equal(queue.enqueue(message("recover-me")), true)
    const ghost = createSessionMessageQueue({ config, sessionId: "ses_ghost", logger: noopLogger })
    assert.equal(ghost.enqueue(message("ghost-msg")), true)

    const domain = fakeSessionDomain({
      sessions: new Map([["ses_root", session("ses_root", { time: { created: 1, updated: 2 } })]]),
    })
    const runtime = V2SessionRuntime({
      session: domain,
      config,
      directory: DIRECTORY,
      name: () => "project",
      logger: noopLogger,
    })
    await runtime.initialize()
    await runtime.whenReady()

    const endpoints = runtime.registryEndpoints()
    assert.deepEqual(endpoints.map((entry) => entry.sessionId), ["ses_root"])
    // restart recovery flushed the queued record through synthetic
    assert.equal(domain.syntheticCalls.length, 1)
    assert.equal(domain.syntheticCalls[0].metadata.peerMessage.messageId, "recover-me")
    await runtime.stop()
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("v2 delivery notices inject only while idle; plain injection carries no id", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-v2-notice-"))
  try {
    const domain = fakeSessionDomain()
    const tracker = SessionTracker()
    tracker.noteIdle("ses_x")
    const queue = createSessionMessageQueue({ config: resolveConfig({ storageDir }), sessionId: "ses_x", logger: noopLogger })
    const delivery = V2Delivery({
      session: domain,
      sessionId: "ses_x",
      tracker,
      queue,
      directory: DIRECTORY,
      logger: noopLogger,
      immediate: true,
    })

    await delivery.notice("📥 Held message from \"sender\"")
    assert.equal(domain.syntheticCalls.length, 1)
    assert.equal(domain.syntheticCalls[0].metadata.peerMessage, true)
    assert.match(domain.syntheticCalls[0].text, /\[notification from opencode-peers\]/)
    assert.equal(domain.syntheticCalls[0].id, undefined)

    tracker.noteBusy("ses_x")
    await delivery.notice("busy-time notice")
    assert.equal(domain.syntheticCalls.length, 1) // skipped while busy
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

// ---- permissions ----------------------------------------------------------------

const evaluation = (over = {}) => ({
  sessionID: "ses_1",
  action: "bash",
  resources: ["*"],
  source: { type: "tool", messageID: "asst_1", id: "call_1" },
  effect: "ask",
  ...over,
})

const peerContext = [
  { id: "user_1", type: "user", metadata: { peerMessage: { version: 2, messageId: "m1", fromEndpointId: "ses_peer", toSessionId: "ses_1" } } },
  { id: "asst_1", type: "assistant", metadata: {} },
]
const localContext = [
  { id: "user_1", type: "user", metadata: {} },
  { id: "asst_1", type: "assistant", metadata: {} },
]

function makePermissions({ context = peerContext, mode = "allow", sessionDirectory = DIRECTORY } = {}) {
  const domain = fakeSessionDomain({
    sessions: new Map([["ses_1", session("ses_1", { location: { directory: sessionDirectory } })]]),
    contexts: new Map([["ses_1", context]]),
  })
  const inst = V2PeerPermissions({
    session: domain,
    mode: () => mode,
    directory: DIRECTORY,
    logger: noopLogger,
  })
  return { inst, domain }
}

test("v2 permission evaluate: allow upgrades only peer-triggered ask decisions", async () => {
  const { inst } = makePermissions()
  const peer = evaluation()
  await inst.evaluate(peer)
  assert.equal(peer.effect, "allow")

  const local = evaluation()
  // local turn: preceding user message has no peerMessage metadata
  await makePermissions({ context: localContext }).inst.evaluate(local)
  assert.equal(local.effect, "ask")

  // a native deny is never overridden
  const denied = evaluation({ effect: "deny" })
  await inst.evaluate(denied)
  assert.equal(denied.effect, "deny")

  // a session in another location's directory is never mutated: the v2
  // evaluate hook is server-wide, and v1's per-process scope must not
  // leak across projects sharing one service
  const foreign = evaluation()
  await makePermissions({ sessionDirectory: "/workspace/other-project" }).inst.evaluate(foreign)
  assert.equal(foreign.effect, "ask")

  // an existing native allow is left untouched
  const allowed = evaluation({ effect: "allow" })
  await inst.evaluate(allowed)
  assert.equal(allowed.effect, "allow")
})

test("v2 permission evaluate: protected categories are never auto-approved but deny still rejects", async () => {
  const protectedEval = () => evaluation({ action: "write", resources: ["/home/me/project/AGENTS.md"] })
  const allow = makePermissions()
  const a = protectedEval()
  await allow.inst.evaluate(a)
  assert.equal(a.effect, "ask")

  // v1 parity: the carve-out only withholds auto-approval; auto-deny
  // still rejects peer-triggered requests in protected categories.
  const deny = makePermissions({ mode: "deny" })
  const d = protectedEval()
  await deny.inst.evaluate(d)
  assert.equal(d.effect, "deny")
})

test("v2 permission evaluate: ask never mutates, deny rejects peer turns", async () => {
  const ask = makePermissions({ mode: "ask" })
  const a = evaluation()
  await ask.inst.evaluate(a)
  assert.equal(a.effect, "ask")
  assert.equal(ask.domain.contextCalls.length, 0) // no lookup at all

  const deny = makePermissions({ mode: "deny" })
  const peer = evaluation()
  await deny.inst.evaluate(peer)
  assert.equal(peer.effect, "deny")

  const local = evaluation()
  await makePermissions({ mode: "deny", context: localContext }).inst.evaluate(local)
  assert.equal(local.effect, "ask")
})

test("v2 permission evaluate: not-yet-visible messages are transient and re-evaluated", async () => {
  const domain = fakeSessionDomain({
    sessions: new Map([["ses_1", session("ses_1")]]),
    contexts: new Map([["ses_1", peerContext]]),
  })
  const inst = V2PeerPermissions({ session: domain, mode: () => "allow", directory: DIRECTORY, logger: noopLogger })

  // source message not in the context snapshot yet: no mutation...
  const transient = evaluation({ source: { type: "tool", messageID: "asst_new", id: "call_2" } })
  await inst.evaluate(transient)
  assert.equal(transient.effect, "ask")

  // ...and the unstable verdict was not cached: once visible it applies
  domain.contexts.set("ses_1", [
    ...peerContext,
    { id: "user_2", type: "user", metadata: { peerMessage: { version: 2, messageId: "m2", fromEndpointId: "ses_peer", toSessionId: "ses_1" } } },
    { id: "asst_new", type: "assistant", metadata: {} },
  ])
  const retry = evaluation({ source: { type: "tool", messageID: "asst_new", id: "call_2" } })
  await inst.evaluate(retry)
  assert.equal(retry.effect, "allow")
})

test("v2 permission evaluate: requests without a tool source are ignored", async () => {
  const { inst } = makePermissions()
  const noSource = evaluation({ source: undefined })
  await inst.evaluate(noSource)
  assert.equal(noSource.effect, "ask")
})

// ---- tools ----------------------------------------------------------------------

function captureEditor() {
  const added = []
  return { added, add: (definition) => added.push(definition) }
}

const peerEntry = (over = {}) => ({
  version: 2,
  endpointId: "ses_beta",
  processId: "proc_b",
  pid: process.pid,
  sessionId: "ses_beta",
  title: "beta",
  name: "beta",
  hostname: "h",
  directory: "/tmp/b",
  status: "idle",
  transport: { type: "tcp", host: "127.0.0.1", port: 1 },
  serverUrl: "",
  inboxUrl: "http://127.0.0.1:1",
  inboxToken: "t",
  capabilities: ["local"],
  timestamps: { startedAt: Date.now(), updatedAt: Date.now(), heartbeatAt: Date.now() },
  policy: { inboundPolicy: "accept", peerPermissions: "allow" },
  pluginVersion: "0.3.0",
  activeSessionId: "ses_beta",
  activeSessionTitle: "beta",
  busy: false,
  queuedCount: 0,
  inboundPolicy: "accept",
  startedAt: Date.now(),
  heartbeatAt: Date.now(),
  ...over,
})

function makeToolDeps(over = {}) {
  const sendCalls = []
  return {
    deps: {
      registry: { list: async () => [{ entry: peerEntry(), alive: true, staleReason: null }] },
      sender: {
        send: async (entry, text) => {
          sendCalls.push({ entry, text })
          return { ok: true, status: "delivered", messageId: "track-1" }
        },
      },
      sendLimit: () => true,
      maxMessageBytes: 8192,
      selfName: () => "alpha",
      selfInstanceId: "ses_alpha",
      endpointForSession: () => ({ endpointId: "ses_alpha", name: "alpha", directory: "/tmp/a" }),
      ...over,
    },
    sendCalls,
  }
}

test("v2 tool transform registers the three peer tools with JSON Schema inputs", async () => {
  const editor = captureEditor()
  const { deps } = makeToolDeps()
  registerPeerTools(editor, deps)

  assert.deepEqual(editor.added.map((tool) => tool.name).sort(), ["list_agents", "peer_message_status", "send_message"])
  const send = editor.added.find((tool) => tool.name === "send_message")
  assert.equal(send.input.type, "object")
  assert.equal(send.input.properties.to.type, "string")
  assert.deepEqual(send.input.required.sort(), ["message", "to"])

  const listing = await editor.added.find((tool) => tool.name === "list_agents").execute({}, { sessionID: "ses_alpha" })
  assert.match(listing.content, /1 peer\(s\) online/)
  assert.match(listing.content, /"beta"/)
  assert.match(listing.content, /You are "alpha"/)

  const result = await send.execute({ to: "beta", message: "ping" }, { sessionID: "ses_alpha" })
  assert.deepEqual(result, { content: 'Message delivered to "beta". Tracking ID: track-1.' })
})

// ---- commands -------------------------------------------------------------------

function makeCommandDeps({ sessions = new Map([["ses_1", session("ses_1")]]) } = {}) {
  const domain = fakeSessionDomain({ sessions })
  const config = resolveConfig({ storageDir: join(tmpdir(), `peers-v2-commands-${Date.now()}-${Math.random().toString(16).slice(2)}`) })
  const queue = createSessionMessageQueue({ config, sessionId: "ses_1", logger: noopLogger })
  const runtime = V2SessionRuntime({
    session: domain,
    config,
    directory: DIRECTORY,
    name: () => "alpha",
    logger: noopLogger,
  })
  const renamed = []
  return {
    domain,
    runtime,
    deps: {
      session: domain,
      runtime,
      registry: { list: async () => [], heartbeat: async () => {} },
      outbox: { list: () => [] },
      getName: () => "alpha",
      setName: async (name) => {
        renamed.push(name)
        return { name, changed: false }
      },
      selfInstanceId: "ses_alpha",
      dispatchAcknowledgements: async () => {},
      logger: noopLogger,
    },
    renamed,
  }
}

test("v2 command transform registers executors that prompt results inline", async () => {
  const editor = captureEditor()
  const { deps, domain, renamed } = makeCommandDeps()
  registerPeerCommands(editor, deps)
  assert.deepEqual(
    editor.added.map((command) => command.name),
    ["peers", "list-agents", "peers-name", "peers-inbox", "peers-outbox"]
  )

  // noteActivity runs before execution, creating the session endpoint
  const name = editor.added.find((command) => command.name === "peers-name")
  await name.execute({ sessionID: "ses_1", prompt: { text: "/peers-name frontend" }, delivery: "steer" })
  assert.deepEqual(renamed, ["frontend"])
  assert.equal(domain.promptCalls.length, 1)
  const prompt = domain.promptCalls[0]
  assert.equal(prompt.sessionID, "ses_1")
  assert.equal(prompt.delivery, "steer")
  assert.match(prompt.text, /This command was already handled by the opencode-peers plugin\. Show the following result to the user verbatim, then stop:/)
  assert.match(prompt.text, /Renamed to "frontend"\./)
  assert.equal(deps.runtime.endpointIdForSession("ses_1"), "ses_1")

  // /peers lists through the shared command logic
  const peers = editor.added.find((command) => command.name === "peers")
  await peers.execute({ sessionID: "ses_1", prompt: { text: "/peers" }, delivery: "steer" })
  assert.match(domain.promptCalls.at(-1).text, /📋/)
  await deps.runtime.stop()
})

test("commandArguments tolerates prompt text with and without the command", () => {
  assert.equal(commandArguments("/peers-name frontend"), "frontend")
  assert.equal(commandArguments("/peers-inbox accept 2"), "accept 2")
  assert.equal(commandArguments("/peers"), "")
  assert.equal(commandArguments("frontend"), "frontend")
  assert.equal(commandArguments(undefined), "")
})

// ---- plugin-level wiring ----------------------------------------------------------

test("peersV2Plugin.setup wires hooks, transforms, events, and cleanup end to end", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "peers-v2-plugin-"))
  let cleanup
  try {
    const domain = fakeSessionDomain({
      sessions: new Map([
        ["ses_root", session("ses_root")],
        ["ses_child", session("ses_child", { parentID: "ses_root" })],
      ]),
      contexts: new Map([
        ["ses_root", [
          { id: "user_1", type: "user", metadata: { peerMessage: { version: 2, messageId: "m1", fromEndpointId: "ses_peer", toSessionId: "ses_root" } } },
          { id: "asst_1", type: "assistant", metadata: {} },
        ]],
      ]),
    })
    const channel = makeEventStream()
    const permissionHook = []
    const promptHook = []
    const registration = { dispose: async () => {} }
    const toolEditors = []
    const commandEditors = []
    const ctx = {
      app: { name: "opencode", version: "2.0.18", channel: "stable" },
      location: {
        directory: DIRECTORY,
        project: { id: "project-1", directory: DIRECTORY, canonical: DIRECTORY },
      },
      options: { storageDir, sweepMs: 60_000, heartbeatMs: 60_000 },
      session: {
        ...domain,
        hook: async (name, callback) => {
          promptHook.push({ name, callback })
          return registration
        },
      },
      permission: {
        hook: async (name, callback) => {
          permissionHook.push({ name, callback })
          return registration
        },
      },
      tool: {
        transform: async (callback) => {
          toolEditors.push(callback)
          return registration
        },
      },
      command: {
        transform: async (callback) => {
          commandEditors.push(callback)
          return registration
        },
      },
      event: {
        subscribe: ({ signal } = {}) => {
          if (signal) signal.addEventListener("abort", () => channel.end(), { once: true })
          return channel.stream
        },
      },
    }

    cleanup = await peersV2Plugin.setup(ctx)

    // permission evaluate + session prompt hooks registered
    assert.equal(permissionHook[0].name, "evaluate")
    assert.equal(promptHook[0].name, "prompt")

    // tools and commands land in their editors
    const toolEditor = captureEditor()
    for (const transform of toolEditors) transform(toolEditor)
    assert.deepEqual(toolEditor.added.map((tool) => tool.name).sort(), ["list_agents", "peer_message_status", "send_message"])
    const commandEditor = captureEditor()
    for (const transform of commandEditors) transform(commandEditor)
    assert.equal(commandEditor.added.length, 5)

    // user prompt -> endpoint upsert + registry publication
    await promptHook[0].callback({ sessionID: "ses_root" })
    const registryFiles = await readdir(join(storageDir, "peers.d"))
    assert.ok(registryFiles.some((file) => file.endsWith(".v2.json")))

    // events drive discovery
    channel.push(event("session.created", { sessionID: "ses_child" }))
    for (let attempt = 0; attempt < 50; attempt++) {
      const peers = await readdir(join(storageDir, "peers.d"))
      if (peers.filter((file) => file.endsWith(".v2.json")).length >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await readdir(join(storageDir, "peers.d"))).filter((file) => file.endsWith(".v2.json")).length, 2)

    // peer-triggered permission within the plugin wiring auto-allows
    const decision = { sessionID: "ses_root", action: "bash", resources: ["*"], source: { type: "tool", messageID: "asst_1", id: "call_1" }, effect: "ask" }
    await permissionHook[0].callback(decision)
    assert.equal(decision.effect, "allow")

    // inbound peer message over the real listener reaches synthetic
    // (exercised end to end by the runtime tests); here we only confirm no
    // synthetic injections happened from the prompt/event wiring itself
    // (no feedback loop).
    assert.equal(domain.syntheticCalls.length, 0)

    await cleanup()
    cleanup = null
    assert.equal((await readdir(join(storageDir, "peers.d"))).filter((file) => file.endsWith(".json")).length, 0)
  } finally {
    await cleanup?.()
    await rm(storageDir, { recursive: true, force: true })
  }
})
