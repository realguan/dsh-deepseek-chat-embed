/**
 * live/main.cjs — end-to-end test of the plugin inside a real dsh Web UI.
 *
 * Unlike `test/harness` (which loads a fixture page), this boots the plugin
 * against the **actual** dsh web client served by a real Host, so it exercises
 * the real Slot tree, the real Session header, and — if a Session can be
 * created — the real switcher.
 *
 * The shell half is the same faithful `DesktopBrowserGuests` replica the harness
 * uses; it stands in for `@deepseek-ai/dsh-desktop`, which cannot be pointed at
 * a test Host without forking it.
 *
 * Required environment:
 *   LIVE_URL   authenticated dsh Web URL, e.g. http://127.0.0.1:3080/?token=…
 */
const { app, BrowserWindow, ipcMain, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const LOG = path.join(__dirname, 'result.log')
const SHOT = path.join(__dirname, 'shot.png')
fs.writeFileSync(LOG, '')
const log = (...parts) => {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  fs.appendFileSync(LOG, line + '\n')
}

// ---------------------------------------------------------------------------
// Replica of DesktopBrowserGuests (same transcription as test/harness)
// ---------------------------------------------------------------------------

class BrowserGuests {
  constructor() {
    this.partitions = new Map()
    this.leases = new Map()
  }

  acquire(owner, workspace) {
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${crypto.randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = crypto.randomUUID()
    this.leases.set(lease, { owner, partition, attached: false })
    log('[SHELL] acquire', JSON.stringify({ workspace, partition }))
    return { lease, partition }
  }

  async release(owner, id) {
    const lease = this.leases.get(id)
    if (lease === undefined) return
    this.leases.delete(id)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise((resolve) => guest.once('destroyed', resolve))
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
    log('[SHELL] released', id)
  }

  bind(window) {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#') ? params.src.slice(12) : ''
      const lease = this.leases.get(id)
      const accepted =
        lease !== undefined && lease.owner === owner && !lease.attached && params.partition === lease.partition
      log('[SHELL] will-attach-webview', JSON.stringify({ leaseFound: lease !== undefined, accepted }))
      if (!accepted) {
        event.preventDefault()
        return
      }
      lease.attached = true
      for (const key of Object.keys(preferences)) if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        plugins: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = url.startsWith('about:blank#') ? url.slice(12) : ''
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        log('[SHELL] guest attached', JSON.stringify({ url, ua: guest.getUserAgent().slice(-40) }))
        guest.setWindowOpenHandler(() => ({ action: 'deny' }))
        guest.on('will-frame-navigate', (event) => {
          const allowed = ['http:', 'https:'].includes(new URL(event.url).protocol)
          log('[SHELL] will-frame-navigate', JSON.stringify({ url: event.url.slice(0, 60), main: event.isMainFrame, allowed }))
          if (event.isMainFrame && !allowed) event.preventDefault()
        })
        guest.on('did-finish-load', async () => {
          const current = guest.getURL()
          if (current.startsWith('about:blank')) return
          log('[SHELL] guest loaded', current)
          try {
            log('[SHELL] guest title', await guest.executeJavaScript('document.title'))
          } catch (error) {
            log('[SHELL] guest title failed', String(error))
          }
        })
      })
    })
  }

  configureSession(browserSession) {
    browserSession.setPermissionRequestHandler((_c, _p, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.on('will-download', (event) => event.preventDefault())
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const guests = new BrowserGuests()

app.whenReady().then(async () => {
  const liveUrl = process.env.LIVE_URL
  if (liveUrl === undefined || liveUrl === '') {
    log('[LIVE] LIVE_URL is required')
    app.quit()
    return
  }
  log('[LIVE] loading', liveUrl.replace(/token=[^&]+/, 'token=<redacted>'))

  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
      devTools: true,
    },
  })
  guests.bind(win)

  ipcMain.handle('dsh-desktop:browser-acquire', (event, workspace) => guests.acquire(event.sender, workspace))
  ipcMain.handle('dsh-desktop:browser-release', (event, lease) => guests.release(event.sender, lease))

  win.webContents.on('console-message', (event) => {
    const message = typeof event === 'object' && event !== null && 'message' in event ? event.message : String(event)
    if (/Security Warning|consult|electronjs\.org|once the app|^$/.test(message)) return
    log('[PAGE]', String(message).slice(0, 220))
  })

  await win.loadURL(liveUrl)

  // Wait for the real client to boot and mount the Slot tree.
  const waitFor = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await win.webContents.executeJavaScript(expression, true).catch((error) => `ERR:${error}`)
      if (value === true) return true
      if (String(value).startsWith('ERR:')) log('[LIVE] eval error', label, String(value))
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    log('[LIVE] timeout waiting for', label)
    return false
  }

  const report = { liveUrl: liveUrl.replace(/token=[^&]+/, 'token=<redacted>') }

  report.clientBooted = await waitFor(
    'document.body && document.body.innerText.length > 0 && !!document.querySelector("script[src^=\'assets/\'], script[src*=\'assets/\']")',
    30000,
    'dsh client markup',
  )
  report.pluginRowServed = await win.webContents
    .executeJavaScript(
      `fetch('/plugins/??dsh-deepseek-chat-embed/client.js').then(() => 'ok').catch((e) => String(e))`,
      true,
    )
    .catch((error) => String(error))

  // The switcher only exists while a Session header is mounted. Creating one
  // through the UI was unreliable, so the plugin's own entry point is driven
  // directly instead: this proves the embed works in the real client's
  // document, with the real geometry and the real shell contract, and it needs
  // no Session at all.
  report.embedProbe = await win.webContents
    .executeJavaScript(
      `(async () => {
         const out = {}
         try {
           // The bundle is served at a revisioned combo URL, and it registers
           // itself by calling __ModuleLoader__.load, so a bare static path is
           // not importable. Rebuild the same URL the page itself would request.
           let rev = '0'
           try {
             const w = globalThis.__DSH_BOOT__
             const json = JSON.stringify(w ?? {})
             const m = json.match(/dsh-deepseek-chat-embed[^"]*?"rev":"([a-f0-9]+)"/) ?? json.match(/"rev":"([a-f0-9]+)"[^}]*dsh-deepseek-chat-embed/)
             if (m !== null) rev = m[1]
           } catch (e) { out.revError = String(e) }
           out.rev = rev
           const src = '/plugins/??dsh-deepseek-chat-embed/client.js&rev=' + rev
           const code = await fetch(src).then((r) => r.text())
           out.bundleBytes = code.length
           // Execute it the way the module loader does: same document, classic script.
           const el = document.createElement('script')
           el.textContent = code
           document.head.appendChild(el)
           el.remove()
           out.bundleExecuted = true
           const hooks = globalThis.__DSCE_TEST__
           out.hooksPresent = hooks !== undefined && hooks !== null
           if (hooks === undefined) return out
           out.embeddedChatAvailable = typeof hooks.EmbeddedChat === 'function'

           const host = document.createElement('div')
           host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px'
           document.body.appendChild(host)

           const chat = new hooks.EmbeddedChat()
           const overlay = chat.ensureOverlay()
           chat.applyGeometry()
           out.geometryAfterMeasure = chat.geometry
           const panes = [...document.querySelectorAll('[data-dockkit-pane],[data-dockkit-content]')].map((el) => {
             const r = el.getBoundingClientRect()
             return (el.dataset.dockkitPane ?? el.dataset.dockkitContent) + '=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
           })
           out.panes = panes
           const sidebar = document.querySelector('[data-side="left"]')
           out.sidebarRight = sidebar === null ? null : Math.round(sidebar.getBoundingClientRect().right)
           const orect = overlay.getBoundingClientRect()
           out.overlayRect = { left: Math.round(orect.left), top: Math.round(orect.top), width: Math.round(orect.width), height: Math.round(orect.height) }
           out.overlayDisplay = getComputedStyle(overlay).display

           chat.visible = true
           overlay.dataset.dsceOpen = 'true'
           chat.guestHost = overlay.querySelector('.dsce-surface__body')
           await chat.mount()
           out.phaseAfterMount = chat.phase
           out.detailAfterMount = chat.detail
           const deadline = Date.now() + 30000
           while (Date.now() < deadline && chat.phase !== 'loaded' && chat.phase !== 'failed') {
             await new Promise((r) => setTimeout(r, 250))
           }
           out.phaseFinal = chat.phase
           out.detailFinal = chat.detail
           const wv = overlay.querySelector('webview')
           out.webviewPresent = wv !== null
           out.webviewUrl = wv === null ? null : (typeof wv.getURL === 'function' ? wv.getURL() : 'n/a')
           out.webviewUA = wv === null ? null : (typeof wv.getUserAgent === 'function' ? wv.getUserAgent().slice(-40) : 'n/a')
           const diag = overlay.querySelector('.dsce-surface__diag')
           out.diagShown = diag !== null && diag.hidden === false
           out.diagText = diag === null ? null : (diag.textContent ?? '').slice(0, 600)
         } catch (error) {
           out.fatal = String(error && error.stack ? error.stack : error)
         }
         return out
       })()`,
      true,
    )
    .catch((error) => ({ fatal: 'probe failed: ' + String(error) }))
  log('[LIVE] embed probe', JSON.stringify(report.embedProbe))

  // The switcher only exists while a Session header is mounted, and a brand-new
  // profile opens on the Hero (no Session). Creating one is the only way to
  // reach the real slot, so drive the composer exactly as a user would.
  report.switcherBeforeSession = await win.webContents
    .executeJavaScript(`!!document.querySelector('.dsce-switch')`, true)
    .catch(String)

  if (report.switcherBeforeSession !== true) {
    report.domProbe = await win.webContents
      .executeJavaScript(
        `JSON.stringify({
           editables: [...document.querySelectorAll('[contenteditable], textarea, input, [role="textbox"]')]
             .slice(0, 8)
             .map((el) => ({ tag: el.tagName, ce: el.getAttribute('contenteditable'), role: el.getAttribute('role'), cls: String(el.className).slice(0, 60), ph: el.getAttribute('placeholder') ?? el.getAttribute('data-placeholder') })),
           mainText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200),
         })`,
        true,
      )
      .catch((error) => String(error))
    log('[LIVE] dom probe', report.domProbe)

    report.composerFill = await win.webContents
      .executeJavaScript(
        `(() => {
           const edit = document.querySelector('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')
           if (edit === null) return 'no-composer'
           edit.focus()
           if (edit instanceof HTMLTextAreaElement || edit instanceof HTMLInputElement) {
             const proto = edit instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
             Object.getOwnPropertyDescriptor(proto, 'value').set.call(edit, 'hello')
             edit.dispatchEvent(new Event('input', { bubbles: true }))
           } else {
             edit.textContent = 'hello'
             edit.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'hello' }))
           }
           return edit.tagName + ' ce=' + edit.getAttribute('contenteditable') + ' text=' + (edit.value ?? edit.textContent)
         })()`,
        true,
      )
      .catch((error) => String(error))
    log('[LIVE] composer fill', JSON.stringify(report.composerFill))

    await new Promise((resolve) => setTimeout(resolve, 600))
    report.composerSubmit = await win.webContents
      .executeJavaScript(
        `(() => {
           // Prefer the dedicated submit control; fall back to a keyboard event
           // on the editor, which is how the composer also commits.
           const buttons = [...document.querySelectorAll('button')]
           const submit = buttons.find((b) => b.type === 'submit' && !b.disabled)
           if (submit !== undefined) { submit.click(); return 'clicked-submit' }
           const edit = document.querySelector('textarea, [contenteditable="true"]')
           if (edit === null) return 'no-composer'
           edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
           return 'pressed-enter'
         })()`,
        true,
      )
      .catch((error) => String(error))
    log('[LIVE] composer submit', JSON.stringify(report.composerSubmit))

    // A Session may take a moment to appear in the sidebar and select itself.
    report.sessionCreated = await waitFor(
      `!!document.querySelector('[class*="session"]') || document.body.innerText.includes('你好') || /hello|你好/.test(document.body.innerText)`,
      30000,
      'session created',
    )
  }

  report.switcherMounted = await waitFor(`!!document.querySelector('.dsce-switch')`, 30000, 'switcher in Session header')
  report.sessionHeaderPresent = await win.webContents
    .executeJavaScript(`!!document.querySelector('[class*="header"]')`, true)
    .catch(String)

  if (report.switcherMounted) {
    report.switcherText = await win.webContents
      .executeJavaScript(`document.querySelector('.dsce-switch').textContent`, true)
      .catch(String)
    report.overlayPresent = await win.webContents
      .executeJavaScript(`!!document.querySelector('.dsce-overlay')`, true)
      .catch(String)

    // Click the DeepSeek segment; the overlay must appear and the guest attach.
    const activated = await win.webContents
      .executeJavaScript(
        `(() => {
           const seg = [...document.querySelectorAll('.dsce-switch__seg')].find((el) => /deepseek/i.test(el.textContent || ''))
           if (seg === undefined) return 'no-segment'
           seg.click()
           return 'clicked'
         })()`,
        true,
      )
      .catch((error) => String(error))
    log('[LIVE] activate embedded chat', JSON.stringify(activated))
    report.activate = activated

    report.overlayOpened = await waitFor(
      `document.querySelector('.dsce-overlay')?.dataset.dsceOpen === 'true'`,
      15000,
      'overlay open',
    )
    report.webviewAttached = await waitFor(`!!document.querySelector('.dsce-surface__body webview')`, 15000, 'webview element')
    report.guestNavigated = await waitFor(
      `(() => { const w = document.querySelector('.dsce-surface__body webview'); return w !== null && typeof w.getURL === 'function' && /^https:\\/\\/chat\\.deepseek\\.com/.test(w.getURL()) })()`,
      30000,
      'guest at chat.deepseek.com',
    )
    report.guestUrl = await win.webContents
      .executeJavaScript(
        `(() => { const w = document.querySelector('.dsce-surface__body webview'); return w && typeof w.getURL === 'function' ? w.getURL() : null })()`,
        true,
      )
      .catch(String)
    report.statusPhase = await win.webContents
      .executeJavaScript(`document.querySelector('.dsce-surface__dot')?.dataset.phase ?? null`, true)
      .catch(String)
    report.statusText = await win.webContents
      .executeJavaScript(`document.querySelector('.dsce-surface__label')?.textContent ?? null`, true)
      .catch(String)
  }

  try {
    fs.writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG())
    log('[LIVE] screenshot written')
  } catch (error) {
    log('[LIVE] screenshot failed', String(error))
  }

  log('[LIVE] report', JSON.stringify(report))
  log('[LIVE] DONE')
  setTimeout(() => app.quit(), 400)
})

setTimeout(() => {
  log('[LIVE] TIMEOUT')
  app.quit()
}, 180000)
