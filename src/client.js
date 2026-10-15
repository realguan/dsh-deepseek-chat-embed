/**
 * dsh-deepseek-chat-embed — a Codex-style chat switcher for the dsh desktop app.
 *
 * The Session header gains a segmented control that rotates between two chat
 * surfaces for the current Session:
 *
 *   · `DSH`       — the shipped dsh conversation (the plugin adds nothing to it)
 *   · `DeepSeek`  — chat.deepseek.com, embedded in a desktop webview
 *
 * The embedded surface is one app-wide guest, not one per Session: a single
 * `persist:` partition is what makes "sign in once, stay signed in" true, and
 * the shell caches partitions per workspace identity for the process lifetime.
 *
 * ## Why a webview, and why the odd handshake
 *
 * chat.deepseek.com refuses framing (`frame-ancestors 'none'`), so the embedded
 * surface must be a desktop `<webview>` — an iframe cannot work on any surface,
 * including the dsh Web GUI. The dsh desktop shell only permits a webview to
 * attach when it carries a *lease*: `params.src` must be exactly
 * `about:blank#<lease>` and `params.partition` must match the partition the
 * shell handed out for that lease. `window.dshDesktop.browser.acquire()` is the
 * only source of leases, and it lives in the Electron main world — which is
 * where dsh runs client plugin bundles, because it loads them as classic
 * scripts.
 *
 * Once attached, the guest ignores both `loadURL()` and further `src` writes;
 * only a document-level navigation from inside the guest moves it. And the
 * default Electron User-Agent trips chat.deepseek.com's "使用环境异常"
 * risk-control dialog, so the webview carries a normalized Chrome UA.
 *
 * These four facts were each established by experiment; see
 * `docs/embedding-contract.md` for the probes and raw observations.
 *
 * MIT License — see LICENSE.
 */

// ---------------------------------------------------------------------------
// Embedded-surface constants
// ---------------------------------------------------------------------------

/** The consumer chat surface this plugin embeds. */
const CHAT_URL = 'https://chat.deepseek.com/'

/**
 * Stable workspace identity for the shell's partition cache. Changing it logs
 * the user out of the embedded chat.
 */
const WORKSPACE_KEY = 'dsh-deepseek-chat-embed:v1'

/**
 * Chromium UA with the Electron token removed — without this, chat.deepseek.com
 * overlays a risk-control dialog on every load.
 */
const NORMALIZED_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

/** Bounds for the untrusted guest's startup handshake. */
const NAVIGATE_TIMEOUT_MS = 20000
const NAVIGATE_RETRY_MS = 400
const NAVIGATE_MAX_ATTEMPTS = 4

/**
 * Build identity, shown in the overlay's diagnostic block.
 *
 * Bumped per change on purpose: the packaged app ships no developer tools, so
 * "which build am I actually running" has to be answerable from the screen.
 */
const BUILD = 'v1.8.0-adapter-architecture'

/**
 * The right dock's DeepSeek tab type.
 *
 * `id` is the implementation identity and the key its body registers under in
 * the `sidebar.right.pane.tab` seat; `kind` is what `openTab` names. Both are
 * ours, so no shipped tab type can collide with them.
 */
const DEEPSEEK_TAB_ID = 'dsh-deepseek-chat-embed'
const DEEPSEEK_TAB_KIND = 'deepseek'

/**
 * Phases in which the embedded surface needs no explanation: not started yet, or
 * live. Anything else (acquiring, navigating, failed) makes the entry button's
 * tooltip carry its measured report.
 */
const SURFACE_CALM = ['idle', 'loaded']

// ---------------------------------------------------------------------------
// Multi-desktop environment & bridge detection
// ---------------------------------------------------------------------------

/**
 * Detect the current desktop runtime environment.
 * Supports:
 *  - 'electron': Official DSH Desktop (@deepseek-ai/dsh-desktop)
 *  - 'tauri': DSH Dock or custom Tauri v2 client
 *  - 'browser': Plain Web GUI
 */
function detectEnvironment() {
  if (typeof window === 'undefined') return { type: 'node', label: 'Node.js' }
  if (desktopBrowserBridge() !== undefined) {
    return { type: 'electron', label: 'DSH 官方桌面版 (Electron)' }
  }
  if (
    typeof window.__TAURI__ !== 'undefined' ||
    typeof window.__TAURI_INTERNALS__ !== 'undefined' ||
    typeof window.__DSH_PLATFORM__ !== 'undefined'
  ) {
    const os = window.__DSH_PLATFORM__?.os ?? 'Tauri'
    return { type: 'tauri', label: `DSH Dock (${os})` }
  }
  return { type: 'browser', label: 'Web 浏览器' }
}

/**
 * The page viewport's own size, reported to the shell with every geometry call.
 *
 * The native child view is positioned in *window* coordinates while every box
 * this plugin measures is in *page* coordinates, and on a titled window those
 * differ by the titlebar (measured: window 1280x795, page 1280x763 ⇒ 32px). Not
 * adding that put the child 32px too high — exactly over the right dock's tab
 * strip and its three controls, which then read as "the dock lost its buttons".
 *
 * Only the shell can compute the difference (it knows the window), and only the
 * page knows its own viewport — so the page reports its half and the shell does
 * the arithmetic. The page cannot do it alone: `window.outerHeight` equals
 * `window.innerHeight` in this WKWebView (measured: both 763).
 *
 * @returns {{width: number, height: number}} the page viewport in CSS pixels.
 */
function pageFrame() {
  if (typeof window === 'undefined') return { width: 0, height: 0, scale: 1 }
  return {
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
    // 窗口尺寸是物理像素，换算系数只有页面知道（壳侧 scale_factor() 实测不稳）。
    scale: window.devicePixelRatio || 1,
  }
}

/**
 * The row the shell draws its dock chrome in, or undefined when there is none.
 *
 * Chrome — the tab chips and the split / fullscreen / collapse toolbar — lives in
 * exactly one row above the tab body. Finding that row is what lets a late
 * re-measure be cheap: watching it costs a handful of nodes, whereas watching the
 * tab host that contains it costs every row the shell's own 文件 / 终端 tabs
 * render (see `watchChrome`).
 *
 * The row is found structurally, never by class name: the runtime renders chips
 * as `[data-sidebar-right-tab]` while only *reading* `[data-dockkit-tab]`, so
 * either spelling has to be accepted.
 *
 * @param host - the element the surface fills.
 * @returns the chrome row, or undefined when the shell draws none near it.
 */function chromeRowOf(host) {
  for (let node = host, level = 0; node !== null && node !== document.body && level < 3; node = node.parentElement, level += 1) {
    const strip = node.querySelector('[data-dockkit-strip], [data-dockkit-tab], [data-sidebar-right-tab], [class*="tabStrip"]')
    if (strip !== null) {
      // The row, not the strip: the strip itself can be unmounted and remounted
      // by the shell, and a watch on a detached node silently stops working.
      const row = strip.parentElement
      return row === null ? undefined : row
    }
  }
  return undefined
}

/**
 * Resolve the official Electron desktop guest bridge.
 */
function desktopBrowserBridge() {
  const desktop = typeof window === 'undefined' ? undefined : window.dshDesktop
  const browser = desktop === undefined || desktop === null ? undefined : desktop.browser
  if (browser === undefined || browser === null) return undefined
  if (typeof browser.acquire !== 'function' || typeof browser.release !== 'function') return undefined
  return browser
}

/**
 * Universal Native Bridge Interface:
 * Any desktop shell (Tauri, Wails, etc.) can expose `window.__DSH_CHAT_EMBED__`
 * to provide native multi-webview / child-webview embedding:
 *   - open({ url, rect })
 *   - hide()
 *   - resize({ rect })
 *   - close()
 */
function nativeCustomBridge() {
  const custom = typeof window !== 'undefined' ? window.__DSH_CHAT_EMBED__ : undefined
  if (custom && typeof custom.open === 'function' && typeof custom.hide === 'function') {
    return custom
  }
  return undefined
}

/**
 * Whether the current surface supports the embedded chat or companion surface.
 * Supported on both Electron and Tauri desktop environments.
 */
function isEmbedSupported() {
  const env = detectEnvironment()
  return env.type === 'electron' || env.type === 'tauri'
}

/**
 * Resolve React for this bundle.
 *
 * A native client bundle receives React as a real module: the web frontend's
 * `staticModules` seed table publishes `react`, and the `client-modules`
 * factory hands it over through `require`. There is no `globalThis.React` — a
 * dynamic payload gets React as a closure symbol instead, which is the other
 * supported shape.
 *
 * `require` is read defensively because this same source is also applied by the
 * Node-side profile loader, where ESM has no `require` at all.
 *
 * @returns the React namespace, or undefined when unavailable.
 */
function resolveReact() {
  const loader = typeof globalThis.__dshRequire === 'function' ? globalThis.__dshRequire : globalThis.require
  if (typeof loader !== 'function') return undefined
  try {
    return loader('react')
  } catch (error) {
    console.error('[deepseek-chat-embed] react is unavailable in this bundle', error)
    return undefined
  }
}


// ---------------------------------------------------------------------------
// Embedded surface (one app-wide guest)
// ---------------------------------------------------------------------------

/**
 * Mount an embedded chat guest into `container`, returning a handle.
 *
 * This is the whole lease handshake in one place, and is exposed for the
 * harness in `test/` so the handshake can be exercised against a faithful
 * replica of the shell's validation without mounting the React UI.
 *
 * @param options.container - live element to hold the guest.
 * @param options.onStatus - optional `(phase, detail)` progress callback.
 * @returns a handle; `close()` releases the lease and detaches the guest.
 * @throws when this surface has no desktop guest bridge.
 */
async function mountGuest(options) {
  const { container, onStatus = () => {} } = options
  const bridge = desktopBrowserBridge()
  if (bridge === undefined) {
    throw new Error(
      'dsh-deepseek-chat-embed: no desktop guest bridge on this surface — the embedded chat requires the dsh desktop app.',
    )
  }

  onStatus('acquiring', '正在申请桌面 webview 租约…')
  const { lease, partition } = await bridge.acquire(WORKSPACE_KEY)
  report('lease:acquired', { leaseLength: lease.length, partition })

  const el = document.createElement('webview')
  el.setAttribute('partition', partition)
  el.setAttribute('useragent', NORMALIZED_UA)
  el.setAttribute('style', 'display:flex;width:100%;height:100%;border:0;background:#fff')
  container.appendChild(el)

  let navigated = false
  let settled = false
  let settle
  const ready = new Promise((resolve) => {
    settle = resolve
  })
  const finish = (ok) => {
    if (settled) return
    settled = true
    settle(ok)
  }

  const close = async () => {
    try {
      el.remove()
    } catch {
      /* the element may already be detached */
    }
    await bridge.release(lease).catch(() => {})
  }

  /**
   * Leave `about:blank#<lease>` for the chat.
   *
   * `loadURL()` and `src` writes are silently ignored on a leased guest, so the
   * only working navigation is a document-level one issued inside the guest.
   * Retried because the first `dom-ready` can arrive before the shell has
   * finished recording its side of the lease.
   */
  const navigate = async (attempt) => {
    if (navigated) return
    try {
      await el.executeJavaScript(`location.href = ${JSON.stringify(CHAT_URL)}`)
      navigated = true
      report('navigate:issued', { attempt })
    } catch (error) {
      if (attempt >= NAVIGATE_MAX_ATTEMPTS) {
        onStatus('failed', '无法启动导航')
        finish(false)
        return
      }
      setTimeout(() => void navigate(attempt + 1), NAVIGATE_RETRY_MS)
    }
  }

  const timeout = setTimeout(() => {
    if (navigated) return
    onStatus('failed', '桌面 webview 启动超时')
    report('navigate:timeout', { navigated })
    finish(false)
  }, NAVIGATE_TIMEOUT_MS)

  // Every listener is installed before `src` is set, so the shell cannot attach
  // the guest into a window where dom-ready would be missed.
  el.addEventListener('dom-ready', () => {
    // Inject Chinese language defaults and warn suppression into Electron guest
    void el.executeJavaScript(`
      try {
        Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
        localStorage.setItem('closeUnsafeEnvWarn', 'true');
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.includes('localePreference')) {
            localStorage.setItem(k, '"zh_CN"');
          }
        }
      } catch (e) {}
    `).catch(() => {})

    const url = typeof el.getURL === 'function' ? el.getURL() : ''
    if (!navigated) {
      onStatus('attached', '桌面 webview 已就绪')
      void navigate(0)
      return
    }
    if (url !== '' && !url.startsWith('about:blank')) {
      clearTimeout(timeout)
      onStatus('loaded', url)
      report('guest:loaded', { url })
      finish(true)
    }
  })
  el.addEventListener('did-navigate', (event) => {
    const url = typeof event?.url === 'string' ? event.url : ''
    if (url === '' || url.startsWith('about:blank')) return
    clearTimeout(timeout)
    onStatus('loaded', url)
    finish(true)
  })
  el.addEventListener('did-fail-load', (event) => {
    if (!navigated || event?.isMainFrame === false) return
    onStatus('failed', `${event?.errorDescription ?? 'load failed'} (${event?.errorCode ?? '?'})`)
  })

  el.addEventListener('console-message', (event) => {
    if (event?.message === '__DSCE_ACTION_EXPAND__') {
      if (typeof options.onGuestExpandAction === 'function') {
        options.onGuestExpandAction()
      }
    }
  })

  el.setAttribute('src', `about:blank#${lease}`)

  const ok = await ready
  return {
    element: el,
    lease,
    partition,
    ok: ok === true,
    currentUrl: () => (typeof el.getURL === 'function' ? el.getURL() : ''),
    close,
  }
}

/**
 * Find the guest page's sidebar and its toggle, and mark both.
 *
 * This is the expensive half of the adapter (it walks the page once), and it
 * runs only when the cheap reads stop answering — a fresh page, or a re-render
 * that replaced the marked nodes. The two marks are plain data attributes, so
 * the per-tick read costs one `querySelector` instead of a full scan: at 150ms
 * ticks a scan of chat.deepseek.com's ~1500 elements would fight the shell's own
 * animation for the main thread, which is exactly the stutter it caused.
 *
 * Nothing here names a vendor class. Measured 2026-10-10: the controls are
 * `div.ds-button[role=button]`, 34×34, with no `aria-label`; the open sidebar is
 * a ~257px column holding the "new chat" entry, whose toggle sits at that
 * column's top-right; with the sidebar closed the toggle is the leftmost control
 * of the page's top-left cluster.
 *
 * @returns 'expanded' | 'collapsed' | 'not-found'.
 */
const GUEST_SIDEBAR_INSTALL_SCRIPT = `(() => {
  const rect = (el) => el.getBoundingClientRect()
  const shown = (el) => { const r = rect(el); return r.width > 4 && r.height > 4 }
  const all = [...document.querySelectorAll('*')]
  const entry = all.find((el) => el.children.length === 0
    && /开启新对话|开始新对话|新建对话|New chat/.test(el.textContent || '') && shown(el))
  let column = null
  if (entry !== undefined) {
    for (let el = entry.parentElement; el !== null; el = el.parentElement) {
      const r = rect(el)
      if (r.width >= 180 && r.height > window.innerHeight * 0.4) { column = el; break }
    }
  }
  const controls = all.filter((el) => (el.tagName === 'BUTTON' || el.tagName === 'A'
    || el.getAttribute('role') === 'button') && shown(el))
  const inHeader = (el) => rect(el).top < 90
  let toggle = null
  if (column !== null) {
    toggle = controls.filter((el) => inHeader(el) && Math.abs(rect(el).right - rect(column).right) < 70)
      .sort((a, b) => rect(a).top - rect(b).top)[0] || null
  } else {
    toggle = controls.filter((el) => inHeader(el) && rect(el).left < 200)
      .sort((a, b) => rect(a).left - rect(b).left || rect(a).top - rect(b).top)[0] || null
  }
  for (const marked of document.querySelectorAll('[data-dsce-side],[data-dsce-toggle]')) {
    marked.removeAttribute('data-dsce-side')
    marked.removeAttribute('data-dsce-toggle')
  }
  if (toggle === null) return 'not-found'
  toggle.setAttribute('data-dsce-toggle', '')
  if (!window.__dsce_click_installed) {
    window.__dsce_click_installed = true
    document.addEventListener('pointerdown', (e) => {
      try {
        const target = e.target
        if (!target) return
        const btn = target.closest('button, [role="button"], a')
        if (!btn) return
        const r = btn.getBoundingClientRect()
        if (r.top > 90 || r.width < 10) return
        const isHeaderToggle = r.left < 200
        const side = document.querySelector('[data-dsce-side]')
        const isExpanded = side && side.getBoundingClientRect().width > 120
        if (!isExpanded && isHeaderToggle) {
          console.log('__DSCE_ACTION_EXPAND__')
        }
      } catch (err) {}
    }, true)
  }
  if (column === null) return 'collapsed'
  column.setAttribute('data-dsce-side', '')
  return 'expanded'
})()`

