import { test } from "node:test"
import assert from "node:assert/strict"
import { formatSessionList, relativeAge } from "../dist/format.js"

const NOW = 1_800_000_000_000

function peer(over = {}, entryOver = {}) {
  return {
    entry: {
      version: 1,
      instanceId: "aaaa1111",
      name: "alpha",
      pid: 1234,
      hostname: "h",
      directory: "/Users/x/proj",
      serverUrl: "http://127.0.0.1:4000",
      inboxUrl: "http://127.0.0.1:5000",
      inboxToken: "t",
      activeSessionId: "ses_1",
      activeSessionTitle: null,
      busy: false,
      queuedCount: 0,
      inboundPolicy: "accept",
      startedAt: NOW - 9 * 60_000,
      heartbeatAt: NOW,
      pluginVersion: "0.1.4",
      ...entryOver,
    },
    alive: true,
    staleReason: null,
    ...over,
  }
}

test("relativeAge formats seconds/minutes/hours/days", () => {
  assert.equal(relativeAge(NOW - 5_000, NOW), "just now")
  assert.equal(relativeAge(NOW - 9 * 60_000, NOW), "9m ago")
  assert.equal(relativeAge(NOW - 2 * 3_600_000, NOW), "2h ago")
  assert.equal(relativeAge(NOW - 3 * 86_400_000, NOW), "3d ago")
  assert.equal(relativeAge(NOW + 1_000, NOW), "just now") // clock skew clamps
})

test("formatSessionList renders Claude-Code-style rows", () => {
  const out = formatSessionList(
    [
      peer({ }, { name: "opencode-peers-0a", directory: "/Users/w/opencode-peers", busy: true }),
      peer({ }, { instanceId: "bbbb2222", name: "upstream-3a", directory: "/Users/w/upstream", startedAt: NOW - 29 * 60_000 }),
    ],
    NOW
  )
  const lines = out.split("\n")
  assert.equal(lines[0], "Other Opencode sessions (2):")
  // rows are sorted by most recent activity first; one row per endpoint with
  // its endpoint key (v1: instanceId) before the started segment
  assert.equal(
    lines[1],
    "  [waiting]  ·  opencode-peers-0a  ·  /Users/w/opencode-peers  ·  aaaa1111  ·  started 9m ago"
  )
  assert.equal(
    lines[2],
    "  [idle]  ·  upstream-3a  ·  /Users/w/upstream  ·  bbbb2222  ·  started 29m ago"
  )
})

test("formatSessionList: no active session omits the status tag", () => {
  const out = formatSessionList([peer({}, { activeSessionId: null })], NOW)
  assert.match(out, /^  alpha  ·  /m)
  assert.ok(!out.includes("[waiting]") && !out.includes("[idle]"))
})

test("formatSessionList: queuedCount appends a queued segment", () => {
  const out = formatSessionList([peer({}, { queuedCount: 2 })], NOW)
  assert.match(out, /started 9m ago  ·  2 queued/)
})

test("formatSessionList: legacy entries without busy/queuedCount are tolerated", () => {
  const legacy = peer()
  delete legacy.entry.busy
  delete legacy.entry.queuedCount
  const out = formatSessionList([legacy], NOW)
  assert.match(out, /\[idle\]  ·  alpha/)
  assert.ok(!out.includes("queued"))
})

test("formatSessionList: empty online list and stale summary", () => {
  const out = formatSessionList(
    [peer({ alive: false, staleReason: "pid 1 is not running" })],
    NOW
  )
  assert.equal(
    out,
    "No other opencode sessions online.\n1 stale/offline (hidden from targeting)."
  )
})

