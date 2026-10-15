#!/usr/bin/env node
/**
 * verify.mjs — the two-entry contract of the DeepSeek plugin.
 *
 * Two entries, two homes, no third control anywhere:
 *
 *   1. the shell's own left navigation item (a main-panel id, so the centred
 *      DeepSeek panel is what makes it clickable);
 *   2. one resident button beside the shell's right-dock control, which opens
 *      the chat as a real tab in that dock.
 *
 * Neither is a header seat: the plugin registers nothing in the conversation
 * header (`conversation.session.header.utilities` stays with the shell), and
 * nothing floats over the middle of the New Session screen.
 *
 * Those are facts about the *built* bundle plus live measurement, so this loads
 * `dist/` into jsdom, applies it through a stub of the client context, and
 * drives the registered components with real React:
 *
 *   · the registration set (which seats, which ids, which keys);
 *   · the right-dock tab type it declares;
 *   · where the resident button lands, in each of the shell's three header
 *     states, measured against the shell's own controls;
 *   · what its click does (open the dock tab, expand the track, or fold it away
 *     again when the tab is already in front);
 *   · that the dock tab body owns the chat while it is visible, and gives it up
 *     when the user switches to another tab.
 *
 * jsdom is not a dependency of this package; the harness checkout is used as a
 * source for it (`DSCE_JSDOM_ROOT` overrides the search).
 *
 * Usage: node test/entries/verify.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

// ---------------------------------------------------------------------------
// jsdom
// ---------------------------------------------------------------------------

const JSDOM_CANDIDATES = [
  process.env.DSCE_JSDOM_ROOT,
  root,
].filter((value) => typeof value === 'string' && value !== '')

function loadJsdom() {
  for (const candidate of JSDOM_CANDIDATES) {
    try {
      return createRequire(join(candidate, 'package.json'))('jsdom')
    } catch {
      /* try the next root */
    }
  }
  throw new Error(`jsdom not found; searched ${JSDOM_CANDIDATES.join(', ')}`)
}

const { JSDOM } = loadJsdom()

// ---------------------------------------------------------------------------
// The shell, reduced to what the entries measure
// ---------------------------------------------------------------------------

const FRAME = { left: 0, top: 0, width: 1440, height: 900 }
const SIDEBAR = { left: 0, top: 0, width: 280, height: 900 }
const COLUMN = { left: 280, top: 0, width: 1160, height: 900 }
const HEADER = { left: 280, top: 0, width: 1160, height: 76 }
/** The shell's right-dock expand button, at the header's own corner. */
const EXPAND = { left: 1400, top: 24, width: 28, height: 28 }
/** The right dock's pane body, where the DeepSeek tab renders. */
const DOCK_BODY = { left: 1100, top: 76, width: 340, height: 824 }
/**
 * The centred panel and its chat host, in the state that regressed: macOS
 * desktop with the sidebar collapsed, so the centre column reaches the window
 * edge and the frame's chrome (traffic lights, sidebar toggle, and the reopen /
 * New Session controls the frame moves into `shell.leading`) floats over the
 * panel's top-left. `--dsh-frame-top-clearance` is 48px there, so the chat host
 * — not the panel — starts below it.
 */
const STRIP = 48
const MAIN_PANEL = { left: 0, top: 0, width: 1440, height: 900 }
const MAIN_HOST = { left: 0, top: STRIP, width: 1440, height: 900 - STRIP }

/** 8px clear of the shell's control — the gap the button must keep. */
const GAP = 8

const HTML = `<!doctype html><html><body>
  <div class="X_frame" data-shell-frame>
    <div class="X_sidebarCol"></div>
    <div class="X_centerCol">
      <header class="C_header" data-window-drag>
        <div class="C_headerLeading" data-conversation-header-leading></div>
        <div class="C_titleRow">
          <div class="C_headerUtilities"></div>
          <div class="C_headerCorner" data-conversation-header-corner>
            <button type="button" class="C_expand" data-sidebar-right-expand></button>
          </div>
        </div>
      </header>
    </div>
    <div class="R_rightbarCol" data-rightbar-col></div>
    <div class="X_overlayLayer" data-shell-overlay></div>
  </div>
</body></html>`

const dom = new JSDOM(HTML, {
  pretendToBeVisual: true,
  runScripts: 'outside-only',
  url: 'https://shell.invalid/',
})
const win = dom.window
const doc = win.document

// 视口必须和本文件建模的壳同尺寸（FRAME = 1440x900）。jsdom 默认 1024x768，
// 会让 DOCK_BODY（left=1100）在模型里落到「视口外」——插件现在据此让位
// （见 syncToHost 的离屏判定），守卫就会替我们制造一个假故障。
Object.defineProperty(win, 'innerWidth', { value: FRAME.width, configurable: true })
Object.defineProperty(win, 'innerHeight', { value: FRAME.height, configurable: true })

/** Rects jsdom cannot compute (no layout engine), keyed by selector. */
const RECTS = [
  ['[data-shell-frame]', FRAME],
  ['.X_sidebarCol', SIDEBAR],
  ['.X_centerCol', COLUMN],
  ['.C_header', HEADER],
  ['[data-sidebar-right-expand]', EXPAND],
  ['.dsce-dock-body', DOCK_BODY],
  ['.dsce-main-panel', MAIN_PANEL],
  ['.dsce-main-host', MAIN_HOST],
]

function box(rect) {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON() { return { ...this } },
  }
}

const EMPTY = box({ left: 0, top: 0, width: 0, height: 0 })
/** Selectors the scenario hides, to model the shell's own `:empty` seats. */
const hidden = new Set()

win.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  // The plugin's own seats are stretched over the frame by their stylesheet.
  if (this.classList?.contains('dsce-resident-layer')) return box(FRAME)
  for (const [selector, rect] of RECTS) {
    if (hidden.has(selector)) continue
    if (this.matches?.(selector) === true) return box(rect)
  }
  return { ...EMPTY }
}

// ---------------------------------------------------------------------------
// React, then the built bundle, exactly as the client-modules host hands them over
// ---------------------------------------------------------------------------

const evaluate = (file) => win.eval(readFileSync(file, 'utf8'))

evaluate(join(root, 'test', 'harness', 'vendor', 'react.development.js'))
evaluate(join(root, 'test', 'harness', 'vendor', 'react-dom.development.js'))
if (win.React === undefined || win.ReactDOM === undefined) {
  throw new Error('the vendored React builds did not publish window.React / window.ReactDOM')
}

// Publishes the bundle's own test face (`window.__DSCE_TEST__`), which is how
// the browser fallback card is reached without a desktop shell.
win.__DSCE_TEST_HOST__ = true
const records = []
win.__ModuleLoader__ = {
  load({ id, factory }) {
    const record = { id, factory }
    records.push(record)
    return record
  },
}

evaluate(join(root, 'dist', 'dsh-deepseek-chat-embed.bundle.js'))

const requireModule = (name) => {
  if (name === 'react') return win.React
  throw new Error(`the stub module table has no ${JSON.stringify(name)}`)
}
const plugin = records[0].factory(requireModule)

// ---------------------------------------------------------------------------
// Apply through a stub of the client context
// ---------------------------------------------------------------------------

const registrations = []
const slots = {
  inject(key, callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  },
}
const calls = { selectPanel: [], openRightbar: [], closeRightbar: [], openTab: [], toggleSidebar: [] }
const layout = {
  selectPanel: (id) => calls.selectPanel.push(id),
  toggleSidebar: () => calls.toggleSidebar.push(true),
  openRightbar: (track, fullscreen) => calls.openRightbar.push([track, fullscreen]),
  closeRightbar: () => calls.closeRightbar.push(true),
}
const tabTypes = []
const sidebarRightTabs = { register: (definition) => { tabTypes.push(definition); return () => {} } }
const sidebarRight = {
  openTab: (kind, options) => calls.openTab.push([kind, options]),
}
const services = { layout, sidebarRight, sidebarRightTabs }

