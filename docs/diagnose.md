# 现场诊断（点了没反应时）

> **2026-10-08 更新**：悬浮提示现在是完整的单行状态报告，不需要 DevTools：
>
> ```
> v0.1.0-r6 · 点击 2 次 · bridge=ok · overlays=1 [block/true/576x795] · own=576x795
>          · geometry=576x795 · phase=loaded · guests=1 handle=yes
> ```
>
> 各字段含义：
>
> | 字段 | 读法 |
> | --- | --- |
> | `点击 N 次` | N=0 说明点击没到达处理函数；N>0 而没反应，问题在下游 |
> | `overlays=N [...]` | **N>1 说明有陈旧浮层残留**，方括号里逐个列出 显示/开启/盒子 |
> | `own=` | 本实例自己的浮层盒子（`querySelector` 可能拿到陈旧元素，故单列） |
> | `geometry=` 带 `STALE` | 测量值与实际盒子不符 |
> | `phase=` / `guests=` | 握手阶段 / 已挂上的 webview 数量 |


打包版桌面应用**不带开发者工具**，所以插件被设计成能自己说明情况。
按下面顺序做，全程不需要 DevTools。

## 1. 先确认跑的是新 bundle

把鼠标停在会话头部的 `DSH` 段上，**悬浮提示**会显示构建戳：

```
显示 dsh 会话 · v0.1.0+geom2-diag1
```

| 看到什么 | 结论 |
| --- | --- |
| 有这个戳 | 新 bundle 已加载 → 继续第 2 节 |
| 没有 / 没有悬浮提示 | bundle 没重载 → **彻底退出应用**（`⌘Q`，不是关窗口）再开 |

## 2. 点一次 `DeepSeek`

三种可能：

| 现象 | 含义 |
| --- | --- |
| 右侧出现 chat.deepseek.com | 正常 |
| 浮层左下角出现一块等宽字体的诊断区 | 握手或布局失败，**截图发回** |
| 完全没变化 | 点击没被收到，或浮层被压成 0 尺寸 → 见第 3 节 |

`open()` 里的任何异常现在都会被捕获并渲染成诊断区，所以「彻底静默」只可能来自
浮层创建之前——即点击没到、或 bundle 是旧的。

## 3. 诊断区长什么样

```
build    : v0.1.0+geom2-diag1
reason   : overlay open for 5s without a loaded guest (navigating)
phase    : navigating (正在加载 chat.deepseek.com…)
error    : none
bridge   : ok
geometry : 260,28 1100x735
overlay  : 260,28 1100x735
display  : block
panes    : main=260,28 1100x735
sidebar  : right=260
webview  : present
viewport : 1360x763
```

重点看这几行：

| 字段 | 异常值意味着 |
| --- | --- |
| `build` | 与源码不一致 → 旧 bundle |
| `bridge` | `MISSING` → 不在桌面版渲染进程里 |
| `display` | `none` → 样式没生效 |
| `overlay` | `0x0` → 几何测量失败，浮层不可见 |
| `geometry` vs `overlay` | 不一致 → CSS 或层叠上下文问题 |
| `panes` | `none` → 没找到中栏 pane，几何退回侧栏估算 |
| `webview` | `none` 且 `phase=failed` → 租约握手失败 |

## 附：控制台脚本（可选）

如果哪天 DevTools 能开，这段能一次性拿到更细的状态：

```js
(() => {
  const out = {}
  const overlay = document.querySelector('.dsce-overlay')
  out.switcher = (() => {
    const s = document.querySelector('.dsce-switch')
    if (s === null) return 'MISSING'
    return [...s.querySelectorAll('button')].map(b => b.textContent + (b.dataset.active === 'true' ? '(active)' : ''))
  })()
  out.overlayExists = overlay !== null
  out.overlayOpen = overlay?.dataset.dsceOpen ?? null
  if (overlay !== null) {
    const r = overlay.getBoundingClientRect()
    out.overlayRect = { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    out.overlayDisplay = getComputedStyle(overlay).display
    out.webview = overlay.querySelector('webview') !== null
    out.guestUrl = (() => { try { return overlay.querySelector('webview')?.getURL?.() ?? null } catch (e) { return 'ERR:' + e } })()
    out.pillPhase = overlay.querySelector('.dsce-surface__dot')?.dataset.phase ?? null
    out.pillText = overlay.querySelector('.dsce-surface__text')?.textContent ?? null
    out.diag = overlay.querySelector('.dsce-surface__diag')?.textContent ?? null
  }
  out.panes = [...document.querySelectorAll('[data-dockkit-pane],[data-dockkit-content]')].map(el => {
    const r = el.getBoundingClientRect()
    return { key: el.dataset.dockkitPane ?? el.dataset.dockkitContent, left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  })
  out.sidebar = (() => { const s = document.querySelector('[data-side="left"]'); if (!s) return 'MISSING'; return { right: Math.round(s.getBoundingClientRect().right) } })()
  out.bridge = typeof window.dshDesktop?.browser?.acquire
  return JSON.stringify(out, null, 2)
})()
```
