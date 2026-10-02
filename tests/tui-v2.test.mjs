import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import mod from "../dist/tui.js"

/**
 * Mocked V2 CLI plugin context (@opencode/plugin/tui Context): captures the
 * keymap layer registration, every dialog call, and every client call so the
 * setup() flows can be scripted and asserted.
 */
function makeContext(over = {}) {
  const calls = []
  const toasts = []
  const route = over.route ?? { type: "session", sessionID: "ses_1" }
  const context = {
    keymap: {
      layer: (input) => {
        calls.push({ kind: "layer", layer: input() })
        if (over.layerReturnsVoid) return undefined
        return () => calls.push({ kind: "unregister" })
      },
    },
    ui: {
      router: {
        current: () => route,
        navigate: (destination) => calls.push({ kind: "navigate", destination }),
      },
      toast: {
        show: (t) => toasts.push(t),
      },
      dialog: {
        prompt: async (opts) => {
          calls.push({ kind: "prompt", opts })
          return over.promptResult
        },
        confirm: async (opts) => {
          calls.push({ kind: "confirm", opts })
          return over.confirmResult ?? false
        },
        select: async (opts) => {
          calls.push({ kind: "select", opts })
          return Object.prototype.hasOwnProperty.call(over, "selectResult") ? over.selectResult : "list"
        },
      },
    },
    client: {
      session: {
        create: async (input) => {
          calls.push({ kind: "create", input })
          if (over.failCreate) throw new Error("create failed")
          return { id: "ses_created" }
        },
        command: async (input) => {
          calls.push({ kind: "command", input })
          if (over.failCommand) throw new Error("server unreachable")
        },
      },
    },
  }
  return { context, calls, toasts }
}

async function getLayer(mock) {
  const cleanup = await mod.setup(mock.context)
  const layer = mock.calls.find((c) => c.kind === "layer").layer
  return { cleanup, layer }
}

function findCommand(layer, id) {
  return layer.commands.find((c) => c.id === id)
}

test("module shape: default export serves BOTH hosts (v1 tui + v2 setup)", () => {
  assert.equal(mod.id, "opencode-peers")
  assert.equal(typeof mod.tui, "function")
  assert.equal(typeof mod.setup, "function")
})

test("setup() registers one global keymap layer with the four commands", async () => {
  const mock = makeContext()
  const { cleanup, layer } = await getLayer(mock)
  assert.equal(typeof cleanup, "function")
  assert.equal(mock.calls.filter((c) => c.kind === "layer").length, 1)
  assert.equal(layer.mode, "global")
  assert.equal(layer.priority, 10) // must outrank the TUI built-ins (0..1)
  assert.deepEqual(layer.commands.map((c) => c.id), [
    "opencode-peers.peers",
    "opencode-peers.peers-name",
    "opencode-peers.peers-inbox",
    "opencode-peers.peers-outbox",
  ])
  const slashes = Object.fromEntries(layer.commands.map((c) => [c.id, c.slash]))
  assert.deepEqual(slashes["opencode-peers.peers"], {
    name: "peers",
    aliases: ["list-agents"],
    arguments: true,
  })
  for (const id of ["peers-name", "peers-inbox", "peers-outbox"]) {
    assert.deepEqual(slashes[`opencode-peers.${id}`], { name: id, arguments: true })
  }
  for (const c of layer.commands) {
    assert.equal(c.palette, true)
    assert.ok(c.title, `${c.id} must have a title`)
    assert.equal(typeof c.run, "function")
  }
})

test("setup() returns the layer unsubscribe for host disposal", async () => {
  const mock = makeContext()
  const { cleanup } = await getLayer(mock)
  assert.equal(mock.calls.some((c) => c.kind === "unregister"), false)
  await cleanup()
  assert.equal(mock.calls.some((c) => c.kind === "unregister"), true)

  // A host build whose layer() returns void must not break setup().
  const voidMock = makeContext({ layerReturnsVoid: true })
  const voidCleanup = await mod.setup(voidMock.context)
  assert.equal(voidCleanup, undefined)
})

test("slash invocation WITH arguments runs the command directly (no dialogs)", async () => {
  const mock = makeContext()
  const { layer } = await getLayer(mock)
  await findCommand(layer, "opencode-peers.peers-name").run("frontend")
  assert.equal(mock.calls.some((c) => c.kind === "prompt"), false)
  assert.equal(mock.calls.some((c) => c.kind === "confirm"), false)
  assert.equal(mock.calls.some((c) => c.kind === "select"), false)
  assert.deepEqual(mock.calls.find((c) => c.kind === "command").input, {
    sessionID: "ses_1",
    name: "peers-name",
    text: "frontend",
  })

  const inbox = makeContext()
  const inboxLayer = (await getLayer(inbox)).layer
  await findCommand(inboxLayer, "opencode-peers.peers-inbox").run("accept all")
  assert.equal(inbox.calls.some((c) => c.kind === "select"), false)
  assert.deepEqual(inbox.calls.find((c) => c.kind === "command").input, {
    sessionID: "ses_1",
    name: "peers-inbox",
    text: "accept all",
  })
})

test("palette peers runs the command directly without dialogs", async () => {
  const mock = makeContext()
  const { layer } = await getLayer(mock)
  await findCommand(layer, "opencode-peers.peers").run()
  assert.equal(mock.calls.some((c) => c.kind === "select"), false)
  assert.deepEqual(mock.calls.find((c) => c.kind === "command").input, {
    sessionID: "ses_1",
    name: "peers",
    text: "",
  })
})

