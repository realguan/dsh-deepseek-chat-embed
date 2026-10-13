/**
 * harness/preload.cjs — publishes the same desktop surface the shipping shell's
 * `preload-app.cjs` does, reduced to the guest bridge this plugin consumes.
 *
 * The real preload also exposes updates, shortcuts, directory picking and the
 * Platform view; none of those are reachable from the plugin, so they are
 * omitted rather than stubbed.
 */
const { contextBridge, ipcRenderer } = require('electron')

const listeners = new Map()

function createDesktopBrowserBridge() {
  return {
    acquire: (workspace) => ipcRenderer.invoke('dsh-desktop:browser-acquire', workspace),
    release: (lease) => ipcRenderer.invoke('dsh-desktop:browser-release', lease),
    onOpenRequested(lease, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) {
        callbacks = new Set()
        listeners.set(lease, callbacks)
      }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
      }
    },
  }
}

// The shipping shell only publishes the product API on its own origin; the
// harness serves the same shape unconditionally.
contextBridge.exposeInMainWorld('dshDesktop', {
  protocolVersion: 1,
  browser: createDesktopBrowserBridge(),
})
