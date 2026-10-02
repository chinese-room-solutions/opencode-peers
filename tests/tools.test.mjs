import { test } from "node:test"
import assert from "node:assert/strict"
import { buildPeerTools, formatPeerList } from "../dist/tools/peers-tools.js"
import { RateLimiter } from "../dist/queue.js"

const peerEntry = (over = {}) => ({
  version: 1,
  instanceId: "bbbb2222",
  name: "beta",
  pid: 1234,
  hostname: "h",
  directory: "/tmp/b",
  serverUrl: "http://127.0.0.1:1",
  inboxUrl: "http://127.0.0.1:2",
  inboxToken: "t",
  activeSessionId: "ses_x",
  activeSessionTitle: "fix bug",
  inboundPolicy: "accept",
  startedAt: Date.now(),
  heartbeatAt: Date.now(),
  pluginVersion: "0.1.0",
  ...over,
})

function makeRegistry(listed) {
  return { list: async () => listed }
}

function makeSender(result) {
  const calls = []
  return {
    calls,
    send: async (entry, text) => {
      calls.push({ entry, text })
      return result
    },
  }
}

function makeTools({ listed = [], sendResult = { ok: true, status: "delivered" }, over = {} }) {
  const sender = makeSender(sendResult)
  const tools = buildPeerTools({
    registry: makeRegistry(listed),
    sender,
    sendLimit: RateLimiter(100),
    maxMessageBytes: 8192,
    selfName: () => "alpha",
    selfInstanceId: "aaaa1111",
    ...over,
  })
  return { tools, sender }
}

test("peer_message_status returns durable final and pending states for the invoking session", async () => {
  const records = [
    { messageId: "done-1", toName: "beta", toEndpointId: "session-beta", receiptStatus: "held", finalStatus: "delivered", createdAt: 1 },
    { messageId: "wait-1", toName: "gamma", toEndpointId: "session-gamma", receiptStatus: "held", createdAt: 2 },
  ]
  const { tools } = makeTools({ over: {
    endpointForSession: () => ({ endpointId: "session-alpha", name: "alpha", directory: "/tmp/a" }),
    outbox: { get: (_endpoint, id) => records.find((r) => r.messageId === id) ?? null, list: () => records },
  } })
  assert.match(await tools.peer_message_status.execute({ message_id: "done-1" }, { sessionID: "ses-a" }), /final: delivered/)
  assert.match(await tools.peer_message_status.execute({ message_id: "wait-1" }, { sessionID: "ses-a" }), /awaiting final ACK/)
  assert.match(await tools.peer_message_status.execute({ message_id: "missing" }, { sessionID: "ses-a" }), /not found/)
})

test("list_agents hides offline peers by default, includes them on request", async () => {
  const listed = [
    { entry: peerEntry(), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "dead0000", name: "ghost" }), alive: false, staleReason: "pid dead" },
  ]
  const { tools } = makeTools({ listed })
  const online = await tools.list_agents.execute({}, {})
  assert.match(online, /1 peer\(s\) online/)
  assert.match(online, /"beta"/)
  assert.doesNotMatch(online, /ghost/)
  assert.match(online, /You are "alpha"/)

  const all = await tools.list_agents.execute({ include_offline: true }, {})
  assert.match(all, /ghost/)
  assert.match(all, /pid dead/)
})

test("formatPeerList renders empty state", () => {
  const out = formatPeerList([], "alpha", "aaaa1111")
  assert.match(out, /No peers online/)
})

const NOW = Date.now()