test("palette peers-name: prompt, confirm, then run with the entered name", async () => {
  const mock = makeContext({ promptResult: "  frontend  ", confirmResult: true })
  const { layer } = await getLayer(mock)
  await findCommand(layer, "opencode-peers.peers-name").run()
  assert.ok(mock.calls.some((c) => c.kind === "prompt"))
  assert.ok(mock.calls.some((c) => c.kind === "confirm"))
  assert.deepEqual(mock.calls.find((c) => c.kind === "command").input, {
    sessionID: "ses_1",
    name: "peers-name",
    text: "frontend", // trimmed
  })

  const noName = makeContext({ promptResult: "   " })
  await findCommand((await getLayer(noName)).layer, "opencode-peers.peers-name").run()
  assert.equal(noName.calls.some((c) => c.kind === "command"), false)

  const cancelled = makeContext({ promptResult: "frontend", confirmResult: false })
  await findCommand((await getLayer(cancelled)).layer, "opencode-peers.peers-name").run()
  assert.equal(cancelled.calls.some((c) => c.kind === "command"), false)
})

test("palette peers-inbox: select action, prompt target, confirm drops", async () => {
  const drop = makeContext({ selectResult: "drop", promptResult: "2", confirmResult: true })
  await findCommand((await getLayer(drop)).layer, "opencode-peers.peers-inbox").run()
  assert.ok(drop.calls.some((c) => c.kind === "select"))
  assert.ok(drop.calls.some((c) => c.kind === "prompt"))
  assert.ok(drop.calls.some((c) => c.kind === "confirm"))
  assert.deepEqual(drop.calls.find((c) => c.kind === "command").input, {
    sessionID: "ses_1",
    name: "peers-inbox",
    text: "drop 2",
  })

  // Accept needs no confirmation.
  const accept = makeContext({ selectResult: "accept", promptResult: "3" })
  await findCommand((await getLayer(accept)).layer, "opencode-peers.peers-inbox").run()
  assert.equal(accept.calls.some((c) => c.kind === "confirm"), false)
  assert.deepEqual(accept.calls.find((c) => c.kind === "command").input, {
    sessionID: "ses_1",
    name: "peers-inbox",
    text: "accept 3",
  })

  // List needs neither target nor confirmation.
  const list = makeContext({ selectResult: "list" })
  await findCommand((await getLayer(list)).layer, "opencode-peers.peers-inbox").run()
  assert.equal(list.calls.some((c) => c.kind === "prompt"), false)
  assert.deepEqual(list.calls.find((c) => c.kind === "command").input, {
    sessionID: "ses_1",
    name: "peers-inbox",
    text: "",
  })

  // Invalid target and cancelled selection stop before any command.
  const bad = makeContext({ selectResult: "drop", promptResult: "abc" })
  await findCommand((await getLayer(bad)).layer, "opencode-peers.peers-inbox").run()
  assert.equal(bad.calls.some((c) => c.kind === "command"), false)
  const cancelled = makeContext({ selectResult: undefined })
  await findCommand((await getLayer(cancelled)).layer, "opencode-peers.peers-inbox").run()
  assert.equal(cancelled.calls.some((c) => c.kind === "command"), false)
  const refused = makeContext({ selectResult: "drop", promptResult: "2", confirmResult: false })
  await findCommand((await getLayer(refused)).layer, "opencode-peers.peers-inbox").run()
  assert.equal(refused.calls.some((c) => c.kind === "command"), false)
})

test("palette peers-outbox runs directly", async () => {
  const mock = makeContext()
  const { layer } = await getLayer(mock)
  await findCommand(layer, "opencode-peers.peers-outbox").run()
  assert.equal(mock.calls.some((c) => c.kind === "select"), false)
  assert.deepEqual(mock.calls.find((c) => c.kind === "command").input, {
    sessionID: "ses_1",
    name: "peers-outbox",
    text: "",
  })
})

test("run on the home route creates a session, navigates to it, and executes there", async () => {
  const mock = makeContext({ route: { type: "home" } })
  const { layer } = await getLayer(mock)
  await findCommand(layer, "opencode-peers.peers").run()
  assert.deepEqual(
    mock.calls.filter((c) => ["create", "navigate", "command"].includes(c.kind)),
    [
      { kind: "create", input: {} },
      { kind: "navigate", destination: { type: "session", sessionID: "ses_created" } },
      { kind: "command", input: { sessionID: "ses_created", name: "peers", text: "" } },
    ],
  )
})

test("session.create failure surfaces an error toast and does not navigate", async () => {
  const mock = makeContext({ route: { type: "home" }, failCreate: true })
  const { layer } = await getLayer(mock)
  await findCommand(layer, "opencode-peers.peers").run()
  assert.equal(mock.calls.some((c) => c.kind === "navigate"), false)
  assert.equal(mock.calls.some((c) => c.kind === "command"), false)
  assert.equal(mock.toasts.length, 1)
  assert.equal(mock.toasts[0].variant, "error")
  assert.match(mock.toasts[0].message, /create failed/)
})

test("command failure surfaces an error toast and does not throw", async () => {
  const mock = makeContext({ failCommand: true })
  const { layer } = await getLayer(mock)
  await findCommand(layer, "opencode-peers.peers").run()
  assert.equal(mock.toasts.length, 1)
  assert.equal(mock.toasts[0].variant, "error")
  assert.match(mock.toasts[0].message, /server unreachable/)
})

test("dist/tui.js has zero runtime imports (TUI process cannot resolve deps)", async () => {
  const src = await readFile(fileURLToPath(new URL("../dist/tui.js", import.meta.url)), "utf8")
  assert.ok(!/^\s*import\s/m.test(src), "dist/tui.js must not have import statements")
  assert.ok(!/require\(/.test(src), "dist/tui.js must not use require()")
})
