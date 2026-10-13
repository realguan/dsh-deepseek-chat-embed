/**
 * live/preload.cjs — the same desktop surface the shipping shell publishes.
 *
 * Identical in shape to `test/harness/preload.cjs`; the live test needs its own
 * copy because it loads the real dsh Web UI rather than a fixture page.
 */
const { contextBridge, ipcRenderer } = require('electron')

const listeners = new Map()

contextBridge.exposeInMainWorld('dshDesktop', {
  protocolVersion: 1,
  browser: {
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
  },
})
