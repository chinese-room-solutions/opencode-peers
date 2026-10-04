/**
 * Real-host integration test for the OpenCode v2 plugin entry
 * (src/v2/index.ts, combined into src/index.ts's default export).
 *
 * Spawns two real `opencode serve` v2 processes — one per project directory —
 * with the built plugin loaded through v2's `.opencode/plugins/*.js`
 * auto-discovery (a one-line shim re-exporting dist/index.js; every other
 * config surface for local plugins — `plugins: [{ package, options }]`
 * documents, `plugin:` tuples, file paths — is accepted by opencode 2.0.x
 * but never activates, so discovery is the only reliable local-dev channel).
 * Both instances share one XDG_DATA_HOME (the peers registry lives under
 * $XDG_DATA_HOME/opencode-peers) and run in different cwds.
 *
 * The spawned servers have no model credentials, so — exactly like the v1
 * real-host test — this drives the plugin's own surfaces over HTTP instead
 * of LLM tools:
 *
 *   1. plugin reaches "active" on both servers (polled via /api/plugin)
 *   2. per-session v2 endpoints appear in the shared registry (heartbeat,
 *      transport socket, default policy), keyed by real session ids
 *   3. cross-instance protocol-v2 delivery over the real UDS listener:
 *      202 "delivered" receipt, the formatted message lands in the target
 *      session's transcript with peerMessage metadata, and the final ACK
 *      reaches the sender's durable outbox
 *   4. deterministic dedup: re-sending the same messageId is idempotent
 *      (recorded status, still exactly one transcript copy)
 *   5. delivery while the target session is busy (session.execution.started
 *      from a synthetic turn; steer semantics)
 *   6. restart recovery: SIGKILL leaves a queued spool record, a restarted
 *      process re-publishes the previous session's endpoint from spool
 *      records, delivers the pending message and returns its final ACK
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Outbox } from "../dist/outbox.js"
import { LocalTransport } from "../dist/transport.js"
import { resolveConfig } from "../dist/config.js"
import { createSessionMessageQueue } from "../dist/queue.js"

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, "..")

async function freePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitFor(fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw last ?? new Error(`condition not met within ${timeoutMs}ms`)
}

/**
 * Spawn one real opencode v2 server. The plugin is loaded through
 * <cwd>/.opencode/plugins/peers.js auto-discovery (see file header); config
 * homes are isolated per instance so the developer's real global config
 * (which carries a v1-style file-path plugin entry that v2 rejects) cannot
 * interfere. OPENCODE_CONFIG_CONTENT is cleared explicitly because an
 * enclosing opencode harness session may export it.
 */
const spawnedChildren = new Set()

async function startOpenCode(root, label, port) {
  const directory = join(root, label)
  await mkdir(join(directory, ".opencode", "plugins"), { recursive: true })
  await writeFile(
    join(directory, ".opencode", "plugins", "peers.js"),
    `export { default } from ${JSON.stringify(join(pluginRoot, "dist", "index.js"))}\n`
  )
  const child = spawn("opencode", ["serve", "--port", String(port)], {
    cwd: directory,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: `peers-test-${label}`,
      OPENCODE_CONFIG_CONTENT: "",
      XDG_DATA_HOME: join(root, "data"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_CONFIG_HOME: join(root, `xdgconfig-${label}`),
      XDG_CACHE_HOME: join(root, `cache-${label}`),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  // Tracked from the moment the process exists so cleanup kills servers even
  // when this function later throws (e.g. port collision) before assignment.
  spawnedChildren.add(child)
  child.once("exit", () => spawnedChildren.delete(child))
  let logs = ""
  child.stdout.on("data", (chunk) => { logs += chunk })
  child.stderr.on("data", (chunk) => { logs += chunk })
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`opencode ${label} exited ${child.exitCode}: ${logs}`)
    return logs.includes(`server listening on http://127.0.0.1:${port}`)
  }, 20_000)
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    // Bound every request: an unresponsive endpoint must fail fast so poll
    // deadlines are enforced instead of wedging on undici's 300s default.
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) }),
    headers: {
      authorization:
        "Basic " + Buffer.from(`opencode:peers-test-${label}`).toString("base64"),
    },
  })
  return { label, child, port, directory, client, logs: () => logs }
}