/**
 * Read the marked sidebar's state. One query, one rect — cheap enough to run
 * several times a second without the guest noticing.
 *
 * @returns 'expanded' | 'collapsed' | 'unknown' (marks are gone: re-install).
 */
const GUEST_SIDEBAR_READ_SCRIPT = `(() => {
  const side = document.querySelector('[data-dsce-side]')
  if (side !== null) {
    const r = side.getBoundingClientRect()
    if (r.width > 4) return r.width > 120 ? 'expanded' : 'collapsed'
  }
  const toggle = document.querySelector('[data-dsce-toggle]')
  if (toggle !== null) {
    const r = toggle.getBoundingClientRect()
    if (r.width > 4) return r.left > 150 ? 'expanded' : 'collapsed'
  }
  return 'unknown'
})()`

/**
 * Click the marked toggle.
 *
 * A missing mark reports `not-found` instead of searching: the caller reinstalls
 * first, so an adapter for someone else's page never presses a control it has
 * not just identified and measured.
 *
 * @returns 'clicked:<label>' | 'not-found'.
 */
const GUEST_SIDEBAR_TOGGLE_SCRIPT = `(() => {
  const target = document.querySelector('[data-dsce-toggle]')
  if (target === null) return 'not-found'
  const r = target.getBoundingClientRect()
  if (r.width <= 4 || r.height <= 4) return 'not-found'
  const label = String(target.getAttribute('aria-label') || target.title || target.className || '').slice(0, 30)
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ctor = type.indexOf('pointer') === 0 ? PointerEvent : MouseEvent
    try { target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window })) } catch (e) {}
  }
  return 'clicked:' + label
})()`

/**
 * The smallest possible read of the guest document: the URL the guest reports,
 * the readiness of the document it exposed, and how many elements that document
 * has. Reported alongside the structural read, because "why did that come back
 * empty" is answered here rather than by guessing at the page.
 */
const GUEST_BASICS_SCRIPT = `(() => {
  const d = document
  let count = -1
  try { count = d.querySelectorAll('*').length } catch (e) {}
  return JSON.stringify({
    href: String(location.href).slice(0, 80),
    readyState: String(d.readyState),
    title: String(d.title || '').slice(0, 40),
    elements: count,
    bodyChildren: d.body ? d.body.childElementCount : -1,
  })
})()`

const GUEST_SHAPE_SCRIPT = `(() => {
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
  }
  const info = (el) => ({
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 70),
    role: el.getAttribute('role') || undefined,
    label: (el.getAttribute('aria-label') || el.title || '').slice(0, 30) || undefined,
    rect: rect(el),
  })
  const all = [...document.querySelectorAll('*')]
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  // The page's controls are not <button>s: collect whatever is clickable.
  const clickable = all
    .filter((el) => (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button'
      || (el.getAttribute('tabindex') === '0' && el.children.length <= 2)) && visible(el))
    .slice(0, 40)
    .map(info)
  // DeepSeek's "new chat" entry point names the column whose width is the
  // sidebar's state.
  const needle = all.find((el) => el.children.length === 0 && /开启新对话|New chat|开始新对话/.test(el.textContent || ''))
  const chain = []
  for (let el = needle, i = 0; el && i < 8; el = el.parentElement, i += 1) chain.push(info(el))
  const columns = all
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width >= 150 && r.width <= 420 && r.height > innerHeight * 0.5 })
    .slice(0, 15)
    .map(info)
  const named = all
    .filter((el) => /side|collaps|expand|toggle|panel|drawer/i.test(String(el.className || '') + ' ' + (el.getAttribute('aria-label') || '')))
    .slice(0, 20)
    .map(info)
  return JSON.stringify({
    url: location.href,
    elements: all.length,
    viewport: [innerWidth, innerHeight],
    clickable,
    chain,
    columns,
    named,
  })
})()`

/**
 * How long a single guest call may take before the caller gives up. The guest
 * scripts answer in milliseconds; a stalled bridge must not wedge the rule that
 * polls the guest's sidebar.
 */
const TAURI_BRIDGE_TIMEOUT_MS = 1500

/**
 * How many bridged calls may be outstanding at once. The guest-side rule polls
 * every 80ms without awaiting, so this is what keeps a stalled bridge from
 * growing an unbounded queue of polls.
 */
const MAX_OUTSTANDING_CALLS = 8

/**
 * Mount the chat as DSH Dock's native child webview and hand back the same
 * small handle the Electron lease produces, so everything above — the sidebar
 * rule, the shape probe, `guestScriptable()` — works unchanged.
 *
 * Tauri never hands the guest's runtime back to the page, so both directions
 * ride one narrow channel (dsh-dock ADR-0033):
 *
 *   · host → guest: `embed_chat_eval` validates that the caller is the local
 *     workbench, runs one script in the guest and returns at once;
 *   · guest → host: the wrapper writes `encodeURIComponent(JSON.stringify(…))`
 *     into `document.title` behind a fixed prefix; Rust parses it and re-emits
 *     it to `main` as `dsce:guest-message` (same request id).
 *
 * Two rules keep that channel honest. Calls are **serialised** — one title
 * marker is in flight at a time, so the guest's own title updates cannot eat an
 * answer — and every answer is **paired by request id**, so a late or repeated
 * event can never settle the wrong call. A call that gets no answer fails after
 * {@link TAURI_BRIDGE_TIMEOUT_MS} instead of hanging.
 *
 * @param options.geometry - the surface box, in viewport coordinates.
 * @param options.onExpand - called when the guest's own sidebar was opened by
 *   hand (the guest signals it through the same channel).
 * @returns the handle, or undefined when this shell cannot embed.
 */
async function mountTauriGuest(options) {
  const tauri = typeof window === 'undefined' ? undefined : window.__TAURI__
  if (tauri?.core?.invoke === undefined) return undefined

  await tauri.core.invoke('embed_chat_open', { rect: options.geometry, frame: pageFrame() })

  /** @type {Map<string, {resolve: (value: any) => void, reject: (error: Error) => void, timer: any}>} */
  const pending = new Map()
  const seen = new Set()
  let serial = 0
  let chain = Promise.resolve()
  let outstanding = 0

  const unlisten = typeof tauri.event?.listen === 'function'
    ? await tauri.event.listen('dsce:guest-message', (event) => {
        const message = event?.payload ?? {}
        if (message.kind === 'expand') {
          // The guest stamps each signal; a repeated delivery is the same click.
          if (typeof message.requestId !== 'string' || seen.has(message.requestId)) return
          if (seen.size > 200) seen.clear()
          seen.add(message.requestId)
          if (typeof options.onExpand === 'function') options.onExpand()
          return
        }
        if (message.kind !== 'result') return
        const entry = pending.get(message.requestId)
        if (entry === undefined) return
        pending.delete(message.requestId)
        clearTimeout(entry.timer)
        try {
          entry.resolve(decodeGuestAnswer(message.value))
        } catch (error) {
          entry.reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    : undefined

  /**
   * @param code - script whose value is the answer.
   * @returns the guest's answer.
   */
  const call = async (code) => {
    serial += 1
    const requestId = `r${serial}-${Date.now().toString(36)}`
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`guest bridge timed out after ${TAURI_BRIDGE_TIMEOUT_MS}ms`))
      }, TAURI_BRIDGE_TIMEOUT_MS)
      pending.set(requestId, { resolve, reject, timer })
    })
    try {
      await tauri.core.invoke('embed_chat_eval', { requestId, script: code })
    } catch (error) {
      const entry = pending.get(requestId)
      if (entry !== undefined) {
        pending.delete(requestId)
        clearTimeout(entry.timer)
        entry.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return await answer
  }

  const handle = {
    element: {
      executeJavaScript: (code) => {
        // The sidebar rule polls the guest every 80ms and does not await, so a
        // stalled bridge would otherwise queue calls faster than they can fail.
        // Past this depth the newest poll is dropped instead of remembered: it
        // is a poll, and the next one is 80ms away.
        if (outstanding >= MAX_OUTSTANDING_CALLS) {
          return Promise.reject(new Error('guest bridge busy'))
        }
        outstanding += 1
        const queued = chain.then(() => call(code), () => call(code))
        chain = queued.then(() => undefined, () => undefined)
        return queued.finally(() => {
          outstanding -= 1
        })
      },
    },
    currentUrl: () => CHAT_URL,
    close: async () => {
      for (const [requestId, entry] of pending) {
        pending.delete(requestId)
        clearTimeout(entry.timer)
        entry.reject(new Error('guest closed'))
      }
      try {
        if (typeof unlisten === 'function') unlisten()
      } catch {
        /* an already-dropped listener is not worth failing over */
      }
      await tauri.core.invoke('embed_chat_close').catch(() => {})
    },
  }
  return handle
}

/**
 * Decode one bridged answer.
 *
 * The wrapper sends `encodeURIComponent(JSON.stringify(value))`; a script that
 * threw arrives as `{error}` and is raised here, so a broken guest reads as a
 * failed call instead of a silent `undefined`.
 *
 * @param encoded - the payload as it arrived on the event.
 * @returns the decoded value.
 */
function decodeGuestAnswer(encoded) {
  let parsed
  try {
    parsed = JSON.parse(decodeURIComponent(String(encoded ?? 'null')))
  } catch {
    return undefined
  }
  if (parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string') {
    throw new Error(parsed.error)
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Desktop Guest Adapters: Strategy Pattern for Electron, Tauri & Native Bridge
// ---------------------------------------------------------------------------

/**
 * Unified Desktop Guest Handle contract returned by all adapters.
 *
 * @typedef {Object} DesktopGuestHandle
 * @property {{ executeJavaScript: (code: string) => Promise<any> }} element
 * @property {() => string} currentUrl
 * @property {(rect: any, frame: any) => Promise<void>} syncGeometry
 * @property {(visible: boolean, rect?: any, frame?: any) => Promise<void>} setVisible
 * @property {() => Promise<void>} close
 * @property {boolean} [ok]
 * @property {string} [lease]
 * @property {string} [partition]
 */

/**
 * Adapter 1: Official Electron Desktop Shell (<webview> + lease).
 */
const ElectronGuestAdapter = {
  id: 'electron',
  label: 'DSH 官方桌面版 (Electron)',
  isAvailable() {
    return desktopBrowserBridge() !== undefined
  },
  async mount(options) {
    const raw = await mountGuest(options)
    return {
      element: raw.element,
      ok: raw.ok,
      lease: raw.lease,
      partition: raw.partition,
      currentUrl: raw.currentUrl,
      async syncGeometry() {
        // Electron webview is an in-DOM element styled by CSS; no external IPC needed
      },
      async setVisible() {
        // Overlay CSS controls display; no external IPC needed
      },
      close: raw.close,
    }
  },
}

/**
 * Adapter 2: DSH Dock or Tauri v2 Client (Native Child Webview + IPC channel).
 */
const TauriGuestAdapter = {
  id: 'tauri',
  label: 'DSH Dock (Tauri)',
  isAvailable() {
    if (typeof window === 'undefined') return false
    return (
      typeof window.__TAURI__ !== 'undefined' ||
      typeof window.__TAURI_INTERNALS__ !== 'undefined' ||
      typeof window.__DSH_PLATFORM__ !== 'undefined'
    )
  },
  async syncGeometry(rect, frame) {
    if (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) {
      await window.__TAURI__.core.invoke('embed_chat_resize', { rect, frame }).catch(() => {})
    }
  },
  async setVisible(visible, rect, frame) {
    if (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) {
      if (visible && rect !== undefined && frame !== undefined) {
        await window.__TAURI__.core.invoke('embed_chat_open', { rect, frame }).catch(() => {})
      } else if (!visible) {
        await window.__TAURI__.core.invoke('embed_chat_hide').catch(() => {})
      }
    }
  },
  async mount(options) {
    const raw = await mountTauriGuest(options)
    if (raw === undefined) {
      throw new Error('Tauri guest mounting failed')
    }
    return {
      element: raw.element,
      ok: true,
      currentUrl: raw.currentUrl,
      syncGeometry: (rect, frame) => TauriGuestAdapter.syncGeometry(rect, frame),
      setVisible: (visible, rect, frame) => TauriGuestAdapter.setVisible(visible, rect, frame),
      close: raw.close,
    }
  },
}

/**
 * Adapter 3: Universal Native Custom Bridge (window.__DSH_CHAT_EMBED__).
 */
const CustomNativeGuestAdapter = {
  id: 'custom',
  label: '原生多视窗模式',
  isAvailable() {
    return nativeCustomBridge() !== undefined
  },
  async mount(options) {
    const custom = nativeCustomBridge()
    if (custom === undefined) throw new Error('Native custom bridge missing')
    await custom.open({ url: CHAT_URL, rect: options.geometry })
    return {
      element: {
        executeJavaScript: async (code) => {
          if (typeof custom.eval === 'function') return await custom.eval(code)
          throw new Error('Custom bridge eval unsupported')
        },
      },
      ok: true,
      currentUrl: () => CHAT_URL,
      async syncGeometry(rect) {
        await custom.resize?.({ rect })
      },
      async setVisible(visible, rect) {
        if (visible) await custom.open?.({ url: CHAT_URL, rect })
        else await custom.hide?.()
      },
      close: async () => {
        await custom.close?.()
      },
    }
  },
}

const GUEST_ADAPTERS = [CustomNativeGuestAdapter, ElectronGuestAdapter, TauriGuestAdapter]

/**
 * Resolve the applicable desktop guest adapter based on the runtime environment.
 * @returns {typeof ElectronGuestAdapter | typeof TauriGuestAdapter | typeof CustomNativeGuestAdapter | undefined}
 */
function resolveGuestAdapter() {
  for (const adapter of GUEST_ADAPTERS) {
    if (adapter.isAvailable()) return adapter
  }
  return undefined
}

/** 插件浮层的 DOM 标记（即使 class 被改掉也认得出是自己的残骸）。 */
const OVERLAY_SURFACE_ATTR = 'data-dsh-deepseek-chat-embed-surface'

/**
 * 行内写入浮层的四条「脱流」不变量。
 *
 * 存在的理由是一次现场故障（2026-10-14）：浮层的 `position: fixed` 只写在插件
 * 自己注入的 `<style>` 里，而那张样式表是可被 dispose 的。样式先走、浮层后走
 * （或干脆没走）时，`.dsce-overlay` 退化成 `<body>` 末尾的普通块：
 *
 * - 壳的 `#root` 是 `height:100%`，浮层排在它**后面**，于是整个文档被撑高，
 *   滚轮能把壳整页推上去 —— 用户看到的「还能继续滑、多出额外的内容」；
 * - 那张没样式的浮层还挂着一个活着的 guest，只按自己最后拿到的
 *   `left/top/width/height` 内联值（现场是 538x124）画成一张硬边白卡，贴在
 *   窗口左侧、紧挨壳内容的下边缘。
 *
 * 实测（Chromium 155，与 Electron 同引擎）：移除样式表后 `scrollHeight` 由
 * 789 变 913（+124，正好是该层高度），`position` 由 fixed 变 static。
 * 所以这几条不变量必须写进行内样式：不依赖任何可被移除的样式表。
 *
 * @param overlay - 浮层元素。
 */
function markOverlaySurface(overlay) {
  overlay.setAttribute(OVERLAY_SURFACE_ATTR, '1')
  overlay.style.position = 'fixed'
  overlay.style.zIndex = '200'
  overlay.style.display = overlay.dataset.dsceOpen === 'true' ? 'block' : 'none'
  overlay.style.overflow = 'hidden'
  overlay.style.boxSizing = 'border-box'
  overlay.style.background = 'var(--dsw-alias-bg-base, #ffffff)'
  // 里面两层同理：样式表缺席时 surface 仍要铺满浮层、body 仍要有高度，否则 guest
  // 会被压成 0 高（Chromium 实测：只补浮层不变量时 guest=538x0）。
  const surface = overlay.firstElementChild
  if (surface instanceof HTMLElement) {
    surface.style.position = 'absolute'
    surface.style.inset = '0'
    surface.style.display = 'flex'
    surface.style.flexDirection = 'column'
    surface.style.background = '#ffffff'
    const surfaceBody = surface.querySelector('.dsce-surface__body')
    if (surfaceBody instanceof HTMLElement) {
      surfaceBody.style.position = 'relative'
      surfaceBody.style.flex = '1 1 auto'
      surfaceBody.style.minHeight = '0'
      surfaceBody.style.width = '100%'
      surfaceBody.style.height = '100%'
    }
  }
}

/**
 * 宿主盒子是否已经整体离开视口。
 *
 * 原生子视窗不参与页面滚动、也盖不住（DSH Dock），固定浮层同样不会自己跟手：
 * 宿主被滚出视口后，surface 留在原地就是「悬在无关内容上方」。判定用视口四条边，
 * 不看滚动容器是谁——内层滚动条、文档滚动都一样。
 *
 * @param rect - 宿主的视口矩形。
 * @returns 是否整块离开视口。
 */
function hostBoxIsOffScreen(rect) {
  if (typeof window === 'undefined') return false
  const viewportWidth = window.innerWidth || 0
  const viewportHeight = window.innerHeight || 0
  if (viewportWidth === 0 && viewportHeight === 0) return false
  return rect.bottom <= 0 || rect.top >= viewportHeight
    || rect.right <= 0 || rect.left >= viewportWidth
}

/**
 * 把动作压到下一帧执行，连续触发一帧最多跑一次。
 *
 * chrome / modal / scroll 三条突发路径共用。它们都可能在一次交互里连触发数次，
 * 而每次的成本是一次文档级测量（`chromeBottom`）或强制重排——逐次全跑就是插件
 * 自己记过的「1434 次 resize、全同一个 rect」那类事故，同 Dock 里其它 pane
 * 都要替我们付账。没有 rAF 的环境退化成 16ms 定时器。
 *
 * @param {() => void} run - 实际要执行的动作。
 * @returns {() => void} 节流后的触发函数（可安全重复调用）。
 */
function frameThrottle(run) {
  let queued = false
  return () => {
    if (queued) return
    queued = true
    const fire = () => {
      queued = false
      run()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fire)
    else setTimeout(fire, 16)
  }
}

/** 模态弹窗选择器：命中任何独占前台、具有遮罩属性或系统弹窗角色的容器 */
const MODAL_DIALOG_SELECTOR =
  '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], [data-shortcut-modal], dialog[open]'

/**
 * 页面里是否存在**活动状态**的模态弹窗（设置外壳、通用 Modal、确认弹窗等）。
 *
 * 这是原始事实判定，不含策略：「有模态开着」不等于「一定压住我们的宿主」——
 * 策略在 {@link EmbeddedChat#modalBlocksHost}。两者分开，是因为将来若出现
 * 不遮全屏的模态（如只盖左栏的抽屉），只需改策略一处。
 *
 * 2026-10-15 现场故障：DSH Dock 下 DeepSeek Chat 是原生子视窗（WKWebView/NSView），
 * 位于主窗口原生图层之上，不受 DOM z-index 约束。当用户打开「设置」等居中弹窗时，
 * 800px 宽的弹窗卡片右半部分被展开的聊天白底完全遮挡，且右侧点击无法穿透至遮罩。
 *
 * 判定依据：
 * - DSH 的所有阻断性模态（SettingsPanel、primitives 的 Modal、Onboarding 等）
 *   均在 document.body 下挂载带 `role="dialog"` 且 `aria-modal="true"`，或带有 `data-shortcut-modal`；
 * - 排除插件自身持有的浮层与宿主节点（自己的 surface 不构成对自己的遮挡）；
 * - 确保节点真实挂载、未被 hidden/inert，且未处于 display:none。
 *
 * 成本：一次 document 级 `querySelectorAll`（属性选择器，不触发重排）。
 *
 * @param {Document | undefined} doc - 页面文档对象。
 * @returns {boolean} 是否存在活动模态弹窗。
 */
function anyModalActive(doc) {
  if (typeof doc === 'undefined' || !doc || !doc.body) return false
  let dialogs
  try {
    dialogs = doc.querySelectorAll(MODAL_DIALOG_SELECTOR)
  } catch {
    return false
  }
  for (let i = 0; i < dialogs.length; i++) {
    const el = dialogs[i]
    if (!(el instanceof Element)) continue
    // 排除插件自身的浮层或宿主内部节点
    if (el.closest('.dsce-overlay') || el.closest('.dsce-dock-body') || el.closest('.dsce-main-panel')) {
      continue
    }
    // 确保元素真正在文档中
    if (!el.isConnected) continue
    // 检查隐藏属性
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') continue
    if (el.closest?.('[hidden], [inert]')) continue
    // 检查计算样式（若宿主环境支持）
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const style = window.getComputedStyle(el)
        if (style && (style.display === 'none' || style.visibility === 'hidden')) continue
      } catch {}
    }
    return true
  }
  return false
}