function v2Entry(over = {}) {
  return {
    version: 2,
    endpointId: "ses_main",
    processId: "process-1",
    pid: process.pid,
    sessionId: "ses_main",
    parentSessionId: null,
    title: "main session",
    name: "worker",
    hostname: "h",
    directory: "/tmp/v2",
    status: "idle",
    transport: { type: "unix", path: "/tmp/v2.sock" },
    serverUrl: "",
    inboxUrl: "http+unix://v2",
    inboxToken: "token",
    capabilities: ["local", "protocol-v2", "prompt-async", "ack", "raw-session-ids"],
    timestamps: { startedAt: NOW - 60_000, updatedAt: NOW - 30_000, heartbeatAt: NOW },
    policy: { inboundPolicy: "accept", peerPermissions: "allow" },
    pluginVersion: "0.3.0",
    activeSessionId: "ses_main",
    activeSessionTitle: "main session",
    busy: false,
    queuedCount: 0,
    inboundPolicy: "accept",
    startedAt: NOW - 60_000,
    heartbeatAt: NOW,
    ...over,
  }
}

test("formatPeerList labels the scope and renders one role-tagged row per endpoint", () => {
  const peers = [
    { entry: v2Entry(), alive: true, staleReason: null },
    { entry: v2Entry({
      endpointId: "ses_child",
      sessionId: "ses_child",
      parentSessionId: "ses_main",
      timestamps: { startedAt: NOW - 5_000, updatedAt: NOW - 1_000, heartbeatAt: NOW },
    }), alive: true, staleReason: null },
    { entry: v2Entry({ endpointId: "ses_dead" }), alive: false, staleReason: "last heartbeat 90s ago" },
    { entry: peerEntry(), alive: true, staleReason: null }, // v1 peers are always "main"
  ]
  const machineWide = formatPeerList(peers, "alpha", "ses_self")
  assert.match(machineWide, /3 peer\(s\) online \(scope: machine-wide\):/)
  const rows = machineWide.split("\n")
  // most recently active first: ses_child (1s ago) before ses_main (30s ago)
  assert.ok(
    machineWide.indexOf("(id ses_child)") < machineWide.indexOf("(id ses_main)"),
    machineWide
  )
  const childRow = rows.find((l) => l.includes("ses_child"))
  assert.match(childRow, /— subagent —/)
  assert.ok(!childRow.includes("— main —"))
  assert.match(machineWide, /— main —/) // v1 and parented v2 rows
  assert.match(machineWide, /1 peer\(s\) stale\/offline/)

  // formatPeerList only labels the scope; list_agents does the filtering,
  // so an out-of-scope (already filtered) peer set renders the empty scoped state
  const scoped = formatPeerList([], "alpha", "ses_self", "D:/x")
  assert.match(scoped, /No peers online \(scope: directory D:\/x\)\./)
})

test("list_agents scopes by directory and project_only with case/slash-insensitive matching", async () => {
  // sameDirectory (src/format.ts) folds case only where the platform does.
  const caseFolds = process.platform === "win32" || process.platform === "darwin"
  const listed = [
    { entry: v2Entry({ name: "inscope", directory: "D:\\proj\\root" }), alive: true, staleReason: null },
    { entry: v2Entry({ name: "cased", endpointId: "ses_cased", sessionId: "ses_cased", directory: "d:\\PROJ\\Root" }), alive: true, staleReason: null },
    { entry: v2Entry({ name: "elsewhere", endpointId: "ses_other", sessionId: "ses_other", directory: "/tmp/other" }), alive: true, staleReason: null },
  ]
  const { tools } = makeTools({ listed, over: {
    endpointForSession: (id) => id === "ses-self"
      ? { endpointId: "ses_self", name: "alpha", directory: "D:/proj/root" }
      : null,
  } })

  const expected = caseFolds ? 2 : 1 // "cased" matches only where the platform folds case
  const byDir = await tools.list_agents.execute({ directory: "D:/proj/root" }, { sessionID: "ses-self" })
  assert.match(byDir, new RegExp(`${expected} peer\\(s\\) online \\(scope: directory D:/proj/root\\):`))
  assert.match(byDir, /"inscope"/)
  assert.doesNotMatch(byDir, /elsewhere/)
  if (caseFolds) assert.match(byDir, /"cased"/)

  const byProject = await tools.list_agents.execute({ project_only: true }, { sessionID: "ses-self" })
  assert.match(byProject, new RegExp(`${expected} peer\\(s\\) online \\(scope: directory D:/proj/root\\):`))
  assert.match(byProject, /"inscope"/)
  assert.doesNotMatch(byProject, /elsewhere/)

  const machineWide = await tools.list_agents.execute({}, { sessionID: "ses-self" })
  assert.match(machineWide, /3 peer\(s\) online \(scope: machine-wide\):/)
})