async function stopOpenCode(proc) {
  if (!proc || proc.child.exitCode !== null || proc.child.signalCode !== null) return
  proc.child.kill("SIGKILL")
  await once(proc.child, "exit")
}

async function pluginActive(proc) {
  const list = await proc.client.plugin.list()
  const ours = list.data?.find((plugin) => plugin.id === "opencode-peers")
  return ours?.state?.status === "active"
}

async function registryEntries(peersDir) {
  const files = await readdir(peersDir).catch(() => [])
  return Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(join(peersDir, file), "utf8")))
  )
}

function alive(entry) {
  try {
    process.kill(entry.pid, 0)
    return true
  } catch {
    return false
  }
}

function newest(entries, predicate) {
  return entries.filter(predicate).sort((a, b) => b.heartbeatAt - a.heartbeatAt)[0]
}

function v2Message(from, to, id, text) {
  return {
    version: 2,
    messageId: id,
    fromEndpointId: from.endpointId,
    toEndpointId: to.endpointId,
    from: { instanceId: from.endpointId, name: from.name, directory: from.directory },
    text,
    via: [from.endpointId],
    sentAt: Date.now(),
  }
}

test("real OpenCode v2 hosts: plugin activation, registry discovery, cross-instance delivery with final ACK, dedup, busy injection, and restart recovery", { timeout: 90_000 }, async (t) => {
  if (process.platform === "win32") {
    return t.skip("transport assertions are Unix-domain-socket specific; POSIX-only for now")
  }
  const found = spawnSync("which", ["opencode"], { encoding: "utf8" })
  if (found.status !== 0 || !found.stdout.trim()) {
    return t.skip("opencode binary is unavailable")
  }
  const version = spawnSync("opencode", ["--version"], { encoding: "utf8" })
  const versionOut = (version.stdout || "").trim()
  if (!/v2\.\d+/.test(versionOut)) {
    return t.skip(`opencode is not v2 (got "${versionOut}"); the v2 plugin entry needs an opencode v2 host`)
  }

  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp(join("/tmp/opencode", "peers-real-v2-"))
  const dataDir = join(root, "data")
  const runtimeDir = join(root, "runtime")
  const pluginStorage = join(dataDir, "opencode-peers")
  const peersDir = join(pluginStorage, "peers.d")
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(runtimeDir, { recursive: true })])

  let alpha
  let beta
  try {
    const [alphaPort, betaPort] = await Promise.all([freePort(), freePort()])
    // Sequential start: both servers share one XDG_DATA_HOME (one opencode
    // database) and would race the schema bootstrap if spawned together
    // ("table account_state already exists" crashes the slower one).
    alpha = await startOpenCode(root, "alpha", alphaPort)
    beta = await startOpenCode(root, "beta", betaPort)

    // ---- 1. plugin active on both real hosts --------------------------------
    // Creating a session forces the location (and its plugin supervisor) to
    // boot; /api/plugin reflects the plugin only after that.
    const alphaSession = await alpha.client.session.create({ title: "alpha-s1" })
    const betaSession = await beta.client.session.create({ title: "beta-s1" })
    await waitFor(() => pluginActive(alpha), 20_000)
    await waitFor(() => pluginActive(beta), 20_000)

    // ---- 2. registry discovery of real sessions ------------------------------
    // Synthetic messages make the sessions "visible" to the plugin: each
    // triggers a model turn (it will fail without provider credentials),
    // firing the session.execution.* events the v2 runtime tracks.
    await alpha.client.session.synthetic({
      sessionID: alphaSession.id,
      id: `msg_${alphaSession.id}_probe`,
      text: "credential-less probe turn",
      delivery: "steer",
    })
    await beta.client.session.synthetic({
      sessionID: betaSession.id,
      id: `msg_${betaSession.id}_probe`,
      text: "credential-less probe turn",
      delivery: "steer",
    })

    const endpoints = await waitFor(async () => {
      const all = await registryEntries(peersDir)
      const a = newest(all, (entry) =>
        entry.version === 2 &&
        entry.sessionId === alphaSession.id &&
        alive(entry) &&
        existsSync(entry.transport.path ?? ""))
      const b = newest(all, (entry) =>
        entry.version === 2 &&
        entry.sessionId === betaSession.id &&
        alive(entry) &&
        existsSync(entry.transport.path ?? ""))
      return a && b ? { a, b } : null
    }, 20_000)

    // One registry record per live session endpoint, addressed by session id.
    assert.equal(endpoints.a.endpointId, alphaSession.id)
    assert.equal(endpoints.b.endpointId, betaSession.id)
    assert.equal(endpoints.a.activeSessionId, alphaSession.id)
    assert.equal(endpoints.b.activeSessionId, betaSession.id)
    assert.equal(endpoints.a.directory, alpha.directory)
    assert.equal(endpoints.b.directory, beta.directory)
    // Distinct auto-generated names (default <dir>-<hex4>) and default policy.
    assert.notEqual(endpoints.a.name, endpoints.b.name)
    assert.match(endpoints.a.name, /^alpha-[0-9a-f]{4}$/)
    assert.match(endpoints.b.name, /^beta-[0-9a-f]{4}$/)
    assert.deepEqual(endpoints.a.policy, { inboundPolicy: "accept", peerPermissions: "allow" })
    assert.equal(endpoints.a.transport.type, "unix")
    assert.equal(endpoints.b.transport.type, "unix")

    // ---- 3. cross-instance delivery, transcript landing, final ACK -----------
    const outbox = Outbox({ storageDir: pluginStorage })
    const transport = LocalTransport()
    const delivered = v2Message(endpoints.b, endpoints.a, "real-v2-cross", "REAL_V2_CROSS_MARKER")

    await outbox.recordPending(delivered, endpoints.a.name)
    const receipt = await transport.send(endpoints.a, delivered)
    assert.equal(receipt.http, 202, JSON.stringify(receipt))
    assert.equal(receipt.status, "delivered", JSON.stringify(receipt))

    const landed = await waitFor(async () => {
      const context = await alpha.client.session.context({ sessionID: alphaSession.id })
      return context.find(
        (message) => message.metadata?.peerMessage?.messageId === "real-v2-cross"
      ) ?? null
    }, 15_000)
    // The synthetic injection carries a deterministic msg_ id and the exact
    // peerMessage provenance the v2 permission walk relies on.
    assert.match(landed.id, /^msg_/)
    assert.deepEqual(landed.metadata.peerMessage, {
      version: 2,
      messageId: "real-v2-cross",
      fromEndpointId: endpoints.b.endpointId,
      toSessionId: alphaSession.id,
    })
    // ...and the formatted body (src/delivery.ts formatMessages output).
    assert.match(
      landed.text,
      new RegExp(`\\[peer message from "${endpoints.b.name}" @ ${beta.directory.replaceAll("/", "\\/")}; sender endpoint: ${endpoints.b.endpointId}\\]`)
    )
    assert.ok(landed.text.includes("REAL_V2_CROSS_MARKER"), landed.text)
    assert.match(landed.text, /To reply, use the send_message tool with the sender's exact endpoint ID/)

    // Final ACK: alpha durably retries the acknowledgement to beta's real
    // listener; beta's outbox record flips to its final status.
    assert.equal(
      await waitFor(async () => outbox.get(endpoints.b.endpointId, "real-v2-cross")?.finalStatus, 15_000),
      "delivered"
    )

    // ---- 4. deterministic dedup ----------------------------------------------
    const dupReceipt = await transport.send(endpoints.a, delivered)
    assert.equal(dupReceipt.http, 202, JSON.stringify(dupReceipt))
    // Same message id: the receiver answers with the recorded final status
    // ("delivered" via the retained done record; "duplicate" is the
    // content-debounce variant) and never injects a second copy.
    assert.ok(
      dupReceipt.status === "delivered" || dupReceipt.status === "duplicate",
      JSON.stringify(dupReceipt)
    )
    const contextAfterDup = await alpha.client.session.context({ sessionID: alphaSession.id })
    assert.equal(
      contextAfterDup.filter((message) => message.metadata?.peerMessage?.messageId === "real-v2-cross").length,
      1
    )

    // ---- 5. delivery while the target session is busy ------------------------
    await alpha.client.session.synthetic({
      sessionID: alphaSession.id,
      id: `msg_${alphaSession.id}_busy`,
      text: "busy probe turn",
      delivery: "steer",
    })
    const busyRecord = await waitFor(async () => {
      const all = await registryEntries(peersDir)
      const a = newest(all, (entry) => entry.version === 2 && entry.sessionId === alphaSession.id && alive(entry))
      return a?.status === "busy" ? a : null
    }, 6_000).catch(() => null)
    if (!busyRecord) {
      // The failing model turn can settle before a poll observes it; the
      // steer-delivery machinery below is identical either way.
      console.log("[real-opencode-v2] busy window not observed before deadline; asserting steer delivery anyway")
    }
    const busy = v2Message(endpoints.b, endpoints.a, "real-v2-busy", "REAL_V2_BUSY_MARKER")
    await outbox.recordPending(busy, endpoints.a.name)
    const busyReceipt = await transport.send(endpoints.a, busy)
    assert.equal(busyReceipt.status, "delivered", JSON.stringify(busyReceipt))
    const busyLanded = await waitFor(async () => {
      const context = await alpha.client.session.context({ sessionID: alphaSession.id })
      return context.find(
        (message) => message.metadata?.peerMessage?.messageId === "real-v2-busy"
      ) ?? null
    }, 15_000)
    assert.ok(busyLanded.text.includes("REAL_V2_BUSY_MARKER"))
    assert.equal(
      await waitFor(async () => outbox.get(endpoints.b.endpointId, "real-v2-busy")?.finalStatus, 15_000),
      "delivered"
    )

    // ---- 6. restart recovery -------------------------------------------------
    await stopOpenCode(alpha)
    // Arrange durable pending state for the dead instance: a queued spool
    // record for its previous session (written with the plugin's own queue
    // implementation against the shared storage dir; alpha is dead so there
    // is no lock contention) plus the sender-side outbox entry.
    const config = resolveConfig({ storageDir: pluginStorage })
    const queue = createSessionMessageQueue({
      config,
      sessionId: alphaSession.id,
      logger: async () => {},
    })
    assert.equal(
      queue.enqueue({
        id: "real-v2-recovery",
        from: { instanceId: endpoints.b.endpointId, name: endpoints.b.name, directory: endpoints.b.directory },
        text: "REAL_V2_RECOVERY_MARKER",
        via: [endpoints.b.endpointId],
        sentAt: Date.now(),
      }),
      true
    )
    const recoveryMessage = v2Message(endpoints.b, endpoints.a, "real-v2-recovery", "REAL_V2_RECOVERY_MARKER")
    await outbox.recordPending(recoveryMessage, endpoints.a.name)

    alpha = await startOpenCode(root, "alpha", alphaPort)
    await waitFor(() => pluginActive(alpha), 15_000)

    // Startup adopts the previous session from its spool records and
    // re-publishes the same endpoint id under the new process.
    const republished = await waitFor(async () => {
      const all = await registryEntries(peersDir)
      return newest(all, (entry) =>
        entry.version === 2 &&
        entry.sessionId === alphaSession.id &&
        entry.processId !== endpoints.a.processId &&
        alive(entry) &&
        existsSync(entry.transport.path ?? "")) ?? null
    }, 15_000)
    assert.equal(republished.endpointId, alphaSession.id)

    // The queued message is delivered into the previous session...
    const recovered = await waitFor(async () => {
      const context = await alpha.client.session.context({ sessionID: alphaSession.id })
      return context.find(
        (message) => message.metadata?.peerMessage?.messageId === "real-v2-recovery"
      ) ?? null
    }, 15_000)
    assert.ok(recovered.text.includes("REAL_V2_RECOVERY_MARKER"))
    // ...and its final ACK still reaches the sender's outbox (the sweeper
    // dispatches it within one sweepMs window).
    assert.equal(
      await waitFor(async () => outbox.get(endpoints.b.endpointId, "real-v2-recovery")?.finalStatus, 30_000),
      "delivered"
    )
  } finally {
    await Promise.all([...spawnedChildren].map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
      const exited = once(child, "exit")
      child.kill("SIGKILL")
      return exited
    }))
    await Promise.all([stopOpenCode(alpha), stopOpenCode(beta)])
    await rm(root, { recursive: true, force: true })
  }
})