/**
 * 清掉插件自己留下的浮层残骸。
 *
 * 残骸的代价不是「多一个死节点」：它在流内会把壳的文档撑高、整页可滚，还会把
 * 一个仍然活着的 guest 画在陌生位置（见 `markOverlaySurface`）。所以两部分都清：
 * 应用期先扫一遍（上一次 fiber 的残骸不该等到下一次 open 才走），样式表被
 * dispose 时再扫一遍（样式与浮层同寿）。
 *
 * @returns {number} 清掉的节点数。
 */
function sweepOverlayOrphans() {
  if (typeof document === 'undefined') return 0
  let removed = 0
  try {
    for (const stale of document.querySelectorAll(`.dsce-overlay, [${OVERLAY_SURFACE_ATTR}]`)) {
      stale.remove()
      removed += 1
    }
  } catch {
    /* 清残骸失败不该连带把插件拖下水 */
  }
  if (removed > 0) report('overlay-orphans-swept', { removed })
  return removed
}

/**
 * Owns the single embedded chat guest and its host overlay.
 *
 * The guest is deliberately never unmounted while the app lives: reloading
 * chat.deepseek.com on every Session switch would throw away its in-page state.
 * Only `destroy()` releases the lease.
 */
class EmbeddedChat {
  constructor() {
    /** @type {HTMLElement | undefined} */ this.overlay = undefined
    /** @type {Element | undefined} */ this.guestHost = undefined
    /** @type {any} */ this.handle = undefined
    /** @type {Promise<any> | undefined} */ this.pending = undefined
    /** @type {(phase: string, detail: string) => void} */ this.onStatus = () => {}
    /** @type {Set<() => void>} */ this.listeners = new Set()
    /** @type {string} */ this.phase = 'idle'
    /** @type {string} */ this.detail = ''
    /** @type {boolean} */ this.visible = false
    /** @type {boolean} */ this.destroyed = false
    /** @type {HTMLElement | undefined} */ this.host = undefined
    /** @type {ResizeObserver | undefined} */ this.hostObserver = undefined
    /** @type {number | undefined} */ this.animatingFrame = undefined
    /** @type {boolean} */ this.flipping = false
    /** @type {boolean} */ this.animating = false
    /** @type {(() => void) | undefined} */ this.onGuestExpandAction = undefined
    /** @type {{left:number,top:number,width:number,height:number} | undefined} */ this.geometry = undefined
    /** @type {string | undefined} */ this.lastError = undefined
    /** @type {boolean} */ this.guestProbed = false
    /** @type {Set<Element>} */ this.dockDomReported = new Set()
    /** @type {number | undefined} */ this.chromeInset = undefined
    /** @type {ReturnType<typeof setTimeout>[] | undefined} */ this.chromeTimers = undefined
    /** @type {MutationObserver | undefined} */ this.chromeObserver = undefined
    /** @type {MutationObserver | undefined} */ this.modalObserver = undefined
    /** @type {number | undefined} */ this.guestEvalFailureAt = undefined
  }

