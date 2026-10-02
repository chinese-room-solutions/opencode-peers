# AGENTS.md

## Project

Standalone opencode plugin for cross-session messaging: independent opencode
instances on one machine discover each other and exchange plain-text messages,
modeled after Claude Code's cross-session messaging. Forked from
[jkrandom-sudo/opencode-plugin-peers](https://github.com/jkrandom-sudo/opencode-plugin-peers)
at v0.2.3 and extended (OpenCode v2 support, event-driven discovery, synthetic
delivery, evaluate-hook permissions); now an independent line. Upstream is
credited in README.md and LICENSE as its MIT license requires.

Architecture:

- One package, two host entries: the default export carries both the v1 entry
  (`src/index.ts`) and the v2 entry (`src/v2/index.ts`); each host picks its
  own. The root `index.js` forwards to `dist/index.js` because v2's directory
  loader only evaluates a root `index.js` — never remove it.
- Discovery is a filesystem registry under `$XDG_DATA_HOME/opencode-peers`
  (default; overridable via `storageDir`): one protocol-v2 record per session
  endpoint plus a v1 compatibility record per process. v2 hosts discover
  event-driven (no session list in the plugin context); v1 hosts poll.
- Transport is an authenticated Unix-domain socket (macOS/Linux) or loopback
  TCP (Windows), plus a loopback HTTP listener for protocol-v1 senders. Peers
  never call another process's opencode server.
- Delivery is a durable spool (`spool/<endpoint>/{queued,held,inflight,done}`)
  with atomic transitions and final ACKs retried to the sender's outbox.
  Receipt ≠ delivery.
- Peer-triggered permission auto-allow runs in the v2 permission `evaluate`
  hook / via v1 permission-event watching, and only for turns started by a
  message the plugin injected.

## Stack

- TypeScript, no linter. Plain `tsc` (`npm run build`, `npm run typecheck`).
- Tests: `node --test tests/*.test.mjs` (`npm test` = build + suite).
- Zero runtime dependencies beyond `@opencode/plugin` (v2 host API) and `zod`
  (tool schemas); `@opencode-ai/plugin` stays a peer dependency for v1 hosts.
- Real-host suites spawn actual `opencode serve` processes: the v1 suite
  (`tests/real-opencode.test.mjs`) needs an opencode v1 binary, the v2 suite
  (`tests/real-opencode-v2.test.mjs`) an opencode v2 binary; each skips with a
  message when the machine doesn't have its host. Keep both guards working.
- Node ≥ 18, opencode ≥ 1.18.29 (v1) or OpenCode 2.x (v2).

## Working style

- Top-level agent: plan, orchestrate, and review. Make simple changes yourself — a settled, small, contained edit costs more to hand off than to make.
- Delegate the rest, at most 2 subagents at a time: work spanning several files, needing its own exploration, or running long. Each starts cold — hand it the diagnosis, file refs, design, environment setup, and what to verify.
- Subagent: do the work yourself. Never spawn further agents.
- Scale verification to risk: a string/comment change needs build + the touched
  test file; registry, spool, transport, or permissions changes need the full
  suite plus the matching real-host suite.
- Verify a diagnosis against current code before fixing it. One commit per fix.
- Don't spam commits. While nothing is pushed, amend a commit that proved wrong rather than stacking fixups.
- Commit messages: conventional commits (`feat:`/`fix:`/`refactor:`/`chore:`/`docs:`), as short as the change allows — one subject line, a body only for a why the diff doesn't show. No trailers.

## Code quality

- Minimal, direct, maintainable code. Write the minimal thing first; no
  speculative abstractions. Abstractions belong at the existing seams
  (v1 entry / v2 entry / transport / registry / spool), not mid-code.
- Follow the existing code style; make breaking changes when needed — nothing
  is published-stable yet.
- Keep comments and docs concise. Don't add comments unless they're necessary.
- A new npm dependency must earn its place: the package ships to npm and runs
  inside the opencode host process.
- Revisit your changes before committing: remove what's no longer needed, and
  revert any accumulated change that isn't load-bearing — ship only the code
  that actually fixes the issue.

## Plugin rules

- v1 and v2 entries must stay behaviorally equal: a user-facing change lands
  in both paths, with tests for each. Check the sibling entry before shipping.
- The registry and spool record formats and the default storage dir are a
  compatibility surface — older peers and pending queues live there. Breaking
  changes need a protocol version bump and a migration, not an in-place edit.
- Peer-visible strings (listings, notices, command fallback texts) are prompts
  read by models: plain text, stable phrasing, no formatting the host strips.
- Permission auto-allow stays scoped to turns started by injected peer
  messages, and never covers permission configuration, credentials, or
  escalation. Broadening it is a security decision, not a convenience fix.
- Case/slash-insensitive directory comparison folds case only where the
  platform does (`sameDirectory` in `src/format.ts`). Don't make matching
  case-insensitive unconditionally.

## Async & errors

- No floating promises: `await` every promise, or explicitly handle rejection.
  Event and command callbacks must not reject silently.
- Never swallow errors. Wrap with context and pass up; the plugin surfaces
  errors in the session, not in toasts.
- Every listener, timer, and child process has a defined owner and a teardown
  path (host unload must not leak them).

## Conventions

- Use `npm run build` / `npm run typecheck` / `npm test` / `npm run dry-run`,
  not ad-hoc `tsc` or `node --test` invocations, except when iterating on a
  single test file.
- A user-visible feature, command, or settings change updates README.md in the
  same commit.
- Before calling work done: `npm run typecheck` is clean and `npm test` is
  green (skips accounted for). Report what you verified and what you couldn't.