// The plugin scope is a cordis context: `inject(deps, cb)` defers the callback
// until every named service exists (and re-runs it if one later disappears).
// The harness holds them all from the start, so the array form calls back at
// once — which is also how the ordering bug this guards against is reproduced:
// a host whose right dock registers late is exactly a `scope.get` that misses.
/** Every service-injection the plugin asked for, in order. */
const injectCalls = []
const derivedScope = {
  slots,
  ...services,
  get: (name) => services[name],
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on: () => () => {},
  inject: (deps, callback) => {
    if (Array.isArray(deps)) {
      injectCalls.push([...deps])
      return callback(derivedScope)
    }
    return slots.inject(deps, callback)
  },
}
const scope = { ...derivedScope }
const ctx = {
  get: () => undefined,
  inject: (deps, callback) => (deps.includes('slots') ? callback(scope) : () => {}),
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on: () => () => {},
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until `probe` returns something truthy, or the deadline expires. */
async function until(probe, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined && value !== null && value !== false) return value
    await sleep(25)
  }
  return undefined
}

const checks = []
const check = (name, ok, detail) => { checks.push({ name, ok: ok === true, detail }) }

const registration = (name, key) => registrations.find((entry) => entry.options.name === name
  && (key === undefined || entry.options.key === key || entry.options.id === key))

const mount = (component, props) => {
  const host = doc.createElement('div')
  host.className = 'dsce-test-host'
  doc.body.appendChild(host)
  const reactRoot = win.ReactDOM.createRoot(host)
  reactRoot.render(win.React.createElement(component, props))
  return reactRoot
}

/** The overlay the chat renders into, as the app would show it. */
const overlay = () => doc.querySelector('.dsce-overlay')