  /** @param {() => void} listener - called on every phase change. @returns unsubscribe. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Notify all subscribers (React controls, etc.) of a state change. */
  notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[deepseek-chat-embed] status listener failed', error)
      }
    }
  }

  /** @param {string} phase @param {string} detail - record and broadcast progress. */
  setStatus(phase, detail) {
    this.phase = phase
    this.detail = detail
    if (this.overlay !== undefined) {
      const pill = this.overlay.querySelector('.dsce-surface__pill')
      const dot = this.overlay.querySelector('.dsce-surface__dot')
      const text = this.overlay.querySelector('.dsce-surface__text')
      const retry = this.overlay.querySelector('.dsce-surface__retry')
      const stuck = phase === 'failed' || phase === 'unsupported'
      if (pill !== null) pill.hidden = !(stuck || phase === 'acquiring' || phase === 'attached' || phase === 'navigating')
      if (dot !== null) dot.dataset.phase = phase
      if (text !== null) text.textContent = stuck ? detail : phase === 'loaded' ? '' : detail
      if (retry !== null) retry.hidden = !stuck
    }
    this.notify()
  }

  /**
   * Build the host overlay.
   *
   * It is inserted above the shell's whole app tree so no app stacking context
   * can trap it, then positioned onto the centre pane by measurement. Letting it
   * cover the sidebar hides the Session list needed to switch Sessions — that
   * was a regression, not a preference.
   *
   * @returns the host overlay element.
   */
  ensureOverlay() {
    if (this.overlay !== undefined && this.overlay.isConnected) return this.overlay
    // Sweep orphans first. A fiber that re-runs leaves its previous overlay in
    // the document, and a leftover element is not just dead weight: it answers
    // `document.querySelector('.dsce-overlay')` for anyone inspecting state,
    // which is how this defect hid for so long.
    sweepOverlayOrphans()
    const overlay = document.createElement('div')
    overlay.className = 'dsce-overlay'
    overlay.dataset.dsceOpen = 'false'
    // 2026-10-14 现场故障：这一层的「脱流」原本**只**由插件自己那张 <style>
    // 提供（`.dsce-overlay{position:fixed}`）。样式表一旦先走一步（fiber 重挂
    // 后的第一次 open 之前、或 destroy() 中途抛错），它就退化成 <body> 末尾的
    // 普通块：壳的文档被撑高（Chromium 实测 overflow 0 → 该层的高度）、整页可滚，
    // 并留下一张小尺寸的聊天白卡贴在窗口左侧 —— 正是用户滚轮能一直往下滑、
    // 「多出额外内容」的那张截图。所以把「永不在流内」写成行内不变量。
    markOverlaySurface(overlay)
    // One compact pill, and only when the guest cannot carry itself: the
    // embedded page paints its own chrome, so a permanent status bar would just
    // be a second header stacked under dsh's.
    overlay.innerHTML =
      '<div class="dsce-surface">' +
      '<div class="dsce-surface__pill" hidden>' +
      '<span class="dsce-surface__dot" data-phase="idle"></span>' +
      '<span class="dsce-surface__text"></span>' +
      '<button type="button" class="dsce-surface__retry">重试</button>' +
      '</div>' +
      '<pre class="dsce-surface__diag" hidden></pre>' +
      '<div class="dsce-surface__body"></div>' +
      '</div>'
    const retry = overlay.querySelector('.dsce-surface__retry')
    if (retry !== null) retry.addEventListener('click', () => void this.remount())
    document.body.appendChild(overlay)
    this.overlay = overlay
    this.guestHost = overlay.querySelector('.dsce-surface__body')
    this.syncToHost()
    return overlay
  }

  /**
   * Show the surface inside a host box.
   *
   * Every home for this chat is a plain element — the centred DeepSeek panel,
   * the right dock's DeepSeek tab — so placement is one measurement of that
   * element instead of a per-home geometry recipe. The overlay is fixed and
   * copied onto the host's viewport box, which is exactly what the native child
   * webview is told in DSH Dock, and a ResizeObserver keeps both in step while
   * the shell (sidebar width, right dock, window) moves around them.
   *
   * One guest, one home: a later `attach` takes the surface over from an
   * earlier one, because the guest is a single app-wide webview.
   *
   * @param host - element the surface must fill.
   */
  attach(host) {
    if (!(host instanceof HTMLElement)) return
    this.releaseObserver()
    this.host = host
    if (typeof ResizeObserver === 'function') {
      this.hostObserver = new ResizeObserver(() => this.syncToHost())
      try {
        this.hostObserver.observe(host)
      } catch {
        /* a detached node is not worth failing over */
      }
    }
    this.syncToHost()
    this.watchChrome(host)
    this.watchModal(host)
    this.reportDockDom(host)
  }

  /**
   * Keep re-reading the host box while the shell is still drawing its chrome.
   *
   * The dock's tab chips and the three controls beside them are React output,
   * and on a cold open the pane body exists before that row does. One
   * measurement at attach time therefore answers "nothing sits above me" and
   * the surface keeps the whole pane — the strip appears a moment later *under*
   * it, and the shell looks like it lost its controls. Measured on a real Dock
   * run: `_tabHostHeader` was empty at mount and carried the strip ~2s later.
   *
   * One `ResizeObserver` cannot cover this, because the strip appearing does not
   * resize the host. So: a bounded re-measure schedule for the open, plus a
   * mutation watch on the pane, so chrome that is (re)drawn later is measured
   * when it appears rather than when we happened to look.
   *
   * @param host - the element the surface fills.
   */
  watchChrome(host) {
    this.releaseChromeWatch()
    const remeasure = () => {
      if (this.host === host) this.syncToHost()
    }
    this.chromeTimers = [150, 500, 1200, 2500, 4500].map((delay) => setTimeout(remeasure, delay))
    // One settled reading of the pane's own state, ~2.6s in: by then a cold
    // open has either drawn its chrome or decided not to.
    this.chromeTimers.push(setTimeout(() => {
      remeasure()
      if (this.host === host) report('dock-pane', this.paneState(host))
    }, 2600))
    if (typeof MutationObserver !== 'function') return
    // Watch the row the shell draws its chrome in — and only that row.
    //
    // The first revision watched the whole pane with `subtree: true`, on the
    // theory that chrome could appear anywhere in it. It appears in one row, and
    // the "pane" the walk above lands on is the dock's tab host: the element that
    // holds *every* tab body, ours and the shell's own 文件 / 终端 ones. So the
    // watch fired on each row a file tree listed and each line a terminal wrote,
    // and each firing forced a document-wide reflow and re-sent an identical rect
    // to the native child webview — 1434 `embed_chat_resize` calls in one Dock
    // run, ~60 a second, all carrying the same box. The panes we share the dock
    // with paid for our measurement.
    //
    // So the watch is narrowed to the chrome row itself. It is small (a chip row
    // and its controls), it is the only thing whose appearance can move the band,
    // and when no such row exists the timed re-measures above already cover a
    // cold open at 150/500/1200/2500/4500ms.
    const chromeRow = chromeRowOf(host)
    if (chromeRow === undefined) return
    // Chrome renders in bursts; one re-measure per frame is enough, and a
    // measure is a handful of rects. (Debounce lives in frameThrottle.)
    this.chromeObserver = new MutationObserver(frameThrottle(remeasure))
    try {
      // `subtree` only when the row cannot hold the tab bodies. When the strip
      // sits directly under the dock's tab host, that host is the row — and its
      // subtree is every tab body, ours and the shell's own 文件 / 终端 ones, so
      // a deep watch there is the storm this whole block exists to prevent. A
      // shallow watch on it still sees the strip appear and disappear.
      const deep = !chromeRow.contains(host)
      this.chromeObserver.observe(chromeRow, { childList: true, subtree: deep })
    } catch {
      /* an unwatchable row still has the timed re-measures above */
    }
  }

  /** Stop watching for chrome the shell may still be drawing. */
  releaseChromeWatch() {
    if (this.chromeTimers !== undefined) {
      for (const timer of this.chromeTimers) clearTimeout(timer)
      this.chromeTimers = undefined
    }
    if (this.chromeObserver !== undefined) {
      this.chromeObserver.disconnect()
      this.chromeObserver = undefined
    }
  }

  /**
   * 监听模态弹窗（设置外壳、通用 Modal、确认弹窗等）的进场与退场。
   *
   * 弹窗经 React Portal 挂在 `document.body` 下，所以只看 body 的**直接**子节点、
   * 不开 `subtree`——深监听会撞上「终端每写一行就触发一次文档级重排」那类事故
   * （`watchChrome` 的同款教训，实测 1434 次 resize 全同一个 rect）。
   *
   * 这里**不解析变动节点、不猜 class 名**：DSH 的弹窗 DOM 是上游私有结构，
   * 任何选择器猜测（`[class*="overlay"]` 之类）都会在上游改版时静默失效。
   * 本监听只负责「body 直接子节点变了 → 去重新判定」，判定本身在
   * {@link anyModalActive}，与滚动/缩放路径共用同一套语义。
   *
   * @param {HTMLElement} host - 当前宿主节点。
   */
  watchModal(host) {
    this.releaseModalWatch()
    const doc = host?.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined)
    if (!doc || typeof MutationObserver !== 'function') return
    const target = doc.body ?? doc.documentElement
    if (!target) return
    this.modalObserver = new MutationObserver(frameThrottle(() => this.syncToHost()))
    try {
      this.modalObserver.observe(target, { childList: true, subtree: false })
    } catch {
      /* 监听失败不该连锁拖垮插件；scroll/resize 路径仍会兜底重新判定 */
    }
  }

  /** 停止模态弹窗监听。 */
  releaseModalWatch() {
    if (this.modalObserver !== undefined) {
      this.modalObserver.disconnect()
      this.modalObserver = undefined
    }
  }

  /**
   * Report the dock pane's own structure once per attach.
   *
   * The band rule needs the row the shell actually draws its chrome in, and that
   * row is the vendor's DOM: this runtime renders tab chips as
   * [data-sidebar-right-tab] while only *reading* [data-dockkit-tab], which is
   * exactly the kind of difference a guess gets wrong. Measured once, reported
   * through telemetry, then the rule is written against facts.
   *
   * @param host - the element the surface fills.
   */
  reportDockDom(host) {
    // Once per home, not once per instance: the centred panel attaches first on
    // a session where the chat was last seen there, and that used to eat the
    // reading for the dock home — the only one this rule is about.
    if (this.dockDomReported.has(host)) return
    this.dockDomReported.add(host)
    const describe = (element) => {
      const rect = element.getBoundingClientRect()
      const attrs = [...element.attributes]
        .map((attr) => attr.name)
        .filter((name) => name.startsWith('data-'))
        .slice(0, 3)
        .join(',')
      return `${element.tagName.toLowerCase()}.${String(element.className || '').slice(0, 20)}[${attrs}]`
        + `=${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
    }
    const chain = []
    for (let node = host, level = 0; node !== null && node !== document.body && level < 5; node = node.parentElement, level += 1) {
      const siblings = node.parentElement === null
        ? []
        : [...node.parentElement.children].slice(0, 6).map((child) => `${child === node ? '*' : ' '}${describe(child)}`)
      chain.push({ level, self: describe(node), siblings })
    }
    report('dock-dom', {
      chain,
      band: this.chromeBottom(host) === undefined ? 'none' : Math.round(this.chromeBottom(host)),
      pane: this.paneState(host),
    })
  }

  /**
   * What the shell itself believes about the pane this surface sits in.
   *
   * "The dock's controls are gone" has two causes that look identical on
   * screen: the shell thinks the pane is closed (`data-sidebar-right-open`
   * missing, so its own stylesheet hides and shifts the chrome), or the pane is
   * open and this surface is sitting where the strip is drawn. The attribute we
   * walk for here, and the strip's computed visibility, tell the two apart —
   * recorded instead of guessed, because the last three attempts at this were
   * guesses.
   *
   * @param host - the element the surface fills.
   * @returns a small, JSON-safe reading.
   */
  paneState(host) {
    let open = 'no-attribute'
    for (let node = host; node !== null && node !== document.body; node = node.parentElement) {
      if (node.hasAttribute('data-sidebar-right-open')) {
        open = true
        break
      }
    }
    const read = (element) => {
      if (element === undefined || element === null) return 'absent'
      const computed = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return `${computed.visibility}/${computed.transform}`
        + ` ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
    }
    // Scoped to *this* pane. The first reading of a dock wrong enough to matter
    // came back from a document-wide query that had matched a different pane's
    // strip — a diagnostic that answers about someone else's box is worse than
    // none, because it reads like a fact.
    const pane = this.paneRoot(host)
    const header = pane.querySelector('[class*="tabHostHeader"]')
    return {
      open,
      header: read(header) + (header === null ? '' : ` children=${header.childElementCount}`),
      strip: read(pane.querySelector('[data-dockkit-strip], [class*="tabStrip"]')),
      chrome: read(pane.querySelector('[class*="stripChrome"]')),
      tabs: pane.querySelectorAll('[data-sidebar-right-tab], [data-dockkit-tab]').length,
      surface: this.geometry === undefined
        ? 'unmeasured'
        : `${Math.round(this.geometry.left)},${Math.round(this.geometry.top)}`
          + ` ${Math.round(this.geometry.width)}x${Math.round(this.geometry.height)}`,
    }
  }

  /**
   * The pane that owns `host`: the nearest ancestor that also holds a tab strip
   * or its header. Everything measured about "the dock's chrome" is measured
   * here, so a second pane in the same document cannot answer for this one.
   *
   * @param host - the element the surface fills.
   * @returns the pane root, or `host` itself when the shell draws no chrome.
   */
  paneRoot(host) {
    let root = host
    for (let node = host, level = 0; node !== null && node !== document.body && level < 5; node = node.parentElement, level += 1) {
      root = node
      if (node.querySelector('[data-dockkit-strip], [class*="tabStrip"], [class*="tabHostHeader"]') !== null) return root
    }
    return root
  }

  /**
   * Give the surface up, but only if `host` still owns it.
   *
   * A host that unmounts late — a tab body hidden by `keepMounted`, a panel
   * torn down after the other home took over — must not blank the current home.
   *
   * @param host - the host that is going away.
   */
  detach(host) {
    if (host !== undefined && this.host !== host) return
    this.releaseObserver()
    this.host = undefined
    this.hide()
  }

  /**
   * Move the surface to `box` with the shell's own motion, but lay the guest out
   * only once.
   *
   * Following a collapsing column frame by frame resizes the guest's viewport
   * sixty times in ~260ms, and the guest is a whole application: it re-lays out
   * its own page (while that page is animating its own sidebar) on every one of
   * those frames, which is what the stutter was. So the surface is laid out at
   * the box it will end at — one reflow — and the move itself is a transform,
   * which the compositor runs without touching the guest's layout. The transform
   * carries the shell's duration and easing, so the surface and the column
   * travel together.
   *
   * @param box - the post-animation box, in viewport coordinates.
   * @param dx - how far the surface moves horizontally (its pre-animation edge
   *   relative to the new one).
   */
  /**
   * Smooth, linear transition coordinated with DSH's sidebar collapse.
   * Interpolates left, top, width, height in lockstep with the shell's grid transition.
   */
  animateFold(sidebarWidth) {
    const overlay = this.overlay
    if (overlay === undefined || this.host === undefined) return

    this.animating = true

    const hostRect = this.host.getBoundingClientRect()
    const computed = getComputedStyle(document.documentElement)
    const duration = computed.getPropertyValue('--ds-transition-duration-slow').trim() || '260ms'
    const easing = computed.getPropertyValue('--ds-ease-in-out').trim() || 'cubic-bezier(0.4, 0, 0.2, 1)'
    const darwin = document.documentElement.dataset.platform === 'darwin'
    const clearance = darwin ? 48 : 0

    // Set starting position explicitly
    overlay.style.transition = 'none'
    overlay.style.transform = 'none'
    overlay.style.left = `${Math.round(hostRect.left)}px`
    overlay.style.top = `${Math.round(hostRect.top)}px`
    overlay.style.width = `${Math.round(hostRect.width)}px`
    overlay.style.height = `${Math.round(hostRect.height)}px`

    void overlay.offsetWidth

    // Animate smoothly to the target position on the next frame
    requestAnimationFrame(() => {
      overlay.style.transition = `left ${duration} ${easing}, top ${duration} ${easing}, width ${duration} ${easing}, height ${duration} ${easing}`
      overlay.style.left = '0px'
      overlay.style.width = `${Math.round(hostRect.width + sidebarWidth)}px`
      if (darwin) {
        overlay.style.top = `${clearance}px`
        overlay.style.height = `${Math.round(hostRect.height + (hostRect.top - clearance))}px`
      }
    })

    const settle = () => {
      overlay.style.transition = 'none'
      this.animating = false
      this.syncToHost()
    }
    setTimeout(settle, 340)
  }

  flipTo(box, dx) {
    const overlay = this.overlay
    if (overlay === undefined) return
    this.flipping = true
    this.setGeometry(box.left, box.top, box.width, box.height)
    const computed = getComputedStyle(document.documentElement)
    const duration = computed.getPropertyValue('--ds-transition-duration-slow').trim() || '260ms'
    const easing = computed.getPropertyValue('--ds-ease-in-out').trim() || 'cubic-bezier(0.4, 0, 0.2, 1)'
    overlay.style.transition = 'none'
    overlay.style.transform = `translateX(${Math.round(dx)}px)`
    requestAnimationFrame(() => {
      overlay.style.transition = `transform ${duration} ${easing}`
      overlay.style.transform = 'translateX(0)'
    })
    // The shell stamps `data-animating` for the length of a discrete move; the
    // cap covers the shells that do not animate at all (reduced motion).
    const started = Date.now()
    const settle = () => {
      if (document.querySelector('[data-animating]') !== null && Date.now() - started < 900) {
        requestAnimationFrame(settle)
        return
      }
      overlay.style.transition = ''
      overlay.style.transform = ''
      this.flipping = false
      this.syncToHost()
    }
    requestAnimationFrame(settle)
  }

  /**
   * Follow the shell frame by frame for as long as it is animating a column.
   *
   * The resize observer already fires once per frame, so this is belt and
   * braces: it guarantees an update in the frame the column moved, and stops by
   * itself the moment the shell's animation ends.
   */
  trackWhileAnimating() {
    if (this.animatingFrame !== undefined) return
    if (document.querySelector('[data-animating]') === null) return
    const step = () => {
      if (this.destroyed || document.querySelector('[data-animating]') === null) {
        this.animatingFrame = undefined
        return
      }
      this.syncToHost()
      this.animatingFrame = requestAnimationFrame(step)
    }
    this.animatingFrame = requestAnimationFrame(step)
  }

  /** Stop observing the current host. */
  releaseObserver() {
    if (this.hostObserver !== undefined) {
      this.hostObserver.disconnect()
      this.hostObserver = undefined
    }
    if (this.animatingFrame !== undefined) {
      cancelAnimationFrame(this.animatingFrame)
      this.animatingFrame = undefined
    }
    this.releaseChromeWatch()
    this.releaseModalWatch()
  }

  /**
   * 弹窗在场时 surface 必须让位——这是本插件的一条不变量，三个入口
   * （`syncToHost` / `open` / `syncOnScroll`）都经由此处判定，不各写一遍。
   *
   * **按宿主类型分流，不是所有壳都需要让位**：
   * - `tauri` / `custom`：聊天是原生子视窗，物理图层压在主页 Webview 之上，
   *   页面里的任何遮罩与 z-index 都盖不住它（2026-10-15 故障）——必须让位；
   * - `electron`：聊天是 DOM `<webview>`，住在 `.dsce-overlay`（z-index 200）里，
   *   而官方设置遮罩是 z-index 1000，**天然就盖在它上面**，聊天在遮罩下依稀可见
   *   正是官方交互。此时若 hide()，反而会把聊天整个弄消失（`hide` 会把 overlay
   *   的 display 置为 none，Electron 侧 setVisible 是 no-op）——那是回归，不是修复；
   * - 无 adapter（web profile）：根本没有 guest，浮层同样是 DOM，同理不需要。
   *
   * @returns {boolean} 当前是否有模态弹窗要求 surface 让位。
   */
  modalBlocksHost() {
    const adapter = resolveGuestAdapter()
    if (adapter === undefined || adapter.id === 'electron') return false
    const doc = this.host?.ownerDocument
      ?? (typeof document !== 'undefined' ? document : undefined)
    return anyModalActive(doc)
  }

  /**
   * Copy the host's box onto the overlay (and, in DSH Dock, the native child
   * webview).
   *
   * A host with no box is not on screen — a hidden dock tab, an unmounted
   * panel — and the surface hides rather than floating over the shell, where it
   * would cover whatever the user is actually looking at.
   */
  syncToHost() {
    const host = this.host
    if (host === undefined) return
    // A flip owns the geometry until it lands: the shell's mid-animation boxes
    // would otherwise pull the surface off the transform that is animating it.
    if (this.flipping === true || this.animating === true) return
    if (!host.isConnected) {
      this.hide()
      return
    }
    const rect = host.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) {
      this.hide()
      return
    }
    // 滚动不改变宿主的尺寸，所以 ResizeObserver 一次都不会响：壳的文档一旦被
    // 滚动（例如上一个 fiber 的残骸把文档撑高），surface 与宿主就静默错位；
    // 在 DSH Dock 那条路上更糟——原生子视窗不参与页面滚动，会直接悬停在无关
    // 内容上方。宿主离开视口就让位，回来时由本方法末尾的 open() 接回。
    if (hostBoxIsOffScreen(rect)) {
      // 已经藏了就别再发一次 hide（滚动会逐帧走到这里，hide 在 Dock 侧是一次 IPC）。
      if (this.visible) this.hide()
      return
    }
    // 弹窗在场即让位（判定与理由见 modalBlocksHost）。弹窗关闭后由
    // watchModal 的同一路监听触发 syncToHost，走到方法末尾的 open() 接回。
    if (this.modalBlocksHost()) {
      // 已经藏了就别再发一次 hide（滚动会逐帧走到这里，hide 在 Dock 侧是一次 IPC）。
      if (this.visible) this.hide()
      return
    }
    const band = this.chromeBottom(host)
    if (band === undefined) {
      this.setGeometry(rect.left, rect.top, rect.width, rect.height)
    } else {
      // The shell drew chrome this surface would otherwise cover (see
      // dockChromeBottom): give the band back. Reported once per change, because
      // "the dock's controls vanished" is exactly the symptom this prevents.
      if (this.chromeInset !== Math.round(band)) {
        this.chromeInset = Math.round(band)
        report('chrome-inset', { bottom: this.chromeInset, hostTop: Math.round(rect.top) })
      }
      this.setGeometry(rect.left, band, rect.width, Math.max(0, rect.height - (band - rect.top)))
    }
    if (!this.visible) void this.open()
  }

  /**
   * 滚动路径的轻量同步。
   *
   * 滚动事件会从任意滚动容器冒到 window 的捕获阶段（会话区、侧栏、文档本身都在
   * 其中），逐帧跑一次完整 `syncToHost()` 太贵：那里的 `chromeBottom()` 要做文档级
   * 查询（插件自己的历史里就有「1434 次 resize、全是同一个 rect」的教训）。所以
   * 先只测宿主一个盒子：
   *
   * - 盒子没变 → 什么都不做（滚动发生在别处，surface 不需要动）；
   * - 盒子变了 / 宿主离开视口 → 付一次完整测量，让 surface 跟手或让位。
   */
  syncOnScroll() {
    const host = this.host
    if (host === undefined || !host.isConnected) return
    if (this.flipping === true || this.animating === true) return
    const rect = host.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return
    if (hostBoxIsOffScreen(rect)) {
      if (this.visible) this.hide()
      return
    }
    // 弹窗让位判定放在「盒子没变」之前：`anyModalActive` 只是一次属性选择器
    // querySelectorAll，不触发重排，远比本方法要规避的 `chromeBottom()` 便宜；
    // 而它同时是「宿主无 MutationObserver 时」唯一还能发现弹窗进场的路径。
    if (this.modalBlocksHost()) {
      if (this.visible) this.hide()
      return
    }
    const previous = this.geometry
    if (previous !== undefined
      && previous.left === Math.round(rect.left) && previous.top === Math.round(rect.top)
      && previous.width === Math.round(rect.width) && previous.height === Math.round(rect.height)) {
      return
    }
    this.syncToHost()
  }

  /**
   * The band the shell's own chrome occupies over this host, if any.
   *
   * In DSH Dock the chat is a native child webview that floats above the page:
   * whatever it covers is simply gone, and the right dock draws its controls —
   * tab chips on the left, and the split / fullscreen / collapse toolbar on the
   * right — over the same top band the seat fills. The desktop app's guest is an
   * in-page webview that obeys stacking, so nothing needs this there.
   *
   * The band is found structurally, never by class name: walking up from the
   * host, every level's *other* children that are small, visible, horizontally
   * overlapping, and pressing into the host's top edge is chrome the shell drew
   * (a strip row, a floating toolbar, a drag handle) rather than content. That
   * is what the seat must give back — and because it is measured, a vendor
   * redesign changes the number, never the rule.
   *
   * @param host - the element the surface fills.
   * @returns the bottom edge of the covering band, or undefined when the shell
   *   draws nothing over the host's top.
   */
  chromeBottom(host) {
    const hostRect = host.getBoundingClientRect()
    if (hostRect.width < 2 || hostRect.height < 2) return undefined
    // Chrome is a row, not a region: anything taller than this is a column or a
    // guest, and pressing a surface under it would be worse than covering it.
    const ceiling = 96
    const limit = hostRect.top + Math.min(200, hostRect.height / 3)
    let bottom
    const consider = (element) => {
      if (!(element instanceof HTMLElement)) return
      if (element === host || element.contains(host) || host.contains(element)) return
      const rect = element.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 4 || rect.height > ceiling) return
      if (rect.bottom <= hostRect.top + 1 || rect.top >= limit) return
      if (rect.right <= hostRect.left + 1 || rect.left >= hostRect.right - 1) return
      if (bottom === undefined || rect.bottom > bottom) bottom = rect.bottom
    }
    for (let node = host; node !== null; node = node.parentElement) {
      const parent = node.parentElement
      // Stop at the document shell: its children are portalled overlays and the
      // frame itself, not chrome sitting over this seat.
      if (parent === null || parent === document.body || parent === document.documentElement) break
      for (const sibling of parent.children) consider(sibling)
    }
    // The dock's tab titles, as a second reading: they are chrome even when the
    // row they sit in is not one of the host's own siblings.
    for (const node of document.querySelectorAll('[data-dockkit-tab], [data-sidebar-right-tab]')) {
      if (!(node instanceof HTMLElement)) continue
      const rect = node.getBoundingClientRect()
      if (rect.height > 4 && rect.width > 4 && rect.bottom > hostRect.top + 1 && rect.top < limit) {
        if (bottom === undefined || rect.bottom > bottom) bottom = rect.bottom
      }
      const plate = node.parentElement
      if (plate instanceof HTMLElement && plate !== host) {
        const box = plate.getBoundingClientRect()
        if (box.height > 4 && box.height < ceiling && box.bottom > hostRect.top + 1 && box.top < limit) {
          if (bottom === undefined || box.bottom > bottom) bottom = box.bottom
        }
      }
    }
    if (bottom === undefined) return undefined
    if (bottom >= hostRect.top + hostRect.height / 2) return undefined
    return bottom
  }

  /**
   * @param left - viewport x of the overlay's top-left corner.
   * @param top - viewport y of the overlay's top-left corner.
   * @param width - overlay width in CSS pixels.
   * @param height - overlay height in CSS pixels.
   */
  setGeometry(left, top, width, height) {
    const overlay = this.overlay
    if (overlay === undefined) return

    // The box is a measured host box (`syncToHost`), so it already sits inside
    // the layout the shell built: there is no sidebar to dodge and nothing to
    // clamp. A host that is not on screen never reaches this method.
    const box = {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(height)),
    }

    // While the shell animates a column it stamps `data-animating`; track the
    // host every frame for that stretch, so the surface is written from the same
    // layout the column is being painted from rather than one frame behind it.
    this.trackWhileAnimating()

    // An unchanged box is not news, and re-sending it is not free.
    //
    // The dock's tab host holds every tab body — ours and the shell's own 文件 /
    // 终端 ones — so a pane-level mutation watch fires on each row a file tree
    // lists and each line a terminal writes. Measured on a real Dock run: 1434
    // `embed_chat_resize` calls, in bursts of ~60 a second, every single one
    // carrying the identical rect. Each of those is a native `set_bounds` on the
    // window's content view, i.e. a full window layout, paid by the panes we
    // share the dock with. A box that has not moved is dropped here instead.
    const previous = this.geometry
    if (previous !== undefined && previous.left === box.left && previous.top === box.top
      && previous.width === box.width && previous.height === box.height) return
    this.geometry = box
    overlay.style.left = `${box.left}px`
    overlay.style.top = `${box.top}px`
    overlay.style.width = `${box.width}px`
    overlay.style.height = `${box.height}px`

    // Synchronize native child webview through the unified adapter handle or active adapter
    if (this.visible) {
      if (this.handle !== undefined && typeof this.handle.syncGeometry === 'function') {
        void this.handle.syncGeometry(box, pageFrame()).catch(() => {})
      } else {
        const adapter = resolveGuestAdapter()
        if (adapter !== undefined && typeof adapter.syncGeometry === 'function') {
          void adapter.syncGeometry(box, pageFrame()).catch(() => {})
        }
      }
    }
  }

  /**
   * Discard the guest's element and mount a fresh one.
   *
   * The handshake cannot be retried in place: the shell marks a lease `attached`
   * on first use and rejects it forever after, so a retry needs a new lease and
   * therefore a new element.
   */
  async remount() {
    const handle = this.handle
    this.handle = undefined
    this.guestProbed = false
    if (handle !== undefined) await handle.close()
    if (this.guestHost !== undefined) this.guestHost.replaceChildren()
    if (this.visible) await this.open()
  }

  /**
   * Render a diagnostic block into the overlay.
   *
   * The packaged desktop app ships no developer tools, so the plugin has to be
   * able to explain itself on screen: this is the only channel a user can
   * actually read back.
   *
   * @param reason - the short reason the diagnostic is being shown.
   */
  showDiagnostics(reason) {
    const overlay = this.overlay
    if (overlay === undefined) return
    const pre = overlay.querySelector('.dsce-surface__diag')
    if (pre === null) return
    const rect = overlay.getBoundingClientRect()
    const panes = [...document.querySelectorAll('[data-dockkit-pane],[data-dockkit-content]')].map((el) => {
      const r = el.getBoundingClientRect()
      const key = el.dataset.dockkitPane ?? el.dataset.dockkitContent ?? '?'
      return `${key}=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
    })
    const sidebar = document.querySelector('[data-side="left"]')
    const sidebarRight = sidebar === null ? 'none' : String(Math.round(sidebar.getBoundingClientRect().right))
    const bridge = desktopBrowserBridge()
    const lines = [
      `build    : ${BUILD}`,
      `reason   : ${reason}`,
      `phase    : ${this.phase}${this.detail === '' ? '' : ` (${this.detail})`}`,
      `error    : ${this.lastError ?? 'none'}`,
      `bridge   : ${bridge === undefined ? 'MISSING' : 'ok'}`,
      `geometry : ${this.geometry === undefined ? 'unmeasured' : `${this.geometry.left},${this.geometry.top} ${this.geometry.width}x${this.geometry.height}`}`,
      `overlay  : ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      `display  : ${getComputedStyle(overlay).display}`,
      `panes    : ${panes.length === 0 ? 'none' : panes.join(' | ')}`,
      `sidebar  : right=${sidebarRight}`,
      `webview  : ${overlay.querySelector('webview') === null ? 'none' : 'present'}`,
      `viewport : ${window.innerWidth}x${window.innerHeight}`,
    ]
    pre.textContent = lines.join('\n')
    pre.hidden = false
  }

  /**
   * One-line state summary for the switcher's hover title.
   *
   * The packaged app has no developer tools, and every failure mode of this
   * plugin is invisible — so the tooltip is the diagnostic channel. It reports
   * the click count (did the handler run), the phase (how far the handshake
   * got), and the measured geometry (did the overlay get a real box).
   *
   * @param build - build stamp to report.
   * @param clicks - clicks observed by the switcher.
   * @param supported - whether this surface has the desktop guest bridge.
   * @returns a single-line summary.
   */
  hoverReport(build, clicks, supported) {
    const all = [...document.querySelectorAll('.dsce-overlay')]
    const own = this.overlay
    const describe = (element) => {
      const rect = rectOf(element)
      const box = rect === undefined ? 'none' : `${rect.width}x${rect.height}`
      return `${getComputedStyle(element).display}/${element.dataset.dsceOpen ?? '-'}/${box}`
    }
    const guests = all.filter((element) => element.querySelector('webview') !== null).length
    const ownRect = rectOf(own)
    const geo = this.geometry === undefined ? 'unmeasured' : `${this.geometry.width}x${this.geometry.height}`
    const stale = this.geometry !== undefined && ownRect !== undefined && ownRect.width !== this.geometry.width
    return [
      `${build} · 点击 ${clicks} 次`,
      `env=${detectEnvironment().label}`,
      `bridge=${supported ? 'ok' : 'MISSING'}`,

      // Count first: more than one overlay means a stale element is winning the
      // document query and every other number here would be about the wrong node.
      `overlays=${all.length}${all.length === 0 ? '' : ` [${all.map(describe).join(' | ')}]`}`,
      `own=${ownRect === undefined ? 'absent' : `${ownRect.width}x${ownRect.height}`}`,
      `geometry=${geo}${stale ? ' STALE' : ''}`,
      `phase=${this.phase}${this.lastError === undefined ? '' : ` err=${this.lastError}`}`,
      `guests=${guests}${this.handle === undefined ? '' : ' handle=yes'}`,
    ].join(' · ')
  }

  /**
   * Run `script` in the guest page.
   *
   * @param script - expression evaluating to a string.
   * @returns the guest's answer, or undefined when this host cannot reach the
   *   guest at all or the call failed. On DSH Dock the answer travels the
   *   bridge's capped title channel (see {@link mountTauriGuest}), so anything
   *   past the cap arrives as `null` rather than as a truncated string.
   */
  async guestEval(script) {
    const element = this.handle === undefined ? undefined : this.handle.element
    if (element === undefined || typeof element.executeJavaScript !== 'function') return undefined
    try {
      return String(await element.executeJavaScript(script))
    } catch (error) {
      // The sidebar rule polls, so a guest that stops answering would otherwise
      // write twelve identical lines a second into the telemetry sink. One per
      // five seconds is enough to see it happen.
      const now = Date.now()
      if (this.guestEvalFailureAt === undefined || now - this.guestEvalFailureAt > 5000) {
        this.guestEvalFailureAt = now
        report('guest-eval-failed', { message: String(error?.message ?? error).slice(0, 200) })
      }
      return undefined
    }
  }

  /**
   * @returns 'expanded' | 'collapsed' | 'unknown' when the guest cannot answer.
   *   The cheap marked read runs first; a page whose marks are gone (fresh load,
   *   re-render) is re-identified and re-marked on the spot.
   */
  async guestSidebarState() {
    const quick = await this.guestEval(GUEST_SIDEBAR_READ_SCRIPT)
    if (quick === 'expanded' || quick === 'collapsed') return quick
    const installed = await this.guestSidebarInstall()
    return installed === 'expanded' || installed === 'collapsed' ? installed : 'unknown'
  }

  /**
   * Identify and mark the guest's sidebar and its toggle.
   * @returns 'expanded' | 'collapsed' | 'not-found' | 'unknown'.
   */
  async guestSidebarInstall() {
    const answer = await this.guestEval(GUEST_SIDEBAR_INSTALL_SCRIPT)
    return answer === 'expanded' || answer === 'collapsed' || answer === 'not-found' ? answer : 'unknown'
  }

  /**
   * Ask the guest page to flip its own sidebar, re-identifying it if the mark
   * went stale.
   * @returns whether a control was found and clicked.
   */
  async toggleGuestSidebar() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = await this.guestEval(GUEST_SIDEBAR_TOGGLE_SCRIPT)
      if (typeof answer === 'string' && answer.startsWith('clicked')) return true
      const installed = await this.guestSidebarInstall()
      if (installed === 'not-found' || installed === 'unknown') return false
    }
    return false
  }

  /**
   * Report the guest page's chrome once per guest (see {@link GUEST_SHAPE_SCRIPT}).
   *
   * A host that cannot reach the guest says so, because "the adapter cannot see
   * the page" is exactly the fact worth knowing when the sidebar rule misbehaves
   * there. DSH Dock's bridge can reach the guest, but carries only short
   * answers: a full shape report is past its cap and says so once instead of
   * being re-read five times.
   */
  async reportGuestShape() {
    if (this.guestProbed) return
    this.guestProbed = true
    // Reset on the next attach: a probe that read an empty document must be
    // allowed to try again, and the page it describes changes with every reload.
    setTimeout(() => { this.guestProbed = false }, 40000)
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    // The guest answers `loaded` when the document is there, not when its SPA
    // has mounted: the first read of a cold page sees an empty body, so read
    // again until it has real content.
    for (const delay of [1500, 3500, 7000, 12000, 18000]) {
      await wait(delay)
      const element = this.handle === undefined ? undefined : this.handle.element
      if (element === undefined || typeof element.executeJavaScript !== 'function') {
        report('guest-shape-unreachable', { handle: this.handle === undefined ? 'none' : 'no-executeJavaScript' })
        return
      }
      const view = typeof element.getURL === 'function' ? String(element.getURL()).slice(0, 80) : 'no-getURL'
      try {
        const basics = String(await element.executeJavaScript(GUEST_BASICS_SCRIPT))
        report('guest-basics', { afterMs: delay, view, basics: basics.slice(0, 400), handleUrl: this.currentUrl().slice(0, 80) })
        const json = String(await element.executeJavaScript(GUEST_SHAPE_SCRIPT))
        const shape = JSON.parse(json)
        if (shape === null) {
          report('guest-shape-capped', { afterMs: delay, view, basics: basics.slice(0, 200) })
          return
        }
        if ((shape?.elements ?? 0) > 60) {
          report('guest-shape', { json: json.slice(0, 6000) })
          return
        }
      } catch (error) {
        report('guest-shape-failed', { afterMs: delay, message: String(error?.message ?? error).slice(0, 300) })
        return
      }
    }
    report('guest-shape-still-empty', {})
  }

  /**
   * @returns whether this host can run script inside the guest. Both desktop
   *   shells can: Electron through its webview lease, DSH Dock through the
   *   restricted eval/title bridge (ADR-0033).
   */
  guestScriptable() {
    const element = this.handle === undefined ? undefined : this.handle.element
    return element !== undefined && typeof element.executeJavaScript === 'function'
  }

  /** @returns the embedded surface's current URL, if any. */
  currentUrl() {
    return this.handle === undefined ? '' : this.handle.currentUrl()
  }

  /** @returns whether the guest has actually been attached for this session. */
  isMounted() {
    return this.handle !== undefined
  }

  /** Reload the embedded chat by navigating the guest again. */
  reload() {
    if (this.handle === undefined) return
    this.handle.element.executeJavaScript('location.reload()').catch((error) => {
      console.error('[deepseek-chat-embed] reload failed', error)
    })
  }

  /**
   * Ensure the guest exists and the overlay is visible.
   *
   * Idempotent: concurrent callers await the same handshake, and a second call
   * after success only re-shows the overlay.
   *
   * @returns when the overlay is shown (the guest may still be loading).
   */
  async open() {
    if (this.destroyed) return
    // 弹窗在场不得开surface（判定见 modalBlocksHost）。已经藏着就不用再发一次
    // hide——那在 Dock 侧是一次白跑的 IPC。
    if (this.modalBlocksHost()) {
      if (this.visible) this.hide()
      return
    }
    this.visible = true
    try {
      this.ensureOverlay()
      this.overlay.dataset.dsceOpen = 'true'
      markOverlaySurface(this.overlay)
      this.syncToHost()
    } catch (error) {
      this.lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.setStatus('failed', this.lastError)
      this.showDiagnostics('ensureOverlay/syncToHost threw')
      console.error('[deepseek-chat-embed] open failed', error)
      return
    }
    this.notify()
    if (this.handle !== undefined) {
      if (typeof this.handle.setVisible === 'function' && this.geometry !== undefined) {
        void this.handle.setVisible(true, this.geometry, pageFrame()).catch(() => {})
      }
      void this.reportGuestShape()
      return
    }
    if (this.pending !== undefined) return this.pending
    this.pending = this.mount()
    const watchdog = setTimeout(() => {
      if (this.destroyed) return
      if (this.handle !== undefined && this.phase === 'loaded') return
      this.showDiagnostics(`overlay open for 5s without a loaded guest (${this.phase})`)
    }, 5000)
    try {
      await this.pending
    } finally {
      clearTimeout(watchdog)
      this.pending = undefined
      this.notify()
      void this.reportGuestShape()
    }
  }

  /** Hide the overlay, keeping the guest alive and its login intact. */
  hide() {
    this.visible = false
    if (this.overlay !== undefined) {
      this.overlay.dataset.dsceOpen = 'false'
      // 行内 display 与属性双写：样式表缺席时也要真的藏起来（见 markOverlaySurface）。
      markOverlaySurface(this.overlay)
    }
    if (this.handle !== undefined && typeof this.handle.setVisible === 'function') {
      void this.handle.setVisible(false).catch(() => {})
    } else {
      const adapter = resolveGuestAdapter()
      if (adapter !== undefined && typeof adapter.setVisible === 'function') {
        void adapter.setVisible(false).catch(() => {})
      }
    }
    this.notify()
  }

  /** @returns whether the overlay is currently shown. */
  isOpen() {
    return this.visible
  }

  /**
   * Run the lease handshake and attach the guest.
   *
   * Delegates to {@link mountGuest} so the handshake has exactly one
   * implementation; this method only adds the overlay's status surface.
   */
  async mount() {
    if (this.guestHost === undefined) return
    const adapter = resolveGuestAdapter()

    // Primary route: dispatch via the resolved desktop guest adapter
    if (adapter !== undefined) {
      try {
        const handle = await adapter.mount({
          container: this.guestHost,
          geometry: this.geometry,
          onStatus: (phase, detail) => this.setStatus(phase, detail),
          onExpand: () => {
            if (typeof this.onGuestExpandAction === 'function') {
              this.onGuestExpandAction()
            }
          },
          onGuestExpandAction: () => {
            if (typeof this.onGuestExpandAction === 'function') {
              this.onGuestExpandAction()
            }
          },
        })
        if (this.destroyed) {
          await handle.close()
          return
        }
        this.handle = handle
        report('mount:settled', {
          ok: handle.ok !== false,
          phase: 'loaded',
          detail: adapter.id,
          url: handle.currentUrl(),
        })
        if (handle.ok === false) {
          this.setStatus('failed', this.detail === '' ? '内嵌聊天加载失败' : this.detail)
          this.showDiagnostics('lease handshake did not complete')
          return
        }
        this.setStatus('loaded', `${adapter.label} 就绪`)
        return
      } catch (err) {
        report(`${adapter.id}-mount-failed`, { message: String(err?.message ?? err).slice(0, 200) })
        console.warn(`[deepseek-chat-embed] ${adapter.label} mount failed:`, err)
        // If native embed failed in Tauri shell, gracefully degrade to companion mode
        if (adapter.id === 'tauri') {
          this.mountTauriCompanion(this.guestHost)
          this.setStatus('loaded', 'DSH Dock 伴侣模式就绪')
          return
        }
        this.lastError = err instanceof Error ? err.message : String(err)
        this.setStatus('failed', this.lastError)
        this.showDiagnostics('mount threw')
        return
      }
    }

    // Fallback routes when no native embed adapter is available
    const env = detectEnvironment()
    if (env.type === 'tauri') {
      this.mountTauriCompanion(this.guestHost)
      this.setStatus('loaded', 'DSH Dock 伴侣模式就绪')
      return
    }

    this.mountWebFallback(this.guestHost)
    this.setStatus('unsupported', '当前处于纯 Web 浏览器环境')
  }

  /**
   * Render the companion surface for DSH Dock (Tauri).
   *
   * Uses dsh-dock's native IPC command `open_external` (which is allowlist-checked
   * for chat.deepseek.com) to provide a fluid, seamless companion experience.
   */
  mountTauriCompanion(container) {
    container.innerHTML = `
      <div class="dsce-companion">
        <div class="dsce-companion__card">
          <div class="dsce-companion__icon">
            <svg width="48" height="48" viewBox="0 0 182 29" fill="none" xmlns="http://www.w3.org/2000/svg" style="max-width:180px;height:auto;color:var(--dsw-alias-brand-primary,#2563eb);">
              <path d="M100.136 23.7767H98.1371V20.6775H100.136C101.374 20.6775 102.625 20.3688 103.431 19.5112C104.237 18.6535 104.542 17.3378 104.542 16.0229C104.542 14.708 104.25 13.3934 103.431 12.5358C102.625 11.6781 101.374 11.3694 100.136 11.3694H98.1371V8.27017H100.136C102.164 8.27017 104.093 8.78446 105.485 10.1558C106.877 11.5272 107.542 13.6874 107.542 16.0229C107.542 18.3584 106.877 20.5186 105.485 21.89C104.093 23.2614 102.164 23.7767 100.136 23.7767Z" fill="currentColor"/>
            </svg>
          </div>
          <h2 class="dsce-companion__title">智能聊天伴侣</h2>
          <div class="dsce-companion__badge">DSH Dock · Tauri 桌面环境已适配</div>
          <p class="dsce-companion__desc">
            当前运行于 <strong>DSH Dock</strong> 桌面控制中心。受系统原生内核（WebKit / WebView2）安全边界约束，推荐在独立对话窗口中伴随使用，或与 Dock 窗口并排分屏多任务协同。
          </p>
          <div class="dsce-companion__actions">
            <button type="button" class="dsce-companion__btn-primary" id="dsce-dock-open">
              🚀 打开聊天对话窗口
            </button>
            <button type="button" class="dsce-companion__btn-secondary" id="dsce-dock-platform">
              平台控制台 (Platform)
            </button>
          </div>
          <div class="dsce-companion__tips">
            💡 <strong>小提示</strong>：点击上方 <code>DSH</code> 标签可随时切回会话消息；在 macOS 或 Windows 上按快捷键分屏，可一边看任务进度一边随时与 DeepSeek 对话。
          </div>
        </div>
      </div>
    `
    const openBtn = container.querySelector('#dsce-dock-open')
    const platformBtn = container.querySelector('#dsce-dock-platform')
    
    const openUrl = (targetUrl) => {
      // Prioritize Tauri v2 IPC: window.__TAURI__.core.invoke('open_external', { url })
      if (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('open_external', { url: targetUrl }).catch(() => {
          window.open(targetUrl, '_blank')
        })
      } else {
        window.open(targetUrl, '_blank')
      }
    }

    if (openBtn) openBtn.addEventListener('click', () => openUrl('https://chat.deepseek.com/'))
    if (platformBtn) platformBtn.addEventListener('click', () => openUrl('https://platform.deepseek.com/'))
  }

  /** Fallback view when accessed directly from browser without desktop shell. */
  mountWebFallback(container) {
    container.innerHTML = `
      <div class="dsce-companion">
        <div class="dsce-companion__card">
          <h2 class="dsce-companion__title">聊天对话中心</h2>
          <div class="dsce-companion__badge" style="background:#fef2f2;color:#ef4444;border-color:#fecaca;">Web 浏览器环境限制</div>
          <p class="dsce-companion__desc">
            由于 chat.deepseek.com 启用了最高等级的 <code>frame-ancestors 'none'</code> 浏览器同源安全策略，普通浏览器拒绝网页内嵌 iframe。
            建议使用 <a class="dsce-companion__link" href="https://www.deepseek.com/harness/" target="_blank" rel="noopener noreferrer">DSH 官方桌面版</a>
            或 <a class="dsce-companion__link" href="https://github.com/realguan/dsh-dock" target="_blank" rel="noopener noreferrer">DSH Dock</a>
            桌面客户端以获得完整桌面能力。
          </p>
          <div class="dsce-companion__actions">
            <button type="button" class="dsce-companion__btn-primary" onclick="window.open('https://chat.deepseek.com/', '_blank')">
              在新标签页打开聊天
            </button>
          </div>
        </div>
      </div>
    `
  }
  /** Release the guest and remove the overlay. Only for plugin disposal. */
  async destroy() {
    this.destroyed = true
    const handle = this.handle
    this.handle = undefined
    // 顺序就是判据：先摘 DOM，再放租约。反过来的话，`close()` 一旦抛错或挂起，
    // 浮层就永远留在页面里——而同一批 effect 已经把样式表撤了，留下的正好是
    // 「入流的无样式浮层」（2026-10-14 现场故障）。租约即便放失败，也只是晚一点
    // 被壳回收，不该拿页面布局陪葬。
    const overlay = this.overlay
    this.overlay = undefined
    this.guestHost = undefined
    this.releaseObserver()
    this.releaseChromeWatch()
    if (overlay !== undefined) overlay.remove()
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch (error) {
        report('destroy-close-failed', { message: String(error?.message ?? error).slice(0, 200) })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * dsh exposes no `ctx.styles` service on the browser runtime, so styles are a
 * plugin-owned `<style>` element removed on dispose. Tokens are the same
 * `--dsw-alias-*` custom properties the shipped UI uses, so both themes work.
 */
const STYLES = `
.dsce-overlay {
  position: fixed;
  z-index: 200;
  display: none;
  background: var(--dsw-alias-bg-base, #ffffff);
  overflow: hidden;
  box-sizing: border-box;
}
.dsce-overlay[data-dsce-open="true"] {
  display: block;
}
/* No transition, on purpose. The shell animates its columns by layout, and the
   surface is measured from that layout *after* it settles each frame but
   *before* the frame paints — so writing the box here lands in the same paint as
   the column, which is exactly how the shell's own panels move. An eased
   transition on a target that keeps moving only makes the edge trail the column,
   and a trailing edge is its own, wrong animation. */
.dsce-overlay {
  will-change: left, top, width, height;
}
.dsce-surface {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #ffffff;
}
.dsce-surface__body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  height: 100%;
}
.dsce-surface__body webview {
  display: flex !important;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
}

/* Minimal pill, shown only while the guest is starting or cannot load */
.dsce-surface__pill {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  z-index: 201; display: inline-flex; align-items: center; gap: 8px;
  max-width: min(560px, calc(100% - 24px));
  padding: 4px 12px; border-radius: 999px;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .12);
}
.dsce-surface__pill[hidden] { display: none; }
.dsce-surface__dot { width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; flex: 0 0 auto; }
.dsce-surface__dot[data-phase="failed"], .dsce-surface__dot[data-phase="unsupported"] { background: #ef4444; }
.dsce-surface__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsce-surface__retry {
  appearance: none; border: 0; cursor: pointer; border-radius: 999px;
  padding: 1px 8px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-primary); background: transparent;
}
.dsce-surface__retry:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.05)); }
.dsce-surface__retry[hidden] { display: none; }

.dsce-surface__diag {
  position: absolute; left: 12px; bottom: 12px; z-index: 202;
  margin: 0; padding: 10px 12px; max-width: min(680px, calc(100% - 24px));
  overflow: auto; white-space: pre; font-size: 11px; line-height: 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.dsce-surface__diag[hidden] { display: none; }

/* Entry 2: the resident button beside the shell's right-dock control.
   A frame-overlay seat, drawn where the shell's own control is and measured on
   every layout change, so one button keeps that one slot in every state: the
   seat itself (...header.corner) is single occupancy and belongs to the shell's
   own expand button. */
.dsce-resident-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
  /* The overlay layer hands its direct children pointer-events: auto; this seat
     stays transparent so the app underneath keeps every click but the button. */
  pointer-events: none !important;
}
/* The measured copy's box: only the overlay half wears positioning, so the same
   button can also sit in the shell's own utilities row. */
.dsce-resident-slot {
  position: absolute;
  transform: translateY(-50%);
  pointer-events: auto;
}

/* Layout-neutral ghost button: 28px like the shell's own header controls, so it
   reads as one of them in the utilities row and as a sibling of the right-dock
   control in the overlay copy. */
.dsce-entry-btn {
  appearance: none;
  border: 0;
  padding: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
  pointer-events: auto;
  flex: none;
  -webkit-app-region: no-drag;
  transition: background 0.12s ease, color 0.12s ease;
}
.dsce-entry-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--dsw-alias-label-primary, #111827);
}
.dsce-entry-btn[data-active="true"] {
  color: var(--dsw-alias-brand-primary, #2563eb);
}
.dsce-entry-btn[data-active="true"]:hover {
  background: rgba(37, 99, 235, 0.12);
}
.dsce-entry-btn[data-error="true"] {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
.dsce-entry-icon { display: block; }

/* Entry 2's surface: the right dock's tab body. A plain full-size box — the
   guest measures it, so the docking kit owns every dimension. */
/* No !important rescue of the shell's own chrome here. An earlier revision
   pinned the dock host visible because the strip looked hidden; the one real
   measurement we have (dump-rightbar-dom on a Dock run, 2026-10-10) read the
   strip as visibility: visible, opacity: 1 at its correct box, so that rule
   was fighting styles that were never hiding anything — while being able to
   keep a collapsed pane on screen. The real defect is timing: the strip is
   React output that can render after we measured (see watchChrome). */

.dsce-dock-body {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--dsw-alias-bg-base, #ffffff);
}

/* Entry 1: the centred DeepSeek panel and the right dock's tab body. Both are
   plain main-panel/page boxes; the guest measures the box below the chrome. */
[class*="centerCol"] {
  position: relative !important;
}

.dsce-main-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  flex: 1;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base, #ffffff);
}

/* The window strip, reserved exactly the way the shipped entry pages pad by it
   (ui-plugin-manager, ui-schedule) — but only while the frame's chrome actually
   floats over THIS panel.
   
   On macOS the chrome sits over the content: traffic lights, the sidebar toggle,
   and, once the sidebar is collapsed to nothing, the reopen / New Session
   controls the frame moves into its shell.leading seat. That last state is what
   needs the reservation — the collapse is precisely what lets the centre column
   reach the window edge, and an unreserved full-bleed page puts its content
   under the controls (here that content is the embedded chat, and in DSH Dock a
   native child webview paints above the page and cannot be covered back).
   
   With the sidebar expanded the chrome is over the sidebar column instead, so
   the panel keeps its full height — reserving the band regardless (as the entry
   pages do for a text head that must not jump) would only buy an empty 48px
   band above the chat. The frame publishes data-sidebar-collapsed on the same
   collapse, so this needs no measurement. Zero height everywhere else: the web
   profile and the DSH Dock rail branch never claim desktop identity. */
.dsce-main-strip {
  flex: none;
  height: 0;
  transition: height var(--ds-transition-duration-slow, 260ms) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}
html[data-platform='darwin'] [data-sidebar-collapsed] .dsce-main-strip {
  height: var(--dsh-frame-top-clearance, 0px);
}

.dsce-main-host {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

/* Companion Surface for DSH Dock / Fallback */
.dsce-companion {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  padding: 32px; background: var(--dsw-alias-bg-base, #ffffff); overflow-y: auto;
}
.dsce-companion__card {
  max-width: 540px; width: 100%; text-align: center;
  padding: 36px 32px; border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1, #f9fafb);
  border: 1px solid var(--dsw-alias-border-l1, #e5e7eb);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
}
.dsce-companion__icon { margin-bottom: 12px; }
.dsce-companion__title {
  margin: 0 0 8px 0; font-size: 20px; font-weight: 600;
  color: var(--dsw-alias-label-primary, #111827);
}
.dsce-companion__badge {
  display: inline-block; padding: 2px 10px; border-radius: 999px;
  font-size: 11px; font-weight: 500; margin-bottom: 16px;
  background: rgba(37, 99, 235, 0.08); color: var(--dsw-alias-brand-primary, #2563eb);
  border: 1px solid rgba(37, 99, 235, 0.2);
}
.dsce-companion__desc {
  margin: 0 0 24px 0; font-size: 13px; line-height: 22px;
  color: var(--dsw-alias-label-secondary, #4b5563); text-align: left;
}
/* The two desktop shells the card recommends: real anchors, so middle-click,
   ⌘-click and copy-link work — and each host's own external-link handling
   (dsh's web shell, the Electron desktop, DSH Dock's injected link hook) sees a
   normal navigation instead of a scripted window.open. */
.dsce-companion__link {
  color: var(--dsw-alias-brand-primary, #2563eb);
  font-weight: 500;
  text-decoration: none;
  border-bottom: 1px solid rgba(37, 99, 235, 0.35);
}
.dsce-companion__link:hover {
  border-bottom-color: currentColor;
}
.dsce-companion__actions {
  display: flex; gap: 12px; justify-content: center; margin-bottom: 24px; flex-wrap: wrap;
}
.dsce-companion__btn-primary {
  appearance: none; border: 0; cursor: pointer; border-radius: 8px;
  padding: 9px 18px; font-size: 13px; font-weight: 500;
  color: #ffffff; background: var(--dsw-alias-brand-primary, #2563eb);
  transition: opacity 0.15s ease;
}
.dsce-companion__btn-primary:hover { opacity: 0.9; }
.dsce-companion__btn-secondary {
  appearance: none; border: 1px solid var(--dsw-alias-border-l1, #d1d5db); cursor: pointer;
  border-radius: 8px; padding: 9px 18px; font-size: 13px; font-weight: 500;
  color: var(--dsw-alias-label-primary, #374151); background: var(--dsw-alias-bg-layer-2, #ffffff);
}
.dsce-companion__btn-secondary:hover { background: var(--dsw-alias-bg-layer-1, #f3f4f6); }
.dsce-companion__tips {
  padding: 12px 14px; border-radius: 8px; font-size: 11px; line-height: 18px;
  text-align: left; background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsw-alias-label-caption, #6b7280);
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
}
`

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Telemetry: the only diagnostic channel that survives a UI that shows nothing
// ---------------------------------------------------------------------------

/**
 * Where the Host half appends client telemetry.
 *
 * The packaged desktop app ships no developer tools, so when the embedded pane
 * stays blank there is no way for a user to read state back. The Host writes to
 * a file instead, which is readable from outside the app with no cooperation
 * from the UI at all.
 */
const TELEMETRY_FILE_NAME = 'dsh-deepseek-chat-embed.log'

/** Query parameter the client uses to carry one telemetry line. */
const TELEMETRY_QUERY = 'line'

/** Telemetry route served by the Host half. */
const TELEMETRY_PATH = '/deepseek-chat-embed/telemetry'

/**
 * Viewport rectangle of an element, for telemetry.
 *
 * @param element - element to measure.
 * @returns rounded geometry, or undefined when there is nothing to measure.
 */
function rectOf(element) {
  if (element === undefined) return undefined
  const rect = element.getBoundingClientRect()
  return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
}

/**
 * Send one line to the Host's telemetry sink.
 *
 * Fire-and-forget on purpose: diagnostics must never be able to break the
 * feature they are diagnosing.
 *
 * @param event - short event name.
 * @param data - optional JSON-serialisable detail.
 */
function report(event, data) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), build: BUILD, event, data: data ?? null })
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = controller !== undefined ? setTimeout(() => controller.abort(), 2000) : undefined
    void fetch(`${TELEMETRY_PATH}?${TELEMETRY_QUERY}=${encodeURIComponent(line)}`, {
      signal: controller?.signal,
    })
      .then(() => { if (timer !== undefined) clearTimeout(timer) })
      .catch(() => { if (timer !== undefined) clearTimeout(timer) })
  } catch {
    /* a diagnostic that throws is worse than no diagnostic */
  }
}

