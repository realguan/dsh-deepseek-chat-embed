#!/usr/bin/env node
/**
 * build-client-bundle.mjs — produce the NATIVE bundle client half.
 *
 * dsh installs a plugin package through the web profile's `client-modules`
 * loader: it resolves `./package.json`, serves the package's client entry, and
 * executes it in the browser. Every such bundle MUST call
 * `window.__ModuleLoader__.load({ id, factory })` with a CommonJS factory
 * `(require) => { ... return module.exports }` — the exact shape tsdown's
 * `clientBundle()` emits in the dsh monorepo.
 *
 * `src/client.js` is a dependency-free ESM module (`export default { apply }`):
 * it imports nothing and touches only Cordis `ctx` plus DOM globals. This script
 * therefore wraps rather than bundles — it rewrites the single `export default`
 * into a module-level constant and re-exports the plugin's `apply` / `inject` /
 * `name` through the factory's `module.exports`.
 *
 * Usage:
 *   node scripts/build-client-bundle.mjs            # write dist bundle
 *   node scripts/build-client-bundle.mjs --verify   # write + node --check
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'src', 'client.js')
const OUT = join(root, 'dist', 'dsh-deepseek-chat-embed.bundle.js')
const PLUGIN_ID = 'dsh-deepseek-chat-embed'

const source = readFileSync(SRC, 'utf8')

// The wrapper below rewrites exactly one `export default`; anything else
// (a second default export, or a named ESM export the factory cannot carry)
// would silently produce a broken bundle.
const defaultExports = source.match(/^export default /gm) ?? []
if (defaultExports.length !== 1) {
  throw new Error(`${SRC}: expected exactly one \`export default\`, found ${defaultExports.length}`)
}
const namedExports = source.match(/^export (?!default )/gm) ?? []
if (namedExports.length !== 0) {
  throw new Error(
    `${SRC}: named ESM exports cannot cross the client-modules factory boundary; found ${namedExports.length}`,
  )
}
if (!/\nexport default\s*\{/.test(source)) {
  throw new Error(`${SRC}: \`export default\` must be an object literal for this wrapper`)
}

// 1. `export default { … }` becomes the module-level plugin record.
const body = source.replace('export default', 'const __plugin = ')

// 2. Re-export the plugin record's fields on module.exports, with the
//    __esModule marker so Cordis's export interop returns the object unchanged.
const pluginExports = `
// ---- native client-modules handoff ----
module.exports.__esModule = true
if (__plugin.apply !== undefined) module.exports.apply = __plugin.apply
if (__plugin.inject !== undefined) module.exports.inject = __plugin.inject
if (__plugin.name !== undefined) module.exports.name = __plugin.name
`

// 3. Test-harness hook. `dsh` never sets the flag, so this branch is dead code
//    in the app; the harness sets it to exercise the lease handshake against a
//    replica of the shipping shell without mounting the React UI.
const testHook = `
if (globalThis.__DSCE_TEST_HOST__ === true) {
  globalThis.__DSCE_TEST__ = {
    mountGuest: typeof mountGuest === 'function' ? mountGuest : undefined,
    // The Dock's bridge (dsh-dock ADR-0033): driven against a replica of the
    // shell's two commands and one event, which is what the harness can model.
    mountTauriGuest: typeof mountTauriGuest === 'function' ? mountTauriGuest : undefined,
    resolveGuestAdapter: typeof resolveGuestAdapter === 'function' ? resolveGuestAdapter : undefined,
    ElectronGuestAdapter: typeof ElectronGuestAdapter !== 'undefined' ? ElectronGuestAdapter : undefined,
    TauriGuestAdapter: typeof TauriGuestAdapter !== 'undefined' ? TauriGuestAdapter : undefined,
    decodeGuestAnswer: typeof decodeGuestAnswer === 'function' ? decodeGuestAnswer : undefined,
    EmbeddedChat,
    isEmbedSupported,
    desktopBrowserBridge,
    require: globalThis.__dshRequire,
    CHAT_URL,
    WORKSPACE_KEY,
    NORMALIZED_UA,
    // The guest-side adapter, so its heuristics can be driven against a mock of
    // the page they were measured from instead of only against the live vendor
    // page (which no test can reach).
    GUEST_SIDEBAR_INSTALL_SCRIPT,
    GUEST_SIDEBAR_READ_SCRIPT,
    GUEST_SIDEBAR_TOGGLE_SCRIPT,
  }
}
`

const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// Publish the module table's require as the package-private resolver the
// source reads (it cannot reference the factory parameter directly, because the
// same source is also loaded as plain ESM by the Node-side profile loader).
globalThis.__dshRequire = require;
`
const footer = `
return module.exports; } });
`

const bundle = banner + body + pluginExports + testHook + footer

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, bundle)
console.log(`✓ wrote ${OUT} (${bundle.length} bytes, id=${PLUGIN_ID})`)

if (process.argv.includes('--verify')) {
  const result = spawnSync(process.execPath, ['--check', OUT], { encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(`✗ syntax check failed: ${OUT}`)
    console.error(result.stderr)
    process.exit(1)
  }
  console.log(`✓ syntax ok: ${OUT}`)
}