test("list_agents project_only errors when the session has no registered directory", async () => {
  const listed = [{ entry: v2Entry(), alive: true, staleReason: null }]
  const { tools } = makeTools({ listed, over: { endpointForSession: () => null } })
  const out = await tools.list_agents.execute({ project_only: true }, { sessionID: "ses-anon" })
  assert.match(out, /not registered yet; pass an explicit directory/)
  const explicit = await tools.list_agents.execute(
    { project_only: true, directory: "/tmp/v2" },
    { sessionID: "ses-anon" }
  )
  assert.match(explicit, /1 peer\(s\) online \(scope: directory \/tmp\/v2\):/)
})

test("send_message rejects empty and oversized messages", async () => {
  const { tools, sender } = makeTools({ listed: [{ entry: peerEntry(), alive: true }] })
  assert.match(await tools.send_message.execute({ to: "beta", message: "  " }, {}), /must not be empty/)
  assert.match(
    await tools.send_message.execute({ to: "beta", message: "x".repeat(9000) }, {}),
    /exceeds/
  )
  assert.equal(sender.calls.length, 0)
})

test("send_message resolves by name and by instanceId", async () => {
  const listed = [{ entry: peerEntry(), alive: true, staleReason: null }]
  const { tools, sender } = makeTools({ listed })
  const r1 = await tools.send_message.execute({ to: "beta", message: "hi" }, {})
  assert.match(r1, /delivered to "beta"/)
  const r2 = await tools.send_message.execute({ to: "bbbb2222", message: "hi" }, {})
  assert.match(r2, /delivered/)
  assert.equal(sender.calls.length, 2)
})

test("send_message also resolves v2 entries by raw sessionId", async () => {
  const listed = [{
    // a legacy-shape v2 endpoint whose endpointId is not its raw session id
    entry: v2Entry({ endpointId: "session-oldhash", sessionId: "ses_target" }),
    alive: true,
    staleReason: null,
  }]
  const { tools, sender } = makeTools({ listed })
  const out = await tools.send_message.execute({ to: "ses_target", message: "hi" }, {})
  assert.match(out, /delivered/)
  assert.equal(sender.calls.length, 1)
  assert.equal(sender.calls[0].entry.endpointId, "session-oldhash")
})

test("send_message gives canonical v2 endpointId precedence without a v1 instanceId alias", async () => {
  const now = Date.now()
  const v2 = {
    version: 2,
    endpointId: "session-exact-v2",
    processId: "process-v2",
    pid: process.pid,
    sessionId: "ses_v2",
    title: "v2",
    name: "shared-name",
    hostname: "h",
    directory: "/tmp/v2",
    status: "idle",
    transport: { type: "unix", path: "/tmp/v2.sock" },
    serverUrl: "",
    inboxUrl: "http+unix://v2",
    inboxToken: "token",
    capabilities: ["local", "protocol-v2", "prompt-async", "ack"],
    timestamps: { startedAt: now, updatedAt: now, heartbeatAt: now },
    policy: { inboundPolicy: "accept", peerPermissions: "allow" },
    pluginVersion: "0.1.7",
    activeSessionId: "ses_v2",
    activeSessionTitle: "v2",
    busy: false,
    queuedCount: 0,
    inboundPolicy: "accept",
    startedAt: now,
    heartbeatAt: now,
  }
  const collision = peerEntry({ instanceId: "legacy-other", name: "session-exact-v2" })
  const { tools, sender } = makeTools({ listed: [
    { entry: v2, alive: true, staleReason: null },
    { entry: collision, alive: true, staleReason: null },
  ] })

  const result = await tools.send_message.execute({ to: "session-exact-v2", message: "hi" }, {})
  assert.match(result, /delivered/)
  assert.equal(sender.calls.length, 1)
  assert.equal(sender.calls[0].entry.endpointId, "session-exact-v2")
})

