/**
 * harness/main.js — a faithful replica of the dsh desktop shell's guest guard.
 *
 * This exists to test the plugin's lease handshake against the *real* rules the
 * shipping shell enforces, without needing to install the plugin and restart
 * the desktop app for every iteration.
 *
 * The replica is transcribed from the shipping `@deepseek-ai/dsh-desktop`
 * `app.asar/lib/main.js` (v0.2.0-rc.2):
 *
 *   · `DesktopBrowserGuests.acquire()`   — partitions cached per workspace,
 *                                          `dsh-sidebar-browser-<uuid>`
 *   · `DesktopBrowserGuests.bind()`      — `will-attach-webview` validation
 *   · `did-attach-webview`               — lease recovery from the guest URL
 *
 * If the shell's rules change, this file must be re-transcribed; it is a test
 * double, not an abstraction.
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
// Replica of the shell's DesktopBrowserGuests
// ---------------------------------------------------------------------------

class BrowserGuests {
  constructor() {
    this.partitions = new Map()
    this.leases = new Map()
  }

  acquire(owner, workspace) {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${crypto.randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = crypto.randomUUID()
    this.leases.set(lease, { owner, partition, attached: false })
    return { lease, partition }
  }

  async release(owner, id) {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const lease = this.leases.get(id)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    this.leases.delete(id)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise((resolve) => guest.once('destroyed', resolve))
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  bind(window) {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#') ? params.src.slice(12) : ''
      const lease = this.leases.get(id)
      const accepted = lease !== undefined && lease.owner === owner && !lease.attached && params.partition === lease.partition
      log('[SHELL] will-attach-webview', JSON.stringify({ src: params.src, partition: params.partition, leaseFound: lease !== undefined, accepted }))
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
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = url.startsWith('about:blank#') ? url.slice(12) : ''
        const lease = this.leases.get(id)
        log('[SHELL] did-attach-webview dom-ready', JSON.stringify({ url, leaseFound: lease !== undefined }))
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        const allowNavigation = (value) => {
          if (!URL.canParse(value)) return false
          const target = new URL(value)
          return ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password
        }
        guest.setWindowOpenHandler(({ url }) => {
          log('[SHELL] window-open requested', url)
          return { action: 'deny' }
        })
        guest.on('will-frame-navigate', (event) => {
          log('[SHELL] will-frame-navigate', JSON.stringify({ url: event.url.slice(0, 80), isMainFrame: event.isMainFrame, allowed: !event.isMainFrame || allowNavigation(event.url) }))
          if (event.isMainFrame && !allowNavigation(event.url)) event.preventDefault()
        })
        guest.on('will-attach-webview', (event) => event.preventDefault())
      })
      guest.on('destroyed', () => log('[SHELL] guest destroyed'))
      guest.session.setUserAgent(guest.getUserAgent())
    })
  }

  configureSession(browserSession) {
    browserSession.setPermissionRequestHandler((_c, _p, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.on('will-download', (event) => event.preventDefault())
  }
}

// ---------------------------------------------------------------------------
// Application window: the surface the plugin bundle runs on
// ---------------------------------------------------------------------------

// Mirrors the shell's main window: webviewTag enabled, sandboxed renderer,
// contextIsolation, and the product preload that publishes `window.dshDesktop`.
const PRELOAD = path.join(__dirname, 'preload.cjs')

const guests = new BrowserGuests()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 940,
    show: true,
    webPreferences: {
      preload: PRELOAD,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
      devTools: true,
    },
  })
  guests.bind(win)

  win.webContents.on('console-message', (event) => {
    const message = typeof event === 'object' && event !== null && 'message' in event ? event.message : String(event)
    if (/Security Warning|consult|electronjs\.org|once the app/.test(message)) return
    log('[RENDERER]', String(message).slice(0, 220))
  })

  ipcMain.handle('dsh-desktop:browser-acquire', (event, workspace) => guests.acquire(event.sender, workspace))
  ipcMain.handle('dsh-desktop:browser-release', (event, lease) => guests.release(event.sender, lease))

  // The window must load over real HTTP: `file://` is opaque enough that some
  // webview paths behave differently, and the module-loader contract is a
  // same-origin classic script. The bundle lives outside this directory, so it
  // is mounted at an explicit path — `..` inside a URL is collapsed by the
  // client before the request is ever sent.
  const BUNDLE = path.join(__dirname, '..', '..', 'dist', 'dsh-deepseek-chat-embed.bundle.js')
  const http = require('node:http')
  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0]
    if (pathname === '/bundle.js') {
      if (!fs.existsSync(BUNDLE)) {
        res.writeHead(500).end('bundle not built — run `npm run build` first')
        return
      }
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(fs.readFileSync(BUNDLE))
      return
    }
    if (pathname.startsWith('/vendor/')) {
      const vendor = path.join(__dirname, pathname)
      if (!vendor.startsWith(path.join(__dirname, 'vendor')) || !fs.existsSync(vendor)) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(fs.readFileSync(vendor))
      return
    }
    const file = path.join(__dirname, pathname === '/' ? '/index.html' : pathname)
    if (!file.startsWith(__dirname) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
    res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  log('[HARNESS] serving on', `http://127.0.0.1:${port}/`)
  await win.loadURL(`http://127.0.0.1:${port}/index.html`)

  // The page's work is asynchronous (the lease handshake plus a real network
  // load), so the result is polled rather than read once after load.
  let report
  for (let attempt = 0; attempt < 120; attempt += 1) {
    report = await win.webContents
      .executeJavaScript('window.__HARNESS_RESULT__ ?? null', true)
      .catch((error) => ({ error: String(error) }))
    if (report !== null && report !== undefined) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  log('[HARNESS] result', JSON.stringify(report))

  // The page leaves the guest mounted so this frame shows the embedded chat
  // rather than an empty host; the lease is released immediately afterwards.
  try {
    fs.writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG())
    log('[HARNESS] screenshot written')
  } catch (error) {
    log('[HARNESS] screenshot failed', String(error))
  }
  const released = await win.webContents
    .executeJavaScript('window.__HARNESS_RELEASE__ ? window.__HARNESS_RELEASE__() : "no release hook"', true)
    .catch((error) => String(error))
  log('[HARNESS] release', JSON.stringify(released))

  log('[HARNESS] DONE')
  setTimeout(() => app.quit(), 300)
})

setTimeout(() => {
  log('[HARNESS] TIMEOUT')
  app.quit()
}, 60000)
