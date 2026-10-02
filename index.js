/**
 * Root entry for OpenCode v2's directory-plugin loader.
 *
 * v2 ignores package.json `main`/`exports` when a `plugins` config entry
 * points at a directory: it only evaluates a root `index.js`/`index.ts`.
 * This file forwards to the compiled entry so the same checkout loads via
 * `{"plugins": ["/path/to/opencode-peers"]}` and as a published
 * package. v1 hosts are unaffected (they resolve `main` → dist/index.js).
 *
 * Run `npm run build` first: dist/index.js must exist.
 */
export * from "./dist/index.js"
export { default } from "./dist/index.js"