test("send_message reports unknown, offline and ambiguous targets", async () => {
  const listed = [
    { entry: peerEntry(), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "c1", name: "dup" }), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "c2", name: "dup" }), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "d3", name: "gone" }), alive: false, staleReason: "last heartbeat 90s ago" },
  ]
  const { tools, sender } = makeTools({ listed })

  const unknown = await tools.send_message.execute({ to: "nobody", message: "hi" }, {})
  assert.match(unknown, /no peer named "nobody"/)
  assert.match(unknown, /"beta"/)

  const offline = await tools.send_message.execute({ to: "gone", message: "hi" }, {})
  assert.match(offline, /appears offline/)

  const ambiguous = await tools.send_message.execute({ to: "dup", message: "hi" }, {})
  assert.match(ambiguous, /ambiguous/)
  assert.match(ambiguous, /c1.*c2/s)
  assert.match(ambiguous, /Use an endpoint id/i)
  assert.equal(sender.calls.length, 0)
})

test("exact self, offline, and unknown endpoint IDs never fall back to colliding names", async () => {
  const listed = [
    { entry: peerEntry({ instanceId: "session-self-id", name: "self endpoint" }), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "online-name-one", name: "session-self-id" }), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "session-offline-id", name: "offline endpoint" }), alive: false, staleReason: "last heartbeat 90s ago" },
    { entry: peerEntry({ instanceId: "online-name-two", name: "session-offline-id" }), alive: true, staleReason: null },
    { entry: peerEntry({ instanceId: "online-name-three", name: "session-unknown-id" }), alive: true, staleReason: null },
  ]
  const { tools, sender } = makeTools({ listed, over: { selfInstanceId: "session-self-id" } })

  assert.match(
    await tools.send_message.execute({ to: "session-self-id", message: "hi" }, {}),
    /cannot send.*same session|your own endpoint/i
  )
  assert.match(
    await tools.send_message.execute({ to: "session-offline-id", message: "hi" }, {}),
    /endpoint.*offline|appears offline/i
  )
  assert.match(
    await tools.send_message.execute({ to: "session-unknown-id", message: "hi" }, {}),
    /unknown endpoint ID/i
  )
  assert.equal(sender.calls.length, 0)
})

test("send_message maps all receiver statuses", async () => {
  const listed = [{ entry: peerEntry(), alive: true, staleReason: null }]
  const cases = [
    ["queued", /queued for "beta".*busy/],
    ["held", /awaits their approval/],
    ["delivered", /delivered to "beta"/],
    ["duplicate", /already received/],
  ]
  for (const [status, re] of cases) {
    const { tools } = makeTools({ listed, sendResult: { ok: true, status } })
    assert.match(await tools.send_message.execute({ to: "beta", message: "hi" }, {}), re)
  }

  const { tools: refusedTools } = makeTools({
    listed,
    sendResult: { ok: false, error: '"beta" refuses inbound messages.' },
  })
  assert.match(await refusedTools.send_message.execute({ to: "beta", message: "hi" }, {}), /refuses/)
})

test("send_message enforces outbound rate limit", async () => {
  const listed = [{ entry: peerEntry(), alive: true, staleReason: null }]
  const { tools, sender } = makeTools({ listed, over: { sendLimit: RateLimiter(2) } })
  await tools.send_message.execute({ to: "beta", message: "1" }, {})
  await tools.send_message.execute({ to: "beta", message: "2" }, {})
  const third = await tools.send_message.execute({ to: "beta", message: "3" }, {})
  assert.match(third, /rate limit/)
  assert.equal(sender.calls.length, 2)
})