test("formatSessionList sorts online rows deterministically regardless of input order", () => {
  const a = peer({ entry: { ...peer().entry, name: "zed", instanceId: "zzz", startedAt: NOW - 1000 } })
  const b = peer({ entry: { ...peer().entry, name: "mid", instanceId: "mmm", startedAt: NOW - 5000 } })
  const c = peer({ entry: { ...peer().entry, name: "first", instanceId: "aaa", startedAt: NOW - 9000 } })
  // same startedAt as c but a later id — tiebreak is endpoint key ascending, so d sorts after c
  const d = peer({ entry: { ...peer().entry, name: "tiebreak", instanceId: "bbb", startedAt: NOW - 9000 } })
  const shuffled = [a, b, d, c]
  const one = formatSessionList(shuffled, NOW)
  const two = formatSessionList([c, d, b, a], NOW)
  assert.equal(one, two)
  // v1 rows sort by static startedAt, most recent activity first
  const order = [a, b, c, d].map((p) => p.entry.name)
  const positions = order.map((name) => one.indexOf(`  [idle]  ·  ${name}`))
  assert.ok(positions.every((pos) => pos > 0), one)
  assert.deepEqual([...positions].sort((x, y) => x - y), positions)
})

function v2Peer(over = {}) {
  return peer(
    {},
    {
      version: 2,
      endpointId: "ses_main",
      processId: "proc-1",
      sessionId: "ses_main",
      parentSessionId: null,
      timestamps: { startedAt: NOW - 20 * 60_000, updatedAt: NOW - 30_000 },
      ...over,
    }
  )
}

test("formatSessionList sorts v2 rows by timestamps.updatedAt, not startedAt", () => {
  const freshSubagent = v2Peer({
    endpointId: "ses_child",
    sessionId: "ses_child",
    parentSessionId: "ses_main",
    timestamps: { startedAt: NOW - 2 * 60_000, updatedAt: NOW - 1000 },
  })
  const idleMain = v2Peer({}) // started later than the old main, updated earlier
  const staleMain = v2Peer({
    endpointId: "ses_old",
    sessionId: "ses_old",
    startedAt: NOW - 50 * 60_000,
    timestamps: { startedAt: NOW - 50 * 60_000, updatedAt: NOW - 40 * 60_000 },
  })
  const out = formatSessionList([idleMain, staleMain, freshSubagent], NOW)
  const rows = out.split("\n").filter((l) => l.startsWith("  "))
  const keys = rows.map((l) => l.match(/·  (ses_\S+)  ·/)[1])
  assert.deepEqual(keys, ["ses_child", "ses_main", "ses_old"])
})

test("formatSessionList shows one row per v2 endpoint with a [subagent] tag", () => {
  const out = formatSessionList(
    [
      v2Peer({ endpointId: "ses_child", sessionId: "ses_child", parentSessionId: "ses_main" }),
      v2Peer({ endpointId: "ses_main", sessionId: "ses_main" }),
    ],
    NOW
  )
  const rows = out.split("\n").filter((l) => l.startsWith("  "))
  assert.equal(rows.length, 2) // no process collapsing
  assert.match(rows[0], /\[subagent\]  ·/)
  assert.ok(!rows[1].includes("[subagent]"))
  // endpoint key segment is the raw session endpoint id
  assert.match(rows[0], /·  ses_child  ·/)
  assert.match(rows[1], /·  ses_main  ·/)
})

test("formatSessionList shows session title between name and directory when present", () => {
  const out = formatSessionList(
    [peer({}, { activeSessionTitle: "Fix login bug" })],
    NOW
  )
  assert.match(out, /alpha  ·  "Fix login bug"  ·  \/Users\/x\/proj/)
})

test("formatSessionList omits title segment when activeSessionTitle is null or empty", () => {
  const nullOut = formatSessionList([peer({}, { activeSessionTitle: null })], NOW)
  assert.ok(!nullOut.includes('"·'), `unexpected title in: ${nullOut}`)
  assert.match(nullOut, /alpha  ·  \/Users\/x\/proj/)

  const emptyOut = formatSessionList([peer({}, { activeSessionTitle: "  " })], NOW)
  assert.match(emptyOut, /alpha  ·  \/Users\/x\/proj/)
})

test("formatSessionList truncates long session titles with ellipsis", () => {
  const longTitle = "A".repeat(50)
  const out = formatSessionList([peer({}, { activeSessionTitle: longTitle })], NOW)
  assert.match(out, /"A{39}…"/)
  assert.ok(!out.includes("A".repeat(50)), "full 50-char title should not appear")
})