/**
 * Host half: append client telemetry to a file.
 *
 * The `node:` builtins are loaded lazily and only here: this module is also
 * served to the browser, whose module table has no `node:fs`, so a static
 * import would fail the bundle before `apply()` ever ran.
 *
 * @param ctx - the Host Cordis context, or undefined when unavailable.
 * @param options.path - absolute file the sink appends to.
 */
function installTelemetrySink(ctx, options) {
  if (ctx === undefined || options.path === undefined) return
  let fs
  try {
    fs = globalThis.require?.('node:fs') ?? globalThis.process?.getBuiltinModule?.('node:fs')
  } catch {
    fs = undefined
  }
  if (fs === undefined || typeof fs.appendFileSync !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: TELEMETRY_PATH,
        handler: (req, res) => {
          try {
            const url = new URL(req.url, 'http://telemetry.invalid')
            const line = url.searchParams.get(TELEMETRY_QUERY)
            if (line !== null) fs.appendFileSync(options.path, `${decodeURIComponent(line)}\n`)
          } catch {
            /* malformed telemetry is not worth failing a request over */
          }
          if (res && typeof res.writeHead === 'function' && !res.writableEnded) {
            try {
              res.writeHead(200, {
                'content-type': 'text/plain; charset=utf-8',
                'connection': 'close',
              })
              res.end('ok')
            } catch {
              /* socket might have closed already */
            }
          }
        },
      }),
    )
  })
}