async function main() {
  plugin.apply(ctx)

  // ---- the registration set -------------------------------------------------
  const seats = registrations.map((entry) => entry.options.name)
  check(
    'the only header seat the plugin claims is the utilities row (entry 2, native half)',
    registration('conversation.session.header.utilities', 'deepseek-chat-embed-entry') !== undefined
      && registrations.filter((entry) => String(entry.options.name).startsWith('conversation.session.header')).length === 1,
    seats.join(', '),
  )
  check(
    'entry 1 is the sidebar item plus its main panel',
    registration('sidebar.panellist', 'deepseek') !== undefined && registration('main', 'deepseek') !== undefined,
    seats.join(', '),
  )
  check(
    'entry 2 also has the overlay half for the blank New Session screen',
    registration('shell.overlay', 'deepseek-chat-embed-entry-blank') !== undefined,
  )
  check(
    'the dock wiring defers on the dock service instead of reading it once',
    injectCalls.some((deps) => deps.includes('sidebarRightTabs') && deps.includes('slots')),
    JSON.stringify(injectCalls),
  )
  check(
    'the dock tab type is declared to the right dock',
    tabTypes.length === 1 && tabTypes[0].kind === 'deepseek'
      && tabTypes[0].keepMounted === true && tabTypes[0].multiple === false
      && typeof tabTypes[0].title === 'function' && tabTypes[0].title() === '聊天',
    JSON.stringify(tabTypes[0] ?? null),
  )
  check(
    'the dock tab body is registered under the type id',
    registration('sidebar.right.pane.tab', 'dsh-deepseek-chat-embed') !== undefined,
    seats.join(', '),
  )

  // ---- entry 2: where the button lands -------------------------------------
  const button = registration('shell.overlay', 'deepseek-chat-embed-entry-blank')
  const buttonRoot = mount(button.component, {})
  const slot = await until(() => doc.querySelector('.dsce-resident-slot'))
  const clickEntry = async () => {
    const node = await until(() => doc.querySelector('.dsce-entry-btn'))
    node.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await sleep(30)
  }
  check('the resident button renders while a conversation header is on screen', slot !== undefined)

  if (slot !== undefined) {
    // right edge = 8 clear of the shell's expand button, same box, same centre
    const expectedRight = FRAME.width - (EXPAND.left - GAP)
    check(
      'the button keeps 8px of clearance from the shell expand control',
      Number.parseFloat(slot.style.right) === expectedRight,
      `expected right=${expectedRight}, got ${slot.style.right}`,
    )
    check(
      'the button is sized and centred like that control',
      Number.parseFloat(slot.style.width) === EXPAND.height
        && Number.parseFloat(slot.style.height) === EXPAND.height
        && Number.parseFloat(slot.style.top) === EXPAND.top + EXPAND.height / 2,
      `size=${slot.style.width}x${slot.style.height} top=${slot.style.top}`,
    )

    // with the dock expanded the shell's control is gone: the button follows the
    // utilities row that took the header's edge instead of drifting.
    hidden.add('[data-sidebar-right-expand]')
    const utilities = doc.querySelector('.C_headerUtilities')
    const utility = doc.createElement('button')
    utility.className = 'C_utility'
    utilities.appendChild(utility)
    RECTS.push(['.C_utility', { left: 1352, top: 24, width: 28, height: 28 }])
    await until(() => Number.parseFloat(slot.style.right) === FRAME.width - (1380 + GAP), 2500)
    check(
      'with the dock expanded the button follows the utilities row',
      Number.parseFloat(slot.style.right) === FRAME.width - (1380 + GAP),
      `got ${slot.style.right}`,
    )
    hidden.delete('[data-sidebar-right-expand]')
    utility.remove()
    await until(() => Number.parseFloat(slot.style.right) === FRAME.width - (EXPAND.left - GAP), 2500)

    // ---- entry 2: what its click does --------------------------------------
    //
    // The refusal check runs first, while the seat is still closed: once the
    // dock is open the next click legitimately folds it (that is the point of
    // the flip below), so a refusal can only be observed from the closed state.
    const realOpenTab = sidebarRight.openTab
    sidebarRight.openTab = () => { throw new Error('sidebarRight: no Session on screen') }
    await clickEntry()
    const errored = await until(() => doc.querySelector('.dsce-entry-btn[data-error="true"]'), 2000)
    check(
      'a refused dock open is reported instead of falling back to the centre',
      errored !== undefined && calls.selectPanel.length === 0,
      `error=${errored !== undefined} selectPanel=${calls.selectPanel.length}`,
    )
    sidebarRight.openTab = realOpenTab

    await clickEntry()
    check(
      'the click opens the DeepSeek tab in the right dock',
      calls.openTab.length === 1 && calls.openTab[0][0] === 'deepseek'
        && calls.openTab[0][1]?.revealIfOpened === true,
      JSON.stringify(calls.openTab),
    )
    check(
      'the click also expands the dock track',
      calls.openRightbar.length === 1 && calls.openRightbar[0][0] === true,
      JSON.stringify(calls.openRightbar),
    )
    check(
      'docking the chat never moves the centre column',
      calls.selectPanel.length === 0,
      JSON.stringify(calls.selectPanel),
    )

    // The overlay half is a stand-in for the blank screen only: once the shell
    // draws its utilities row, the native seat has the button and this copy
    // stands down.
    RECTS.push(['.C_headerUtilities', { left: 1200, top: 24, width: 60, height: 28 }])
    // The copy re-measures on the shell's own changes; a stub rect is not one, so
    // nudge the tree the way a navigation would.
    const nudge = doc.createElement('span')
    doc.body.appendChild(nudge)
    nudge.remove()
    const stoodDown = await until(() => doc.querySelector('.dsce-entry-btn') === null, 2500)
    check('the overlay copy stands down while the utilities row is drawn', stoodDown !== undefined)
    RECTS.pop()
    doc.body.appendChild(nudge)
    nudge.remove()
    await until(() => doc.querySelector('.dsce-entry-btn') !== null, 2500)
  }

    // ---- a sessionless page still gets its entry ------------------------------
    //
    // Measured in DSH Dock's web profile: the blank New Session / workspace
    // picker draws its header with **zero height** (`headerBlank
    // headerSessionless`, box [280,0,1000,0]). Demanding a height left those
    // pages with no entry at all — the dock chat simply could not be opened.
    // The header is still there, still the column's full width, still at the
    // top; only its content is absent.
    hidden.add('[data-sidebar-right-expand]')
    const headerEntry = RECTS.findIndex(([selector]) => selector === '.C_header')
    const savedHeader = RECTS[headerEntry][1]
    RECTS[headerEntry][1] = { left: 280, top: 0, width: 1000, height: 0 }
    const nudge2 = doc.createElement('span')
    doc.body.appendChild(nudge2)
    nudge2.remove()
    // 等重新测量完成:零高度 header 宽 1000 ⇒ 锚点 right = 280+1000-12 = 1268,
    // 而 slot 的 right 是相对 resident-layer(1440 宽)右边的偏移 ⇒ 1440-1268 = 172。
    const zeroSlot = await until(() => {
      const node = doc.querySelector('.dsce-resident-slot')
      return node !== null && node.style.right === '172px' ? node : undefined
    }, 2500)
    check('a zero-height sessionless header still yields an entry', zeroSlot !== undefined)
    check(
      'and it sits exactly where a sessioned page puts it',
      zeroSlot !== undefined && zeroSlot.style.top === '25px'
        && zeroSlot.style.width === '28px' && zeroSlot.style.height === '28px',
      zeroSlot === undefined ? 'never re-measured' : JSON.stringify(zeroSlot.style.cssText),
    )
    RECTS[headerEntry][1] = savedHeader
    hidden.delete('[data-sidebar-right-expand]')
    doc.body.appendChild(nudge2)
    nudge2.remove()

  // ---- entry 2, native half: the same button in the shell's own row ---------
  const nativeSeat = registration('conversation.session.header.utilities', 'deepseek-chat-embed-entry')
  const nativeRoot = mount(nativeSeat.component, {})
  const nativeButton = await until(() => doc.querySelector('.dsce-entry-btn'))
  check('the native half renders the same control in the utilities row', nativeButton !== undefined)
  check(
    'the native half carries no positioning of its own',
    nativeButton !== undefined && nativeButton.className === 'dsce-entry-btn',
    nativeButton?.className,
  )
  nativeRoot.unmount()

  // ---- entry 2's surface: the dock tab body --------------------------------
  const tabBody = registration('sidebar.right.pane.tab', 'dsh-deepseek-chat-embed')
  const tabState = { visible: true, expanded: true, closed: 0 }
  const useTabInfo = () => ({
    sidebar: { expanded: tabState.expanded, fullscreen: false },
    panel: { id: 'pane-1' },
    tab: {
      visible: tabState.visible,
      actions: { close: () => { tabState.closed += 1 } },
    },
  })
  const tabRoot = mount(tabBody.component, { useTabInfo })
  const host = await until(() => doc.querySelector('.dsce-dock-body'))
  check('the dock tab renders its host box', host !== undefined)

  if (host !== undefined) {
    const shown = await until(() => {
      const node = overlay()
      return node !== null && node.dataset.dsceOpen === 'true' ? node : undefined
    })
    check('the chat surface appears inside the dock tab', shown !== undefined)
    if (shown !== undefined) {
      check(
        'the surface fills exactly the dock tab body',
        shown.style.left === `${DOCK_BODY.left}px` && shown.style.top === `${DOCK_BODY.top}px`
          && shown.style.width === `${DOCK_BODY.width}px` && shown.style.height === `${DOCK_BODY.height}px`,
        `${shown.style.left},${shown.style.top} ${shown.style.width}x${shown.style.height}`,
      )
    }

    // The seat's label must follow the click, not just the tab-info
    // subscription: that store update is one tick away, and a button that still
    // says "fold away" after the dock closed runs the fold branch forever — the
    // dock can never be reopened, which is how the shell's own dock tabs (and
    // everything in them) became unreachable.
    const entryLabel = () => doc.querySelector('.dsce-entry-btn')?.getAttribute('aria-label')
    check(
      'opening flips the label to fold-away',
      entryLabel() === '收起右侧栏的聊天',
      String(entryLabel()),
    )
    await clickEntry()
    check(
      'a click on an already-open tab folds the dock away',
      calls.closeRightbar.length === 1 && calls.openTab.length === 1,
      `closeRightbar=${calls.closeRightbar.length} openTab=${calls.openTab.length}`,
    )
    check(
      'after folding, the button offers to open again',
      entryLabel() === '在右侧栏打开聊天',
      String(entryLabel()),
    )
    await clickEntry()
    check(
      'and the next click really reopens the dock',
      calls.openTab.length === 2 && calls.closeRightbar.length === 1,
      `openTab=${calls.openTab.length} closeRightbar=${calls.closeRightbar.length}`,
    )
    check(
      'reopening flips the label back to fold-away',
      entryLabel() === '收起右侧栏的聊天',
      String(entryLabel()),
    )

    // Switching to another dock tab must hand the surface back: the native child
    // webview floats above the page and would otherwise cover that tab. The
    // framework re-renders the body when the tab stops being the visible one,
    // which is what this second render stands in for.
    tabState.visible = false
    tabRoot.render(win.React.createElement(tabBody.component, { useTabInfo }))
    const hiddenAgain = await until(() => {
      const node = overlay()
      return node !== null && node.dataset.dsceOpen === 'false' ? true : undefined
    })
    check('switching away from the tab hides the chat surface', hiddenAgain === true)
  }

  // ---- entry 1's surface: the centred panel and the window strip ------------
  const mainPanel = registration('main', 'deepseek')
  const panelRoot = mount(mainPanel.component, {})
  const panel = await until(() => doc.querySelector('.dsce-main-panel'))
  check('the centred panel renders', panel !== undefined)

  if (panel !== undefined) {
    const strip = panel.querySelector('.dsce-main-strip')
    const panelHost = panel.querySelector('.dsce-main-host')
    check(
      'the panel reserves the window strip above the chat host',
      strip !== null && panelHost !== null && strip.nextElementSibling === panelHost,
      `strip=${strip !== null} host=${panelHost !== null}`,
    )
    check(
      'the strip owns the window drag, like a shipped page head',
      strip !== null && strip.hasAttribute('data-window-drag'),
    )

    check(
      'opening the centred chat leaves the shell sidebar exactly as the user left it',
      calls.toggleSidebar.length === 0,
      `toggleSidebar=${calls.toggleSidebar.length}`,
    )

    // The surface must follow the shell's layout, never chase it: a transition
    // here makes the edge trail the moving column, which is its own, wrong
    // animation.
    const animatingHost = doc.createElement('div')
    animatingHost.setAttribute('data-animating', '')
    doc.body.appendChild(animatingHost)
    win.dispatchEvent(new win.Event('resize'))
    await sleep(120)
    const stylesNow = [...doc.querySelectorAll('style')].map((node) => node.textContent ?? '').join('\n')
    check(
      'the surface owns no transition of its own',
      !/\.dsce-overlay\s*\{[^}]*transition/.test(stylesNow)
        && !/\.dsce-overlay\[[^\]]*\]\s*\{[^}]*transition/.test(stylesNow),
    )
    check(
      'the surface geometry still equals the host box while the shell animates',
      overlay()?.style.left === `${MAIN_HOST.left}px` && overlay()?.style.width === `${MAIN_HOST.width}px`,
      `${overlay()?.style.left} ${overlay()?.style.width}`,
    )
    animatingHost.remove()

    const styles = [...doc.querySelectorAll('style')].map((node) => node.textContent ?? '').join('\n')
    check(
      'the strip is the shell\'s own clearance only while the sidebar is collapsed',
      /\.dsce-main-strip\s*\{[^}]*height:\s*0/.test(styles)
        && /html\[data-platform='darwin'\]\s*\[data-sidebar-collapsed\]\s*\.dsce-main-strip\s*\{[^}]*height:\s*var\(--dsh-frame-top-clearance/.test(styles),
    )
    check(
      'the strip height transitions smoothly with the shell\'s own duration and easing',
      /\.dsce-main-strip\s*\{[^}]*transition:\s*height\s*var\(--ds-transition-duration-slow/.test(styles),
    )

    // The chat must land on the host, i.e. below the strip — this is the
    // regression: hosting on the panel itself put the surface under the frame's
    // floating chrome the moment the sidebar collapsed.
    const settled = await until(() => {
      const node = overlay()
      return node !== null && node.dataset.dsceOpen === 'true'
        && node.style.top === `${MAIN_HOST.top}px` ? node : undefined
    })
    check(
      'the chat fills the host below the strip, never the panel',
      settled !== undefined,
      settled === undefined
        ? `overlay=${overlay()?.dataset.dsceOpen} ${overlay()?.style.left},${overlay()?.style.top}`
        : undefined,
    )
    if (settled !== undefined) {
      check(
        'the surface box equals the host box',
        settled.style.left === `${MAIN_HOST.left}px` && settled.style.width === `${MAIN_HOST.width}px`
          && settled.style.height === `${MAIN_HOST.height}px`,
        `${settled.style.left},${settled.style.top} ${settled.style.width}x${settled.style.height}`,
      )
    }
  }

  // ---- the fold's motion: one layout, then a compositor move ---------------
  //
  // Following the collapsing column frame by frame resizes the guest's viewport
  // ~60 times in 260ms, and the guest is a whole application re-laying itself out
  // each time — that is the stutter. So the fold hands the surface the box it
  // will end at (one layout) and moves it with a transform on the shell's own
  // curve, with per-frame following suspended until it lands.
  const chatFace = win.__DSCE_TEST__
  if (typeof chatFace?.EmbeddedChat !== 'function') {
    check('the bundle publishes EmbeddedChat for the motion contract', false)
  } else {
    const guest = new chatFace.EmbeddedChat()
    const hostEl = doc.createElement('div')
    hostEl.className = 'dsce-flip-host'
    doc.body.appendChild(hostEl)
    RECTS.push(['.dsce-flip-host', { left: 280, top: 76, width: 1000, height: 700 }])
    guest.attach(hostEl)
    const node = guest.overlay
    check(
      'a surface lays out onto its host box',
      node?.style.left === '280px' && node?.style.width === '1000px',
      `${node?.style.left} ${node?.style.width}`,
    )

    // The shell is about to move its column 264px left and widen it by the same.
    const animating = doc.createElement('div')
    animating.setAttribute('data-animating', '')
    doc.body.appendChild(animating)
    guest.flipTo({ left: 16, top: 76, width: 1264, height: 700 }, 264)
    check(
      'the fold lays the guest out once, at the box it will end at',
      node?.style.left === '16px' && node?.style.width === '1264px',
      `${node?.style.left} ${node?.style.width}`,
    )
    check(
      'and parks it back where it was, with a transform',
      node?.style.transform === 'translateX(264px)',
      node?.style.transform,
    )
    await sleep(80)
    const parked = /^translateX\(0(px)?\)$/.test(node?.style.transform ?? '')
    check(
      'then hands the transform to the shell\'s own duration and easing',
      /transform/.test(node?.style.transition ?? '') && parked,
      `${node?.style.transition} | ${node?.style.transform}`,
    )

    // Mid-flight, a moving host must not pull the surface off its animation.
    RECTS[RECTS.length - 1] = ['.dsce-flip-host', { left: 100, top: 76, width: 1180, height: 700 }]
    guest.syncToHost()
    check(
      'a moving host cannot pull the surface off its animation',
      node?.style.left === '16px' && /^translateX\(0(px)?\)$/.test(node?.style.transform ?? ''),
      `${node?.style.left} ${node?.style.transform}`,
    )

    animating.remove()
    const landed = await until(() => node?.style.transform === '' && node?.style.transition === '', 3000)
    check('when the shell settles, the flip clears and following resumes', landed !== undefined)

    void guest.destroy()
    hostEl.remove()
    RECTS.pop()
  }

  // ---- the shell's chrome is never covered ---------------------------------
  //
  // In DSH Dock the guest is a native child webview that floats above the page:
  // anything it covers is gone, and the right dock draws its controls over the
  // top band the seat fills — tab chips on the left, the split / fullscreen /
  // collapse toolbar on the right. The band is found structurally (small,
  // visible, horizontally overlapping siblings pressing into the host's top), so
  // a vendor redesign changes the measurement, never the rule.
  {
    const guest = new chatFace.EmbeddedChat()
    const hostEl = doc.createElement('div')
    hostEl.className = 'dsce-band-host'
    const strip = doc.createElement('div')
    strip.className = 'dsce-band-strip'
    const pane = doc.createElement('div')
    pane.className = 'dsce-band-pane'
    pane.appendChild(strip)
    pane.appendChild(hostEl)
    doc.body.appendChild(pane)

    RECTS.push(['.dsce-band-pane', { left: 900, top: 0, width: 380, height: 832 }])
    RECTS.push(['.dsce-band-host', { left: 900, top: 32, width: 380, height: 800 }])

    // The row presses into the seat's top: exactly the Dock case.
    RECTS.push(['.dsce-band-strip', { left: 900, top: 0, width: 380, height: 44 }])
    guest.attach(hostEl)
    const node = guest.overlay
    check(
      'the surface gives back the band the shell draws over its top',
      node?.style.top === '44px' && node?.style.height === '788px',
      `${node?.style.top} ${node?.style.height}`,
    )

    // The same row placed outside the seat's span is another column's chrome.
    RECTS[RECTS.length - 1] = ['.dsce-band-strip', { left: 20, top: 0, width: 120, height: 44 }]
    guest.syncToHost()
    check(
      'chrome outside the seat span never insets this surface',
      node?.style.top === '32px' && node?.style.height === '800px',
      `${node?.style.top} ${node?.style.height}`,
    )

    // A floating toolbar over the top-right corner is chrome too.
    RECTS[RECTS.length - 1] = ['.dsce-band-strip', { left: 1120, top: 8, width: 150, height: 32 }]
    guest.syncToHost()
    check(
      'a floating toolbar over the corner is given back as well',
      node?.style.top === '40px' && node?.style.height === '792px',
      `${node?.style.top} ${node?.style.height}`,
    )

    // Nothing drawn over the top: the seat keeps its whole box.
    strip.remove()
    RECTS.pop()
    guest.syncToHost()
    check(
      'with nothing drawn over its top the surface keeps the whole seat',
      node?.style.top === '32px' && node?.style.height === '800px',
      `${node?.style.top} ${node?.style.height}`,
    )

    void guest.destroy()
    pane.remove()
    RECTS.pop()
    RECTS.pop()
  }

  // ---- a sibling tab's work never becomes our geometry ----------------------
  //
  // The dock's tab host holds every tab body: ours, and the shell's own 文件 /
  // 终端 ones. A measurement watch on that host therefore fires on each row a
  // file tree lists and each line a terminal writes, and each firing re-sent an
  // identical rect to the native child webview — 1434 `embed_chat_resize` calls
  // in one Dock run, in bursts of ~60 a second, every one carrying the same box.
  // Each of those is a native `set_bounds` on the window's content view, so the
  // panes we share the dock with paid for our measurement: the file tree sat on
  // "正在读取…" and the terminal drew nothing.
  //
  // The watch is narrowed to the chrome row and the geometry write is idempotent;
  // these checks pin both, because neither is visible from the outside.
  {
    const face = win.__DSCE_TEST__
    const invokes = []
    win.__TAURI__ = { core: { invoke: async (name) => { invokes.push(name); return undefined } } }
    const resizes = () => invokes.filter((name) => name === 'embed_chat_resize').length

    // The dock's own shape: one tab host, a chrome row above it, our body and a
    // sibling body side by side inside it.
    const tabHost = doc.createElement('div')
    tabHost.className = 'dsce-storm-tabhost'
    const chromeRow = doc.createElement('div')
    chromeRow.className = 'dsce-storm-chromerow'
    const strip = doc.createElement('div')
    strip.setAttribute('data-dockkit-strip', '')
    chromeRow.appendChild(strip)
    const myBody = doc.createElement('div')
    myBody.className = 'dsce-storm-mine'
    const siblingBody = doc.createElement('div')
    siblingBody.className = 'dsce-storm-sibling'
    tabHost.append(chromeRow, myBody, siblingBody)
    doc.body.appendChild(tabHost)

    RECTS.push(['.dsce-storm-mine', { left: 705, top: 38, width: 576, height: 729 }])
    const guest = new face.EmbeddedChat()
    guest.attach(myBody)
    const before = resizes()

    // A file tree listing its rows, and a terminal writing its output.
    for (let i = 0; i < 200; i += 1) {
      const row = doc.createElement('div')
      row.className = 'dsce-storm-row'
      row.textContent = `row ${i}`
      siblingBody.appendChild(row)
    }
    await sleep(60)
    check(
      'a sibling tab listing 200 rows costs us no geometry call',
      resizes() === before,
      `${before} → ${resizes()}`,
    )

    // The host really does move: the guard must not swallow a real change.
    RECTS[RECTS.length - 1] = ['.dsce-storm-mine', { left: 700, top: 38, width: 581, height: 729 }]
    guest.syncToHost()
    check(
      'and a host that really moved still reports its new box',
      resizes() === before + 1 && guest.overlay?.style.left === '700px',
      `${before} → ${resizes()} at ${guest.overlay?.style.left}`,
    )

    // Re-measuring an unmoved host is silent, however often it is asked.
    for (let i = 0; i < 20; i += 1) guest.syncToHost()
    check(
      'twenty re-measures of an unmoved host send nothing at all',
      resizes() === before + 1,
      `${before} → ${resizes()}`,
    )

    void guest.destroy()
    tabHost.remove()
    RECTS.pop()
    delete win.__TAURI__
  }

  // ---- and not when the strip sits directly under the tab host -------------
  //
  // The other shape the dock can draw: the strip is a direct child of the tab
  // host, so the chrome row *is* the tab host. A deep watch there is the storm
  // again, so the watch goes shallow — which still sees the strip appear and
  // disappear without seeing anything the tab bodies do.
  {
    const face = win.__DSCE_TEST__
    const invokes = []
    win.__TAURI__ = { core: { invoke: async (name) => { invokes.push(name); return undefined } } }
    const resizes = () => invokes.filter((name) => name === 'embed_chat_resize').length

    const tabHost = doc.createElement('div')
    tabHost.className = 'dsce-flat-tabhost'
    const strip = doc.createElement('div')
    strip.setAttribute('data-dockkit-strip', '')
    const myBody = doc.createElement('div')
    myBody.className = 'dsce-flat-mine'
    const siblingBody = doc.createElement('div')
    siblingBody.className = 'dsce-flat-sibling'
    tabHost.append(strip, myBody, siblingBody)
    doc.body.appendChild(tabHost)

    RECTS.push(['.dsce-flat-mine', { left: 705, top: 38, width: 576, height: 729 }])
    const guest = new face.EmbeddedChat()
    guest.attach(myBody)
    const before = resizes()

    for (let i = 0; i < 200; i += 1) {
      const row = doc.createElement('div')
      row.textContent = `row ${i}`
      siblingBody.appendChild(row)
    }
    await sleep(60)
    check(
      'a strip directly under the tab host still costs us nothing',
      resizes() === before,
      `${before} → ${resizes()}`,
    )

    void guest.destroy()
    tabHost.remove()
    RECTS.pop()
    delete win.__TAURI__
  }

  // ---- the guest-side sidebar adapter --------------------------------------
  //
  // Driven against a mock of the page the heuristics were measured from
  // (2026-10-10, chat.deepseek.com): controls are `div[role=button]`, the
  // sidebar's "new chat" entry carries the state, the toggle sits either at the
  // open column's top-right or as the leftmost control of the page's top-left
  // cluster — and the per-tick read must stay a single query, because a full scan
  // of that page (~1500 elements) at 150ms ticks is what made the shell's own
  // animation stutter.
  const adapter = win.__DSCE_TEST__
  if (adapter === undefined || typeof adapter.GUEST_SIDEBAR_INSTALL_SCRIPT !== 'string') {
    check('the bundle publishes the guest sidebar adapter', false)
  } else {
    const run = (script) => win.eval(script)

    const stage = doc.createElement('div')
    stage.innerHTML = [
      '<div id="guest-shell">',
      '  <div id="guest-side">',
      '    <div id="guest-side-head"><span id="guest-fold" role="button"></span></div>',
      '    <div id="guest-new">开启新对话</div>',
      '  </div>',
      '  <div id="guest-main">',
      '    <div id="guest-top">',
      '      <span id="c1" role="button"></span><span id="c2" role="button"></span><span id="c3" role="button"></span>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('\n')
    doc.body.appendChild(stage)

    // jsdom has no layout: give the mock the boxes the real page reported.
    RECTS.push(['#guest-shell', { left: 0, top: 0, width: 1000, height: 797 }])
    RECTS.push(['#guest-side', { left: 0, top: 0, width: 257, height: 797 }])
    RECTS.push(['#guest-new', { left: 20, top: 80, width: 220, height: 44 }])
    RECTS.push(['#guest-fold', { left: 223, top: 15, width: 34, height: 34 }])
    RECTS.push(['#c1', { left: 63, top: 15, width: 34, height: 34 }])
    RECTS.push(['#c2', { left: 99, top: 15, width: 34, height: 34 }])
    RECTS.push(['#c3', { left: 135, top: 15, width: 34, height: 34 }])

    check(
      'the per-tick read never scans the page',
      !/querySelectorAll/.test(adapter.GUEST_SIDEBAR_READ_SCRIPT),
    )

    const clicks = []
    for (const id of ['guest-fold', 'c1', 'c2', 'c3']) {
      doc.getElementById(id).addEventListener('click', () => clicks.push(id))
    }

    // Open sidebar: identified once, then read cheaply from the mark.
    check(
      'the adapter identifies an open chat sidebar',
      run(adapter.GUEST_SIDEBAR_INSTALL_SCRIPT) === 'expanded',
      run(adapter.GUEST_SIDEBAR_INSTALL_SCRIPT),
    )
    check(
      'the marked read answers without a scan',
      run(adapter.GUEST_SIDEBAR_READ_SCRIPT) === 'expanded',
      run(adapter.GUEST_SIDEBAR_READ_SCRIPT),
    )
    check(
      'closing the chat sidebar clicks the marked head control, nothing else',
      run(adapter.GUEST_SIDEBAR_TOGGLE_SCRIPT) === 'clicked:' && clicks.join(',') === 'guest-fold',
      clicks.join(','),
    )

    // Folded sidebar: re-identified against the collapsed layout.
    doc.getElementById('guest-side').remove()
    clicks.length = 0
    check(
      'the adapter re-identifies a folded chat sidebar',
      run(adapter.GUEST_SIDEBAR_INSTALL_SCRIPT) === 'collapsed',
      run(adapter.GUEST_SIDEBAR_INSTALL_SCRIPT),
    )
    check(
      'the marked read follows the fold',
      run(adapter.GUEST_SIDEBAR_READ_SCRIPT) === 'collapsed',
      run(adapter.GUEST_SIDEBAR_READ_SCRIPT),
    )
    check(
      'opening the chat sidebar clicks the marked top-left control, nothing else',
      run(adapter.GUEST_SIDEBAR_TOGGLE_SCRIPT) === 'clicked:' && clicks.join(',') === 'c1',
      clicks.join(','),
    )

    // A re-render that drops the mark: the read says so, and the caller
    // reinstalls instead of clicking a stale node.
    doc.getElementById('c1').remove()
    check(
      'a dropped mark reads unknown rather than guessing',
      run(adapter.GUEST_SIDEBAR_READ_SCRIPT) === 'unknown',
      run(adapter.GUEST_SIDEBAR_READ_SCRIPT),
    )

    // Nothing to press: the adapter must say so rather than click a stranger.
    doc.getElementById('guest-top').remove()
    clicks.length = 0
    check(
      'with no control in reach the adapter clicks nothing',
      run(adapter.GUEST_SIDEBAR_INSTALL_SCRIPT) === 'not-found'
        && run(adapter.GUEST_SIDEBAR_TOGGLE_SCRIPT) === 'not-found' && clicks.length === 0,
      `${clicks.join(',')}`,
    )

    stage.remove()
    RECTS.length = RECTS.length - 7
  }

  // ---- the dock's chrome can be drawn after the surface measured -----------
  //
  // The Dock's chip row (and the split / fullscreen / collapse buttons beside
  // it) is React output. On a cold open the pane body exists before that row
  // does: measured on a real Dock run, `_tabHostHeader` was empty when the
  // surface attached and carried the strip ~2s later. A single measurement at
  // attach time therefore answered "nothing sits above me", the surface kept the
  // whole pane, and the strip then rendered underneath it — which is exactly
  // "the dock lost its controls". The surface has to re-read the box when the
  // chrome appears, not only when the host resizes.
  {
    const face = win.__DSCE_TEST__
    const pane = doc.createElement('div')
    pane.className = 'X_paneRoot'
    const host = doc.createElement('div')
    host.className = 'dsce-dock-body'
    pane.appendChild(host)
    doc.body.appendChild(pane)

    const chat = new face.EmbeddedChat()
    chat.attach(host)
    check(
      'a dock pane with no chrome drawn yet keeps the whole box',
      chat.geometry !== undefined && Math.round(chat.geometry.top) === DOCK_BODY.top,
      JSON.stringify(chat.geometry ?? null),
    )

    const strip = doc.createElement('div')
    strip.className = 'X_tabStrip'
    strip.setAttribute('data-dockkit-tab', '')
    RECTS.push(['.X_tabStrip', { left: DOCK_BODY.left, top: DOCK_BODY.top, width: DOCK_BODY.width, height: 38 }])
    pane.insertBefore(strip, host)

    const inset = await until(() => (chat.geometry !== undefined && Math.round(chat.geometry.top) > DOCK_BODY.top
      ? chat.geometry
      : undefined))
    check(
      'chrome that appears later is given back instead of covered',
      inset !== undefined && Math.round(inset.top) === DOCK_BODY.top + 38
        && Math.round(inset.height) === DOCK_BODY.height - 38,
      JSON.stringify(chat.geometry ?? null),
    )

    chat.detach(host)
    void chat.destroy()
    pane.remove()
    RECTS.pop()
  }

  // ---- the pane reading is about *this* pane --------------------------------
  //
  // A document-wide query once answered about a different pane's strip, which
  // read exactly like a fact and sent a whole diagnosis the wrong way. The
  // reading has to come from the pane the surface actually lives in.
  {
    const face = win.__DSCE_TEST__
    const otherPane = doc.createElement('div')
    const otherStrip = doc.createElement('div')
    otherStrip.className = 'X_othertabStrip'
    otherPane.appendChild(otherStrip)
    doc.body.appendChild(otherPane)
    RECTS.push(['.X_othertabStrip', { left: 10, top: 0, width: 300, height: 38 }])

    const pane = doc.createElement('div')
    pane.className = 'X_paneRoot'
    const header = doc.createElement('div')
    header.className = 'X_tabHostHeader'
    const strip = doc.createElement('div')
    strip.className = 'X_tabStrip'
    const host = doc.createElement('div')
    host.className = 'dsce-dock-body'
    pane.appendChild(header)
    pane.appendChild(strip)
    pane.appendChild(host)
    doc.body.appendChild(pane)
    RECTS.push(['.X_tabHostHeader', { left: 820, top: 0, width: 461, height: 38 }])
    RECTS.push(['.X_tabStrip', { left: 820, top: 0, width: 461, height: 38 }])

    const chat = new face.EmbeddedChat()
    const reading = chat.paneState(host)
    check(
      'the pane reading comes from the surface\'s own pane, not the first one in the document',
      reading.strip.startsWith('visible/none 820,0 461x38') && reading.header.includes('children=0'),
      JSON.stringify(reading),
    )

    chat.detach(host)
    void chat.destroy()
    pane.remove()
    otherPane.remove()
    RECTS.length = RECTS.length - 3
  }

  // ---- the Dock's bridge: one eval out, one title back (dsh-dock ADR-0033) --
  //
  // DSH Dock owns the guest natively, so the plugin cannot reach its runtime
  // the way Electron's lease can. Both directions ride one narrow channel:
  // `embed_chat_eval` (main webview only, per dsh-dock's own caller check) and
  // the `dsce:guest-message` event, which carries a request id. These checks pin
  // the two properties the channel's correctness rests on — calls are
  // serialised, and answers are paired by id.
  {
    const face = win.__DSCE_TEST__
    const invokes = []
    const listeners = new Map()
    let expands = 0
    win.__TAURI__ = {
      core: {
        invoke: async (name, args) => {
          invokes.push([name, args])
          return undefined
        },
      },
      event: {
        listen: async (name, handler) => {
          listeners.set(name, handler)
          return () => listeners.delete(name)
        },
      },
    }
    const named = (name) => invokes.filter(([entry]) => entry === name)
    const encode = (value) => encodeURIComponent(JSON.stringify(value))
    const emit = (payload) => {
      const handler = listeners.get('dsce:guest-message')
      if (handler !== undefined) handler({ payload })
    }

    const handle = await face.mountTauriGuest({ geometry: DOCK_BODY, onExpand: () => { expands += 1 } })
    check(
      'the Dock bridge opens the native child and listens for answers',
      named('embed_chat_open').length === 1 && listeners.has('dsce:guest-message'),
      JSON.stringify(invokes.map(([name]) => name)),
    )
    // The box stays in page coordinates and the page reports its own viewport:
    // the shell needs both to place the native child (window = page + titlebar).
    const openArgs = named('embed_chat_open')[0][1]
    check(
      'the Dock bridge sends the page box plus the page viewport it was measured in',
      openArgs.rect.top === DOCK_BODY.top && openArgs.rect.left === DOCK_BODY.left
        && openArgs.rect.width === DOCK_BODY.width && openArgs.rect.height === DOCK_BODY.height
        && openArgs.frame.width === win.innerWidth && openArgs.frame.height === win.innerHeight,
      JSON.stringify(openArgs),
    )

    const first = handle.element.executeJavaScript('(() => 1)()')
    const second = handle.element.executeJavaScript('(() => 2)()')
    await sleep(30)
    check(
      'guest calls are serialised: one title marker is in flight at a time',
      named('embed_chat_eval').length === 1,
      `evals=${named('embed_chat_eval').length}`,
    )

    const firstEval = named('embed_chat_eval')[0][1]
    check(
      'a guest call carries its own request id and the script',
      typeof firstEval.requestId === 'string' && firstEval.requestId.length > 0
        && firstEval.script === '(() => 1)()',
      JSON.stringify(firstEval),
    )

    // Somebody else's answer must not settle this call.
    emit({ kind: 'result', requestId: 'someone-else', value: encode('nope') })
    emit({ kind: 'result', requestId: firstEval.requestId, value: encode('collapsed') })
    check('an answer is paired with its own request id', (await first) === 'collapsed', String(await first))

    await until(() => named('embed_chat_eval').length === 2)
    const secondEval = named('embed_chat_eval')[1][1]
    check(
      'the next call goes out once the first is answered',
      secondEval.requestId !== firstEval.requestId && secondEval.script === '(() => 2)()',
      JSON.stringify(secondEval),
    )
    emit({ kind: 'result', requestId: secondEval.requestId, value: encode('expanded') })
    check('the second call is answered too', (await second) === 'expanded', String(await second))

    const failed = handle.element.executeJavaScript('(() => { throw new Error("boom") })()')
    await until(() => named('embed_chat_eval').length === 3)
    emit({
      kind: 'result',
      requestId: named('embed_chat_eval')[2][1].requestId,
      value: encode({ error: 'boom' }),
    })
    let failure = ''
    await failed.then(() => {}, (error) => { failure = String(error.message) })
    check('a guest script that threw reads as a failed call, not a value', failure === 'boom', failure)

    emit({ kind: 'expand', requestId: 'e1' })
    emit({ kind: 'expand', requestId: 'e1' })
    emit({ kind: 'expand' })
    check('a hand-opened guest sidebar is signalled once per click', expands === 1, `expands=${expands}`)

    await handle.close()
    check(
      'closing the Dock guest drops its listener and destroys the child',
      listeners.has('dsce:guest-message') === false && named('embed_chat_close').length === 1,
      `listeners=${listeners.size} close=${named('embed_chat_close').length}`,
    )
    delete win.__TAURI__
  }

  // ---- the browser fallback card: the two desktop shells are links ---------
  const testFace = win.__DSCE_TEST__
  if (testFace === undefined || typeof testFace.EmbeddedChat !== 'function') {
    check('the bundle publishes its test face', false)
  } else {
    const card = doc.createElement('div')
    doc.body.appendChild(card)
    new testFace.EmbeddedChat().mountWebFallback(card)
    const links = [...card.querySelectorAll('.dsce-companion__link')]
    const hrefs = links.map((anchor) => anchor.getAttribute('href'))
    check(
      'the fallback card links both recommended desktop shells',
      hrefs.join(' ') === 'https://www.deepseek.com/harness/ https://github.com/realguan/dsh-dock',
      hrefs.join(' '),
    )
    check(
      'those links are real anchors opening outside the app',
      links.length === 2 && links.every((anchor) => anchor.getAttribute('target') === '_blank'
        && (anchor.getAttribute('rel') ?? '').includes('noopener')),
      links.map((anchor) => `${anchor.textContent}:${anchor.getAttribute('target')}`).join(', '),
    )
    card.remove()
  }

  // ---- Desktop Guest Adapter architecture verification --------------------
  {
    const face = win.__DSCE_TEST__
    if (typeof face.resolveGuestAdapter === 'function') {
      // 1. In browser environment (no desktop bridge, no Tauri):
      delete win.dshDesktop
      delete win.__TAURI__
      delete win.__DSH_CHAT_EMBED__
      check('in plain browser, resolveGuestAdapter returns undefined', face.resolveGuestAdapter() === undefined)

      // 2. In Electron environment (dshDesktop present):
      win.dshDesktop = { browser: { acquire: async () => ({ lease: 'l1', partition: 'p1' }), release: async () => {} } }
      const electronAdapter = face.resolveGuestAdapter()
      check(
        'in Electron environment, resolveGuestAdapter resolves ElectronGuestAdapter',
        electronAdapter?.id === 'electron',
        electronAdapter?.label,
      )
      delete win.dshDesktop

      // 3. In Tauri environment (__TAURI__ present):
      const tauriInvokes = []
      win.__TAURI__ = {
        core: {
          invoke: async (name, args) => {
            tauriInvokes.push([name, args])
            return undefined
          },
        },
      }
      const tauriAdapter = face.resolveGuestAdapter()
      check(
        'in Tauri environment, resolveGuestAdapter resolves TauriGuestAdapter',
        tauriAdapter?.id === 'tauri',
        tauriAdapter?.label,
      )

      // 4. TauriGuestAdapter.syncGeometry delegates to embed_chat_resize
      await tauriAdapter.syncGeometry({ left: 10, top: 20, width: 300, height: 400 }, { width: 1200, height: 800, scale: 2 })
      check(
        'TauriGuestAdapter.syncGeometry invokes embed_chat_resize with rect and frame',
        tauriInvokes.some(([name, args]) => name === 'embed_chat_resize' && args?.rect?.width === 300 && args?.frame?.scale === 2),
        JSON.stringify(tauriInvokes),
      )

      // 5. TauriGuestAdapter.setVisible delegates to embed_chat_open / embed_chat_hide
      await tauriAdapter.setVisible(true, { left: 0, top: 0, width: 100, height: 100 }, { width: 1000, height: 700, scale: 1 })
      await tauriAdapter.setVisible(false)
      check(
        'TauriGuestAdapter.setVisible invokes embed_chat_open on show and embed_chat_hide on hide',
        tauriInvokes.some(([name]) => name === 'embed_chat_open') && tauriInvokes.some(([name]) => name === 'embed_chat_hide'),
        JSON.stringify(tauriInvokes),
      )
      delete win.__TAURI__
    }
  }

  // ---- surface 生命周期：样式表走了，浮层必须跟着走 ---------------------------
  //
  // 2026-10-14 现场故障：`.dsce-overlay` 的 `position: fixed` 原本**只**由插件自己
  // 注入、且可被 dispose 的 <style> 提供。样式先走一步时，它退化成 <body> 末尾的
  // 普通块：壳的文档被撑高、整页可滚，并按旧 geometry 留下一张硬边白卡（Chromium
  // 实测 scrollHeight +124、position 由 fixed 变 static）。这里钉住四件事：不变量是
  // 行内的、离屏宿主让位、destroy 失败也不留 DOM、应用期就扫残骸。
  {
    const face = win.__DSCE_TEST__
    const pane = doc.createElement('div')
    pane.className = 'X_paneRoot'
    const host = doc.createElement('div')
    host.className = 'dsce-dock-body'
    pane.appendChild(host)
    doc.body.appendChild(pane)
    const entry = RECTS.find(([selector]) => selector === '.dsce-dock-body')
    const home = entry[1]

    const chat = new face.EmbeddedChat()
    chat.attach(host)
    await until(() => chat.overlay !== undefined && chat.overlay.dataset.dsceOpen === 'true')
    const surface = chat.overlay
    check(
      'the surface carries its out-of-flow invariants inline, not only in the stylesheet',
      surface !== undefined && surface.style.position === 'fixed' && surface.style.display === 'block'
        && surface.style.overflow === 'hidden' && surface.style.zIndex === '200',
      JSON.stringify({ position: surface?.style.position, display: surface?.style.display, zIndex: surface?.style.zIndex }),
    )

    // 样式表被撤掉（dispose 的第一步）之后，浮层仍然在流外。
    const style = doc.querySelector('style[data-dsh-deepseek-chat-embed-styles]')
    const css = style?.textContent
    style?.remove()
    check(
      'removing the plugin stylesheet cannot push the surface into the document flow',
      surface?.style.position === 'fixed',
      String(surface?.style.position),
    )
    if (css !== undefined) {
      const restored = doc.createElement('style')
      restored.dataset.dshDeepseekChatEmbedStyles = '1'
      restored.textContent = css
      doc.head.appendChild(restored)
    }

    // 离屏宿主必须让位：原生子视窗不随页面滚动，固定浮层也不会自己跟手。
    entry[1] = { ...home, top: -home.height - 24 }
    chat.syncToHost()
    check(
      'a host scrolled out of the viewport hands the surface back',
      chat.isOpen() === false && surface?.dataset.dsceOpen === 'false',
      String(surface?.dataset.dsceOpen),
    )
    entry[1] = home
    chat.syncToHost()
    check('a host back in the viewport re-opens the surface', chat.isOpen() === true)

    // 滚动路径：盒子没动就不重算（避免逐帧付一次文档级查询），动了才跟手。
    const settled = JSON.stringify(chat.geometry ?? null)
    chat.syncOnScroll()
    check(
      'a scroll that did not move the host rewrites nothing',
      JSON.stringify(chat.geometry ?? null) === settled,
      settled,
    )
    entry[1] = { ...home, top: home.top - 40 }
    chat.syncOnScroll()
    check(
      'a scroll that moved the host pulls the surface with it',
      chat.geometry !== undefined && Math.round(chat.geometry.top) === home.top - 40,
      JSON.stringify(chat.geometry ?? null),
    )
    entry[1] = home
    chat.syncToHost()

    // 释放 guest 失败也不许把 DOM 留在页面里（destroy 先摘 DOM、再放租约）。
    chat.handle = { close: async () => { throw new Error('release failed') } }
    await chat.destroy()
    check(
      'destroy() removes the surface even when releasing the guest fails',
      surface !== undefined && surface.isConnected === false && chat.overlay === undefined,
      String(surface?.isConnected),
    )

    // 应用期清扫：连 class 被改掉的残骸（只认插件自己的 DOM 标记）也要清。
    const orphan = doc.createElement('div')
    orphan.setAttribute('data-dsh-deepseek-chat-embed-surface', '1')
    doc.body.appendChild(orphan)
    const fresh = new face.EmbeddedChat()
    fresh.ensureOverlay()
    check(
      'a leftover surface from an earlier fiber is swept before the next one is built',
      orphan.isConnected === false && fresh.overlay !== undefined && fresh.overlay.isConnected === true,
      `orphan=${orphan.isConnected}`,
    )
    fresh.overlay?.remove()
    entry[1] = home
    pane.remove()
  }

  // ---- 模态弹窗在场让位（2026-10-15 现场故障：设置弹窗被原生子视窗遮挡） ------
  //
  // 现场：DSH Dock 侧原生子视窗（WKWebView）挂在顶层 NSView，DOM 层的遮罩与
  // z-index 盖不住它。用户打开「设置」弹窗时，居中 800px 弹窗右半边被子视窗白底遮挡。
  // 必须保证：
  // 1. 模态弹窗挂载时，子视窗与 surface 立即让位（hide，dsceOpen="false"）；
  // 2. 模态弹窗在场期间，调用 open() 亦被拒绝；
  // 3. 模态弹窗卸载后，同一路监听自动恢复子视窗与 surface（open，dsceOpen="true"）；
  // 4. 普通非模态元素（无 dialog/modal 角色）进出不影响正常展示。
  {
    const face = win.__DSCE_TEST__
    const pane = doc.createElement('div')
    pane.className = 'X_paneRoot'
    const host = doc.createElement('div')
    host.className = 'dsce-dock-body'
    pane.appendChild(host)
    doc.body.appendChild(pane)
    const entry = RECTS.find(([selector]) => selector === '.dsce-dock-body')
    const home = entry[1]

    const chat = new face.EmbeddedChat()
    chat.attach(host)
    await until(() => chat.overlay !== undefined && chat.overlay.dataset.dsceOpen === 'true')
    check('chat is initially open and visible', chat.isOpen() === true && chat.overlay?.dataset.dsceOpen === 'true')

    // 普通元素（如侧栏菜单或一般内容）插入 body，不影响聊天浮层
    const nonModal = doc.createElement('div')
    nonModal.className = 'normal-banner'
    doc.body.appendChild(nonModal)
    chat.syncToHost()
    check('non-modal element does not block chat surface', chat.isOpen() === true)
    nonModal.remove()

    // ---- Tauri 环境（DSH Dock）：原生子视窗盖不住遮罩，必须让位 ----------------
    // 显式给出 __TAURI__ 桥：modalBlocksHost() 按宿主类型分流，无桥（web profile）
    // 与 Electron 都不让位，只有 tauri/custom 这类「聊天跑在原生视窗里」的壳才让。
    win.__TAURI__ = {
      core: {
        invoke: async (name) => {
          if (name === 'embed_chat_hide') return undefined
          return undefined
        },
      },
    }
    check('in Tauri environment, resolveGuestAdapter resolves TauriGuestAdapter', face.resolveGuestAdapter()?.id === 'tauri')

    // 挂载设置弹窗浮层（模拟 DSH SettingsPanel 挂载至 document.body）
    const modalOverlay = doc.createElement('div')
    modalOverlay.className = 'VOzbGW_overlay'
    modalOverlay.setAttribute('role', 'presentation')
    const modalPanel = doc.createElement('div')
    modalPanel.className = 'VOzbGW_panel'
    modalPanel.setAttribute('role', 'dialog')
    modalPanel.setAttribute('aria-modal', 'true')
    modalPanel.setAttribute('data-shortcut-modal', 'settings')
    modalOverlay.appendChild(modalPanel)
    doc.body.appendChild(modalOverlay)

    // 弹窗在场时必须让位：表面收起、子视窗 hide
    chat.syncToHost()
    check(
      'an active modal dialog hides the chat surface',
      chat.isOpen() === false && chat.overlay?.dataset.dsceOpen === 'false',
      String(chat.overlay?.dataset.dsceOpen),
    )

    // 弹窗在场时，尝试直接调用 open() 亦必须拒绝打开
    await chat.open()
    check(
      'calling open() while a modal dialog is active is rejected',
      chat.isOpen() === false && chat.overlay?.dataset.dsceOpen === 'false',
      String(chat.overlay?.dataset.dsceOpen),
    )

    // 关闭/移除设置弹窗后，自动恢复展示
    modalOverlay.remove()
    chat.syncToHost()
    check(
      'closing the modal dialog restores the chat surface',
      chat.isOpen() === true && chat.overlay?.dataset.dsceOpen === 'true',
      String(chat.overlay?.dataset.dsceOpen),
    )

    // ---- 官方桌面版（Electron）必须零干预：遮罩天然盖住聊天，hide 反而是回归 ----
    // Electron 下聊天是 DOM <webview>，住在 .dsce-overlay（z-index 200）里，
    // 官方设置遮罩 z-index 1000 本就盖在它上面——聊天在遮罩下依稀可见正是官方
    // 交互。此处若跟着 hide，聊天会整个消失（overlay display:none），是回归。
    // 摘掉 __TAURI__ 再给 dshDesktop：排除歧义，确保测的确实是 electron 分支
    // （两个都在时 Electron 在 GUEST_ADAPTERS 里排前，但那不该是隐含依赖）。
    delete win.__TAURI__
    win.dshDesktop = {
      browser: {
        acquire: async () => ({ lease: 'l1', partition: 'p1' }),
        release: async () => {},
      },
    }
    check('in Electron, resolveGuestAdapter resolves ElectronGuestAdapter', face.resolveGuestAdapter()?.id === 'electron')
    doc.body.appendChild(modalOverlay)
    chat.syncToHost()
    check(
      'in official Electron desktop, an active modal does not hide the surface (mask covers it natively)',
      chat.isOpen() === true && chat.overlay?.dataset.dsceOpen === 'true',
      String(chat.overlay?.dataset.dsceOpen),
    )
    await chat.open()
    check(
      'in Electron, open() during a modal still shows the surface',
      chat.isOpen() === true && chat.overlay?.dataset.dsceOpen === 'true',
      String(chat.overlay?.dataset.dsceOpen),
    )
    modalOverlay.remove()
    delete win.dshDesktop

    // ---- 无 adapter（web profile）同样不让位：浮层是 DOM，遮罩天然盖得住 ------
    check('with no bridge, resolveGuestAdapter returns undefined', face.resolveGuestAdapter() === undefined)
    doc.body.appendChild(modalOverlay)
    chat.syncToHost()
    check(
      'in the web profile, an active modal does not hide the surface either',
      chat.isOpen() === true && chat.overlay?.dataset.dsceOpen === 'true',
      String(chat.overlay?.dataset.dsceOpen),
    )
    modalOverlay.remove()

    await chat.destroy()
    entry[1] = home
    pane.remove()
  }

  const failed = checks.filter((entry) => !entry.ok)
  process.stdout.write(`${JSON.stringify({ plugin: plugin.name, checks, ok: failed.length === 0 }, null, 2)}\n`)
  buttonRoot.unmount()
  tabRoot.unmount()
  panelRoot.unmount()
  if (failed.length > 0) process.exitCode = 1
}

await main()
win.close()