export default {
  name: 'dsh-deepseek-chat-embed',

  /**
   * @param ctx - the client Cordis context. Only `ctx.inject`, `ctx.effect`
   *   and `ctx.slots` are used, which is the whole surface a dynamic client
   *   bundle may rely on.
   *
   * There is deliberately no `inject` on this object. A package's `dsh.client`
   * declaration is what supplies the client half's injection (this package
   * declares `@deepseek-ai/dsh-client-runtime`, the virtual client entry that
   * provides `slots`), and the plugin object itself is also loaded by the
   * Node-side profile loader — where a client-only dependency name would leave
   * the entry permanently `pending`.
   */
  apply(ctx) {
    // The profile bundle layer also runs this module server-side, where there
    // is no DOM. That half installs the telemetry sink and does nothing else;
    // the browser half does the real work.
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      let path
      try {
        const os = globalThis.process?.getBuiltinModule?.('node:os')
        const nodePath = globalThis.process?.getBuiltinModule?.('node:path')
        if (os !== undefined && nodePath !== undefined) path = nodePath.resolve(os.tmpdir(), TELEMETRY_FILE_NAME)
      } catch {
        path = undefined
      }
      installTelemetrySink(ctx, { path })
      return
    }
    report('browser-apply', { scriptUrl: String(globalThis.document.currentScript?.src ?? 'unknown') })

    // React reaches a native client bundle as a real module (see resolveReact).
    const React = resolveReact()
    if (React === undefined) {
      console.error('[deepseek-chat-embed] React is unavailable; the switcher cannot mount')
      return
    }

    // `slots` is a service of the client runtime, not of this entry's own
    // dependency set: `dsh.client.inject` names the runtime package, not its
    // individual services. Reading it with `ctx.get` at apply time therefore
    // yields nothing, and `ctx.inject` is what defers this fiber until the
    // service actually exists — which on the Node half it never does, making
    // this whole body a no-op there.
    ctx.inject(['slots'], (scope) => {
      const slots = scope.slots
      if (slots === undefined || typeof slots.register !== 'function') {
        console.error('[deepseek-chat-embed] the `slots` service is unusable; no switcher mounted')
        return
      }

      scope.effect(() => {
        const style = document.createElement('style')
        style.dataset.dshDeepseekChatEmbedStyles = '1'
        style.textContent = STYLES
        ;(document.head ?? document.documentElement).append(style)
        // 应用期就扫一遍残骸，而不是等到下一次 open()：等不到 open 的残骸会让
        // 壳的文档整页可滚（见 markOverlaySurface 的实测）。
        sweepOverlayOrphans()
        return () => {
          style.remove()
          // 样式表与浮层同寿：样式先走而浮层留下 = 入流的无样式白卡 + 整页可滚。
          // 这里直接按 DOM 标记清，不依赖 destroy() 的调用顺序或成败。
          sweepOverlayOrphans()
        }
      })

      const chat = new EmbeddedChat()

      // Keep the overlay aligned with its host box. A window resize is not
      // enough: collapsing the sidebar or opening the right dock moves the host
      // without resizing the window, so the host itself publishes its box (see
      // `attach`) and this listener covers the frame-level moves as well.
      scope.effect(() => {
        const onLayout = () => chat.syncToHost()
        window.addEventListener('resize', onLayout)
        document.addEventListener('fullscreenchange', onLayout)
        // 滚动不改尺寸，所以 ResizeObserver 不会响，但宿主的**视口坐标**会变。
        // 壳的文档一旦被滚动（内容溢出、或上一个 fiber 的残骸撑高），不补这一路
        // 就会让 surface / 原生子视窗停在旧位置（2026-10-14 现场故障的第二个面）。
        // 节流见 frameThrottle：滚动事件会从任意容器冒到 window 捕获阶段。
        const onScroll = frameThrottle(() => chat.syncOnScroll())
        window.addEventListener('scroll', onScroll, { passive: true, capture: true })
        let observer
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(onLayout)
          for (const target of [document.body, ...document.querySelectorAll('[class*="centerCol"], [class*="header"], [class*="sidebarCol"], [data-side="left"]')]) {
            try {
              observer.observe(target)
            } catch {
              /* a detached node is not worth failing over */
            }
          }
        }
        // Panes mount lazily, so re-measure once the shell has painted.
        const settle = setTimeout(onLayout, 600)
        return () => {
          window.removeEventListener('resize', onLayout)
          window.removeEventListener('scroll', onScroll, { capture: true })
          document.removeEventListener('fullscreenchange', onLayout)
          clearTimeout(settle)
          if (observer !== undefined) observer.disconnect()
        }
      })

      // One-line shell probe at apply time: which host this is, and the clearance
      // the frame publishes for its floating window chrome. Geometry is the one
      // thing this plugin cannot verify from the outside — the packaged app ships
      // no developer tools and a wrong inset is invisible until someone looks at
      // it — and every geometry defect so far has been a question about exactly
      // these numbers.
      scope.effect(() => {
        const root = document.documentElement
        const read = (name) => getComputedStyle(root).getPropertyValue(name).trim() || null
        report('shell-probe', {
          platform: root.dataset.platform ?? null,
          windowsTitlebar: root.hasAttribute('data-windows-titlebar'),
          fullscreen: root.hasAttribute('data-fullscreen'),
          topClearance: read('--dsh-frame-top-clearance'),
          leadingClearance: read('--dsh-frame-leading-clearance'),
          sidebarCollapsed: document.querySelector('[data-sidebar-collapsed]') !== null,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        })
      }, 'deepseek-chat-embed: shell probe')

      scope.effect(() => () => {
        void chat.destroy()
      })

      /**
       * Live state of the chat's two homes.
       *
       * The shell owns tab layout and panel selection, so nothing here is
       * guessed: the dock tab publishes what it is, the centred panel publishes
       * that it is mounted, and the entry button reads both. The chat itself is
       * one app-wide guest, so exactly one home is in charge at a time.
       */
      const surface = {
        /** The centred main panel is mounted and hosting the chat. */
        centred: false,
        /** The right dock's DeepSeek tab exists. */
        dockOpen: false,
        /** That tab is the visible pane content. */
        dockVisible: false,
        /** The dock track is expanded. */
        dockExpanded: false,
        /** The dock tab type registered (the profile has a right dock at all). */
        tabAvailable: false,
        /** Close the dock tab: bound by the tab body, used when the panel takes over. */
        closeDock: undefined,
        /** Why the last dock open failed, shown in the entry's tooltip. */
        dockError: undefined,
      }
      const surfaceListeners = new Set()

      /** @param patch - fields to merge; listeners run only for a real change. */
      function setSurface(patch) {
        let changed = false
        for (const [key, value] of Object.entries(patch)) {
          if (surface[key] !== value) {
            surface[key] = value
            changed = true
          }
        }
        if (!changed) return
        for (const listener of [...surfaceListeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[deepseek-chat-embed] surface listener failed', error)
          }
        }
      }

      /** @param listener - called on every surface change. @returns unsubscribe. */
      function subscribeSurface(listener) {
        surfaceListeners.add(listener)
        return () => surfaceListeners.delete(listener)
      }

      /**
       * A laid-out box for `selector`, or null when the shell is not drawing it.
       *
       * A `:empty` seat and a `display: none` one both measure 0x0, which is
       * exactly how "this control is not on screen" is detected here.
       *
       * @param selector - CSS selector.
       * @returns the box, or null.
       */
      function visibleBox(selector) {
        const node = document.querySelector(selector)
        if (!(node instanceof HTMLElement)) return null
        const rect = node.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return null
        return rect
      }

      /**
       * One sidebar at a time.
       *
       * The chat page has a sidebar of its own and so does the shell; with both
       * open the chat loses a third of its width — the state the user was left
       * in. The rule, exactly as asked for: the chat's sidebar *starts* as the
       * opposite of the shell's (shell open → chat opens folded, shell folded →
       * chat opens expanded), and opening the chat's own sidebar by hand folds
       * the shell's.
       *
       * Nothing here is fatal or clever: a guest this host cannot reach (DSH
       * Dock owns it natively) or a control the page no longer draws leaves the
       * rule silent — reporting, never acting on a guess — so a DeepSeek
       * redesign degrades to "the plugin does not touch the chat's chrome".
       */
      const guestSidebarRule = {
        /** Last state read from the guest: the transition is what folds the shell. */
        last: undefined,
        /** @type {ReturnType<typeof setInterval> | undefined} */
        timer: undefined,

        /**
         * Make the chat's sidebar the opposite of the shell's, once per open.
         * Retries while the guest is still loading: a chat that answers with no
         * document yet is not a chat whose sidebar can be read.
         */
        async align() {
          const want = document.querySelector('[data-sidebar-collapsed]') !== null ? 'expanded' : 'collapsed'
          for (const delay of [900, 2500, 5000]) {
            await new Promise((resolve) => setTimeout(resolve, delay))
            const state = await chat.guestSidebarState()
            if (state === 'unknown') continue
            this.last = state
            if (state === want) return
            if (!(await chat.toggleGuestSidebar())) {
              report('guest-sidebar-toggle-missing', { from: state, want })
              return
            }
            await new Promise((resolve) => setTimeout(resolve, 800))
            this.last = await chat.guestSidebarState()
            report('guest-sidebar-aligned', { from: state, want, after: this.last })
            return
          }
          report('guest-sidebar-unreadable', { want })
        },

        /** Watch the chat's sidebar while the chat is on screen. */
        start() {
          if (this.timer !== undefined) return
          this.timer = setInterval(() => { void this.sample() }, 80)
        },

        /** Stop watching (the chat left the screen). */
        stop() {
          if (this.timer === undefined) return
          clearInterval(this.timer)
          this.timer = undefined
        },

        triggerMutualFold(reason) {
          if (!chat.isOpen()) return
          const host = chat.host
          if (!host || !host.classList.contains('dsce-main-host')) return
          if (document.querySelector('[data-sidebar-collapsed]') !== null) return
          const layout = typeof scope.get === 'function' ? scope.get('layout') : undefined
          if (layout === undefined || typeof layout.toggleSidebar !== 'function') return

          const sidebar = document.querySelector('[class*="sidebarCol"], [data-side="left"]')
          const width = sidebar?.getBoundingClientRect().width ?? 280
          if (width <= 8) return

          chat.animateFold(width)
          layout.toggleSidebar()
          report('dsh-sidebar-folded', { because: reason, shift: Math.round(width) })
        },

        /** Fold the shell's sidebar when the chat's was opened by hand. */
        async sample() {
          if (!chat.isOpen()) return
          const state = await chat.guestSidebarState()
          if (state === 'unknown' || state === this.last) return
          const previous = this.last
          this.last = state
          if (previous !== 'collapsed' || state !== 'expanded') return
          if (document.querySelector('[data-sidebar-collapsed]') !== null) return
          this.triggerMutualFold('chat-sidebar-expanded-polled')
        },
      }

      chat.onGuestExpandAction = () => {
        guestSidebarRule.triggerMutualFold('chat-sidebar-expanded-instant')
      }


      /**
       * Where entry 2 belongs: immediately beside the shell's own right-dock
       * control, measured from that control rather than from a fixed offset.
       *
       * Three shell states, one slot. Collapsed dock: left of the expand button.
       * Dock expanded: the expand button is gone and its corner seat is empty, so
       * the button follows the utilities row that has taken the header's edge —
       * the same place the shell would have put another utility. Blank New
       * Session screen: the shell hides the utilities row but keeps the expand
       * button, so the first rule still applies.
       *
       * @returns `{right, centre, size}` in viewport coordinates, or null when no
       *   conversation header is on screen (the Plugins and Settings pages own
       *   the column then, and the button has nothing to sit beside).
       */
      function residentAnchor() {
        if (typeof document === 'undefined') return null
        const gap = 8

        const expand = visibleBox('[data-sidebar-right-expand]')
        if (expand !== null) {
          return { right: expand.left - gap, centre: expand.top + expand.height / 2, size: expand.height }
        }

        const utilities = document.querySelector('[class*="headerUtilities"]')
        if (utilities instanceof HTMLElement) {
          const drawn = [...utilities.children]
            .filter((child) => child instanceof HTMLElement && child.getBoundingClientRect().width > 0)
          const last = drawn.at(-1)
          if (last !== undefined) {
            const rect = last.getBoundingClientRect()
            return { right: rect.right + gap, centre: rect.top + rect.height / 2, size: rect.height }
          }
        }

        const header = document.querySelector('[class*="centerCol"] [class*="header"]')
        if (header instanceof HTMLElement) {
          const rect = header.getBoundingClientRect()
          // A sessionless page (blank New Session, workspace picker) draws its
          // header with **zero height** — measured in DSH Dock's web profile:
          // `headerBlank headerSessionless`, box [280,0,1000,0]. The header is
          // still there, still the column's full width, still at the top; only
          // its content is absent. Demanding a height here left those pages
          // with no entry at all, which is how "the dock chat cannot be opened"
          // happened. The title row's own metrics (25px down, 28px tall) belong
          // to the row, not to whatever the page drew inside it, so they are
          // used as-is — the button lands exactly where it does on a page that
          // has a session.
          if (rect.width >= 1) {
            return { right: rect.right - 12, centre: rect.top + 25, size: 28 }
          }
        }
        return null
      }

      /**
       * Open the DeepSeek chat in the right dock, or fold the dock away again.
       *
       * The entry's whole contract is "the chat appears on the right", so this
       * never falls back to the centre: a profile whose dock cannot take the tab
       * says so in the button's tooltip (and the telemetry) instead of silently
       * moving the chat to a home the user did not ask for. The centre keeps its
       * own door — the left navigation item.
       */
      function toggleDock() {
        window.__dsceClicks__ = (window.__dsceClicks__ ?? 0) + 1
        const layout = typeof scope.get === 'function' ? scope.get('layout') : undefined
        const right = typeof scope.get === 'function' ? scope.get('sidebarRight') : undefined

        if (surface.dockVisible && surface.dockExpanded) {
          if (layout !== undefined && typeof layout.closeRightbar === 'function') layout.closeRightbar()
          // The seat's own state follows the tab-info subscription, but that is
          // one store update away: without writing it here the button keeps
          // claiming "fold away" while the dock is already closed, so the next
          // click runs this same branch again and the dock never reopens.
          setSurface({ dockError: undefined, dockVisible: false, dockExpanded: false })
          report('dock-closed', { centred: surface.centred })
          return
        }

        if (!surface.tabAvailable || right === undefined || typeof right.openTab !== 'function') {
          const reason = '该 profile 没有右侧栏（sidebarRight 服务不可用），无法在右侧展示'
          setSurface({ dockError: reason })
          report('dock-unavailable', { tabAvailable: surface.tabAvailable, sidebarRight: typeof right })
          return
        }

        try {
          if (surface.centred && layout !== undefined && typeof layout.selectPanel === 'function') {
            layout.selectPanel(null)
          }
          // `openTab` already expands this session's right bar; the track is
          // opened idempotently afterwards. There is deliberately no
          // `toggleExpanded()` here: a *toggle* driven by a state query that can
          // lag is a collapse waiting to happen, and collapsing the dock the
          // user just asked to open is the one outcome that must not occur.
          right.openTab(DEEPSEEK_TAB_KIND, { revealIfOpened: true })
          if (layout !== undefined && typeof layout.openRightbar === 'function') {
            layout.openRightbar(true, false)
          }
          // Same reason as the fold branch: reflect the request now, and let the
          // tab-info subscription correct it with the shell's real state.
          setSurface({ dockError: undefined, dockVisible: true, dockExpanded: true })
          report('dock-opened', { centred: surface.centred })
        } catch (error) {
          const reason = String(error?.message ?? error)
          setSurface({ dockError: reason })
          report('dock-open-failed', { message: reason })
        }
      }

      /**
       * Entry 2's control.
       *
       * One component, two seats, and never both at once:
       *
       * · the shell's own `...session.header.utilities` row (a real header seat,
       *   so the shell lays the button out and it cannot overlap the controls
       *   beside it);
       * · the frame overlay, measured against the shell's right-dock control —
       *   used only while that row is not drawn at all, which is the blank New
       *   Session screen the shell hides it for. There the button has no
       *   neighbours, so a measured copy is exact.
       *
       * The overlay copy is what keeps the entry resident without ever reserving
       * layout: `ResidentEntryButton` renders nothing the moment the utilities
       * row exists, and the row exists exactly when the shell seats this button.
       */
      function DeepSeekEntryButton() {
        // The whole surface, not just its booleans: a refused dock open must
        // repaint the button (it carries the reason), and reading the store
        // directly would leave that change invisible.
        const read = () => ({
          active: surface.dockVisible && surface.dockExpanded,
          error: surface.dockError,
        })
        const [state, setState] = React.useState(read)
        // The packaged app ships no developer tools and the embedded pane can fail
        // silently, so the entry doubles as the diagnostic channel: while the
        // surface is not healthy its tooltip carries the measured report.
        const [trouble, setTrouble] = React.useState(() => !SURFACE_CALM.includes(chat.phase))

        React.useEffect(() => subscribeSurface(() => setState(read)), [])

        React.useEffect(
          () => chat.subscribe(() => setTrouble(!SURFACE_CALM.includes(chat.phase))),
          [],
        )

        const active = state.active

        const label = active ? '收起右侧栏的聊天' : '在右侧栏打开聊天'
        const detail = state.error === undefined ? label : `${label}（${state.error}）`
        const title = trouble
          ? `${detail} · ${chat.hoverReport(BUILD, window.__dsceClicks__ ?? 0, isEmbedSupported())}`
          : detail

        return React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsce-entry-btn',
            'data-active': active ? 'true' : 'false',
            'data-error': state.error === undefined ? undefined : 'true',
            title,
            'aria-label': label,
            'aria-pressed': active ? 'true' : 'false',
            onClick: toggleDock,
          },
          React.createElement(
            'svg',
            {
              viewBox: '0 0 24 24',
              width: 16,
              height: 16,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              className: 'dsce-entry-icon',
            },
            React.createElement('path', {
              d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
            }),
          ),
        )
      }

      /**
       * The overlay half of entry 2: a measured copy of the button, drawn only
       * where the shell's utilities row is not drawn at all.
       *
       * The row's box is the test — `:empty` and `display: none` both measure
       * 0×0 — so this is a measurement of the shell, not a guess about the
       * blank-session state.
       */
      function ResidentEntryButton() {
        const layerRef = React.useRef(null)
        const [box, setBox] = React.useState(null)

        React.useEffect(() => {
          let frame = 0
          let disposed = false

          const measure = () => {
            frame = 0
            if (disposed) return
            const host = layerRef.current
            if (!(host instanceof HTMLElement)) return
            const utilities = document.querySelector('[class*="headerUtilities"]')
            const drawn = utilities instanceof HTMLElement
              && utilities.getBoundingClientRect().width > 0
            const anchor = drawn ? null : residentAnchor()
            if (anchor === null) {
              setBox(current => (current === null ? current : null))
              return
            }
            const hostRect = host.getBoundingClientRect()
            const next = {
              right: Math.round(hostRect.right - anchor.right),
              top: Math.round(anchor.centre - hostRect.top),
              size: Math.round(anchor.size),
            }
            setBox(current => (
              current !== null && current.right === next.right && current.top === next.top && current.size === next.size
                ? current
                : next
            ))
          }

          const schedule = () => {
            if (frame === 0) frame = requestAnimationFrame(measure)
          }

          measure()
          // The header mounts after the shell's first paint and keeps moving while
          // panes settle; three trailing reads cover that without polling.
          const settle = [setTimeout(measure, 120), setTimeout(measure, 480), setTimeout(measure, 1200)]
          window.addEventListener('resize', schedule)
          document.addEventListener('fullscreenchange', schedule)
          const observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true, subtree: true })
          return () => {
            disposed = true
            if (frame !== 0) cancelAnimationFrame(frame)
            for (const timer of settle) clearTimeout(timer)
            window.removeEventListener('resize', schedule)
            document.removeEventListener('fullscreenchange', schedule)
            observer.disconnect()
          }
        }, [])

        return React.createElement(
          'div',
          { ref: layerRef, className: 'dsce-resident-layer' },
          box === null
            ? null
            : React.createElement(
                'div',
                {
                  className: 'dsce-resident-slot',
                  style: {
                    right: `${box.right}px`,
                    top: `${box.top}px`,
                    width: `${box.size}px`,
                    height: `${box.size}px`,
                  },
                },
                React.createElement(DeepSeekEntryButton),
              ),
        )
      }

      /**
       * Entry 2's surface: the chat as a real tab in the shell's right dock.
       *
       * The body owns no layout of its own — it is a full-size box and the guest
       * is attached to it, so the tab chip, its close control and the docking
       * kit's drag/split behaviour are all the shell's own. While the tab is not
       * the visible one the guest is detached: in DSH Dock the native child
       * webview floats above the page and would otherwise cover whichever tab the
       * user switched to.
       */
      function DeepSeekDockTab(props) {
        const hostRef = React.useRef(null)
        const useTabInfo = props?.useTabInfo
        const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
        const visible = info === undefined ? true : info.tab.visible === true
        const expanded = info === undefined ? false : info.sidebar.expanded === true

        React.useEffect(() => {
          if (info === undefined) return undefined
          setSurface({
            dockOpen: true,
            dockVisible: visible,
            dockExpanded: expanded,
            closeDock: () => info.tab.actions.close(),
          })
          return () => setSurface({ dockOpen: false, dockVisible: false, closeDock: undefined })
        }, [visible, expanded])

        React.useEffect(() => {
          const host = hostRef.current
          if (!(host instanceof HTMLElement)) return undefined
          if (!visible) {
            guestSidebarRule.stop()
            chat.detach(host)
            return undefined
          }
          chat.attach(host)
          void guestSidebarRule.align()
          guestSidebarRule.start()
          return () => {
            guestSidebarRule.stop()
            chat.detach(host)
          }
        }, [visible])

        return React.createElement('div', { ref: hostRef, className: 'dsce-dock-body' })
      }



      /**
       * Entry 3: Left Sidebar Panel List Icon.
       */
      function SidebarPanelIcon(props) {
        const size = typeof props?.size === 'number' ? props.size : 16
        const active = props?.active === true
        return React.createElement(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: size,
            height: size,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            style: { color: active ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'currentColor' },
          },
          React.createElement('path', {
            d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
          }),
        )
      }

      /**
       * Entry 1's surface: the chat centred in the conversation column.
       *
       * Two boxes, not one. The panel is a plain main-panel page (the shell hands
       * the whole column to a panel occupant), so it reserves the window strip
       * the shipped entry pages pad by and owns the window drag over it; the chat
       * then fills only the box below that strip. One box would put the surface
       * under the frame's floating chrome — on macOS with the sidebar collapsed
       * the centre column reaches the window edge, and the traffic lights, the
       * sidebar toggle and the reopen controls live *over* the panel's top-left.
       * In the web and DSH Dock branches the rail survives and the strip resolves
       * to zero, so nothing changes there.
       *
       * Mounting here means the user picked DeepSeek in the left navigation, so
       * the chat's other home gives it up rather than keeping an empty dock tab
       * pointing at a surface that moved.
       */
      function DeepSeekMainPanel() {
        const hostRef = React.useRef(null)

        React.useEffect(() => {
          setSurface({ centred: true })
          return () => setSurface({ centred: false })
        }, [])

        React.useEffect(() => {
          const host = hostRef.current
          if (!(host instanceof HTMLElement)) return undefined
          if (surface.dockVisible) surface.closeDock?.()
          chat.attach(host)
          void guestSidebarRule.align()
          guestSidebarRule.start()
          return () => {
            guestSidebarRule.stop()
            chat.detach(host)
          }
        }, [])

        return React.createElement(
          'div',
          { className: 'dsce-main-panel' },
          // The station for the window chrome; `data-window-drag` is the shell's
          // own drag mark (ui-web base.css turns it into an Electron app-region
          // on darwin), so the strip stays draggable exactly like a page head.
          React.createElement('div', {
            className: 'dsce-main-strip',
            'data-window-drag': '',
            'aria-hidden': 'true',
          }),
          React.createElement('div', { ref: hostRef, className: 'dsce-main-host' }),
        )
      }

      // 1. Entry 1: the shell's own left navigation. The item is a main-panel id,
      //    so registering the panel below is what makes the item clickable at all
      //    (`layout.selectPanel` throws for an unknown id).
      scope.effect(() =>
        slots.inject('sidebar.panellist', () =>
          slots.register(
            {
              name: 'sidebar.panellist',
              id: 'deepseek',
              order: 20,
              label: '聊天',
            },
            SidebarPanelIcon,
          ),
        ),
      )

      scope.effect(() =>
        slots.inject('main', () =>
          slots.register(
            {
              name: 'main',
              key: 'deepseek',
            },
            DeepSeekMainPanel,
          ),
        ),
      )

      // 2. Entry 2: the DeepSeek button in the conversation header.
      //
      //    Two seats, one button, never both painted. The utilities row is the
      //    shell's own layout — joining it is what keeps the button from
      //    overlapping the controls beside it — but the shell hides that row on
      //    the blank New Session screen, so the overlay copy covers exactly that
      //    state (and draws nothing whenever the row is drawn).
      scope.effect(() =>
        slots.inject('conversation.session.header.utilities', () =>
          slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'deepseek-chat-embed-entry',
              order: 20,
              label: '聊天',
            },
            DeepSeekEntryButton,
          ),
        ),
      )

      scope.effect(() =>
        slots.inject('shell.overlay', () =>
          slots.register(
            {
              name: 'shell.overlay',
              id: 'deepseek-chat-embed-entry-blank',
              order: 10,
              label: '聊天（新会话页）',
            },
            ResidentEntryButton,
          ),
        ),
      )

      // 3. Entry 2's surface: the chat as a tab in the shell's right dock.
      //
      //    The dock's tab system is a service, not a slot shape: a type declares
      //    its kind, its chip title and its body seat, and `openTab` is the only
      //    way in.
      //
      //    Wired through `inject`, never through a one-shot `get`. A profile
      //    composes its plugins from bundles and patches, so the right dock may
      //    well register after this plugin does — the shell's own app does, the
      //    DSH Dock's web profile did (measured: a one-shot check reported the
      //    service missing there while `sidebarRightTabs` was in fact provided by
      //    its runtime, 0.2.0-rc.2). `inject` runs this the moment both are
      //    available and keeps it for as long as they are, which is order-proof;
      //    a profile that genuinely has no right dock simply never runs it, and
      //    the centred panel keeps working.
      scope.inject(['slots', 'sidebarRightTabs'], (inner) => {
        const tabs = inner.sidebarRightTabs
        if (tabs === undefined || typeof tabs.register !== 'function') return
        inner.effect(
          () =>
            tabs.register({
              id: DEEPSEEK_TAB_ID,
              kind: DEEPSEEK_TAB_KIND,
              // One chat per dock, and it survives tab switches: keeping the body
              // mounted is what keeps the guest (and its loaded page) alive.
              multiple: false,
              keepMounted: true,
              priority: 'extension',
              title: () => '聊天',
            }),
          'deepseek-chat-embed: dock tab type',
        )
        inner.effect(
          () =>
            inner.slots.inject('sidebar.right.pane.tab', () =>
              inner.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: DEEPSEEK_TAB_ID,
                },
                DeepSeekDockTab,
              ),
            ),
          'deepseek-chat-embed: dock tab body',
        )
        setSurface({ tabAvailable: true })
        report('dock-tab-registered', { id: DEEPSEEK_TAB_ID, kind: DEEPSEEK_TAB_KIND, via: 'inject' })
      })

      // Capability probe, reported once the tree has settled as well as at apply
      // time: which optional services this host actually offers is exactly what
      // differs between the profiles, and a plugin that measures it can say so
      // instead of guessing from the host's name.
      const probe = (when) => {
        const get = (name) => {
          try {
            return typeof scope.get === 'function' ? scope.get(name) : undefined
          } catch {
            return undefined
          }
        }
        const host = chat.host
        const hostRect = host === undefined ? undefined : host.getBoundingClientRect()
        const band = host === undefined ? undefined : chat.chromeBottom(host)
        report('capabilities', {
          when,
          platform: document.documentElement.dataset.platform ?? null,
          dockService: typeof get('sidebarRightTabs'),
          dockNavigation: typeof get('sidebarRight'),
          layout: typeof get('layout'),
          guestScriptable: chat.guestScriptable(),
          tabAvailable: surface.tabAvailable === true,
          host: hostRect === undefined
            ? 'none'
            : `${Math.round(hostRect.left)},${Math.round(hostRect.top)} ${Math.round(hostRect.width)}x${Math.round(hostRect.height)}`,
          dockChrome: band === undefined ? 'none' : `bottom=${Math.round(band)}`,
        })
      }
      probe('apply')
      const capabilityTimer = setTimeout(() => probe('settled'), 6000)
      scope.effect(() => () => clearTimeout(capabilityTimer))
    })
  },
}
