# 内嵌契约：为什么是 webview，以及那个奇怪的握手

本文记录 `src/client.js` 里每一条反直觉的实现决策，以及确定它们的实验。
这些不是设计偏好，而是对 dsh 桌面版现状的适配；**壳升级后必须重新验证**。

对应版本：`@deepseek-ai/dsh-desktop` 0.2.0-rc.2（Electron 44.7.0 / Chrome 152）。

---

## 1. iframe 不可能成功

```bash
$ curl -sI https://chat.deepseek.com/
content-security-policy: frame-ancestors 'none'
```

`frame-ancestors 'none'` 拒绝被任何源嵌入。dsh 桌面版的 Web UI 运行在
`http://127.0.0.1:<port>`，是普通 HTTP 源，因此 `<iframe>` 必然被浏览器拒绝。

**推论**：任何「纯前端插件 + iframe」方案在 dsh Web GUI、浏览器 profile、
以及桌面版里都不可行。这不是配置问题，没有绕过空间。

`<webview>` 是独立的顶层 WebContents，`frame-ancestors` 不适用。实测（Electron 44.7.0）：

| 观测项 | 结果 |
| --- | --- |
| `document.title` | `DeepSeek - 探索未至之境` |
| 落地 URL | `https://chat.deepseek.com/sign_in` |
| 落地 cookie | `ds_session_id`、`smidV2`、`HWWAFSESID` … |
| 渲染 | 登录页完整（截图见下） |

---

## 2. 桌面壳的租约门禁

`app.asar/lib/main.js` 的 `DesktopBrowserGuests.bind()`：

```js
owner.on('will-attach-webview', (event, preferences, params) => {
  const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
    ? params.src.slice(12) : ''
  const lease = this.leases.get(id)
  if (lease === undefined || lease.owner !== owner || lease.attached
      || params.partition !== lease.partition) {
    event.preventDefault()          // 一律拒绝
    return
  }
  lease.attached = true
  // …随后清空除 disablePopups 外的所有 preferences，并写入固定的隔离策略
})
```

三个必须同时满足的条件：

1. `params.src` **恰好**是 `about:blank#<lease>`；
2. `params.partition` 与壳为该 lease 下发的 partition 完全一致；
3. lease 由 `window.dshDesktop.browser.acquire(workspace)` 取得，且此前未被使用。

`acquire` 的返回形状来自 `preload-app.cjs`：

```js
acquire: (workspace) => electron.ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace),
release: (lease)   => electron.ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease),
```

`window.dshDesktop` 只在 Electron 主世界可见。而 dsh 的客户端插件 bundle 是
**同源 classic script**（`dsh-client-modules/lib/client.js` 的 `defaultLoadBundle`
用 `document.createElement('script')` 注入），因此插件**确实运行在主世界**，
可以读到 `window.dshDesktop`。这是本方案成立的唯一支点。

> 注意：`will-attach-webview` 会**删除** webview 上的 `preload` 等偏好，
> 唯独保留 `disablePopups`。而 `params.useragent`（元素属性）不在其中——
> 这一点被第 4 节利用。

### 2.1 partition 是持久化的

`acquire` 对同一 workspace 复用同一 partition（进程内缓存），其形式为
`dsh-sidebar-browser-<uuid>`；壳未给它加 `persist:` 前缀，但 Electron 在
`session.fromPartition('x')` 与 `persist:x` 上行为一致地落盘到 userData。
本插件因此用固定的 workspace 标识换稳定 partition，登录态得以跨重启保留。

---

## 3. 从租约 guest 里导航出去：只有一条路

这是最容易踩空的一步。guest 停在 `about:blank#<lease>` 后：

| 方式 | 结果 |
| --- | --- |
| `el.loadURL(url)` | ❌ 静默无效：无导航、无 `will-frame-navigate`、无报错 |
| `el.setAttribute('src', url)` | ❌ 同上 |
| `el.executeJavaScript('location.href = url')` | ✅ 触发文档级导航 |

实测日志（复刻壳的校验逻辑）：

```
[SHELL] will-attach-webview {"src":"about:blank#bf0aecd5-…","leaseFound":true,"accepted":true}
[SHELL] did-attach-webview dom-ready {"url":"about:blank#bf0aecd5-…"}
[GUEST] will-frame-navigate https://chat.deepseek.com/ ALLOW
[GUEST] dom-ready https://chat.deepseek.com/sign_in
[MAIN] FINAL URL https://chat.deepseek.com/sign_in
```

另需注意：**第一次 `dom-ready` 可能在壳登记租约之前到达**，所以导航要带重试
（实现里 `NAVIGATE_MAX_ATTEMPTS` / `NAVIGATE_RETRY_MS`）。

还有一个附带事实：一旦 guest 真正导航离开 `about:blank#<lease>`，壳在
`dom-ready` 时按 URL 反查 lease 的那段逻辑就再也匹配不上，因此**其后续
导航守卫不再生效**。本插件自行限定来源，不依赖壳的这段守卫。

---

## 4. 风控弹窗与 User-Agent

默认 Electron UA 含 `Electron/44.7.0`，chat.deepseek.com 会叠加一个
「使用环境异常」弹窗：

```
text: "…微信扫码登录 浙ICP备2023025841号 · 联系我们 使用环境异常 当前页面的使用环境可能存在数据和隐私泄露风险…"
```

修法：把 webview 的 `useragent` **属性**设为去掉 Electron token 的 Chrome UA。

```
[MAIN] guest UA = Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36
[MAIN] INFO {"warn":false,"text":"+86 发送验证码 … 用户协议 与 隐私政策 … 微信扫码登录 …"}
```

为什么用属性而不是 `session.setUserAgent()`：插件拿不到 partition 名字
（`guest.session.getPartition` 不存在），而属性在 `will-attach-webview`
的偏好清理中存活下来，且早于首次请求生效。

---

## 5. 「共享登录状态」的真实边界

调研结论：**不存在可共享的既有 chat 登录态**。

| 凭据 | 存放 | 能否用于 chat.deepseek.com |
| --- | --- | --- |
| 桌面版自身登录态 | `<userData>/Cookies` 表：`127.0.0.1` / `dsh-auth-<token>` | ❌ 只是本地 Host 的 bearer token |
| DeepSeek 平台账号 | `persist:dsh-platform-<sha256([origin,userId])>` | ❌ 见下 |
| chat.deepseek.com 会话 | 原先不存在 | — |

平台账号的默认配置（`dsh-deepseek-account-platform/lib/index.js`）：

```js
platformOrigin:  "https://platform.deepseek.com"
inferenceOrigin: "https://api.deepseek.com"
// 接口族：`${origin}/auth-api/v0/dsh/${method}`
```

即 dsh 的 DeepSeek 账号是**平台侧 dsh 专用凭据**，与消费端 chat 的
`ds_session_id` 不是同一套，无法直接复用。

因此本插件采用与桌面壳处理 `DesktopPlatformView` 相同的方式：
在内嵌 guest 的持久化 partition 里**登录一次**，长期复用。
「共享」发生在插件自开的多个面板之间，而不是从 dsh 账号里派生。

---

## 6. Slot 契约（与内嵌无关但同样易错）

- `register` 是**两参数** `(options, component)`，slot key 在 `options.name`；
  list slot 另需 `id`（可带 `order` / `label`）。三参数写法会直接抛错。
- 注册进**未声明**的 slot 会抛错，且会话头部只在 conversation header entry
  挂载期间存在 → 必须用 `ctx.slots.inject(key, cb)` 包住注册。
- 插件对象上的 `inject` **不能**写客户端服务名：该对象同时被 Node 侧 profile
  loader 加载，写 `['slots']` 会让条目永久 `pending (waiting for service: slots)`。
  客户端注入应写在 `package.json` 的 `dsh.client.inject`
  （本包声明 `@deepseek-ai/dsh-client-runtime`，由它提供 `slots`）。
- React 来源：native bundle 用 `require('react')`——Web 前端的 `staticModules`
  seed 表（`dsh-web-frontend/dist/assets/index-*.js`）发布 `react`；
  **`globalThis.React` 不存在**。

---

## 7. 复现方式

`test/harness` 是上述门禁的忠实复刻，逐行对应
`@deepseek-ai/dsh-desktop` 0.2.0-rc.2 的 `app.asar/lib/main.js`：

```bash
npm run check                       # 构建 dist bundle
"$ELECTRON" test/harness            # 租约握手 + Slot 契约回归
```

它断言：模块以正确 id 装载、`apply()` 不抛、`register` 收到两参数、
`slots.inject` 被调用、样式注入、lease 通过校验、导航到达 chat.deepseek.com、
无风控弹窗、lease 可释放。

壳升级后，`test/harness/main.cjs` 里的 `BrowserGuests` 必须重新转写。

---

## 8. 布局：必须锚到「中栏 pane」，不能锚窗口

第一版把浮层按 `position: fixed; inset: 0` 铺满窗口，只按侧栏宽度做了左内缩，
于是它盖住了 dsh 的会话列表——**回归，不是偏好**。

壳的真实布局是一个三列 grid（`dsh-client-ui-layout`）：

```
grid-template-columns: <sidebar>px minmax(...) <rightbar>px
```

中栏的 pane 由 `data-dockkit-pane` 标记，侧栏是 `[data-side="left"]`，
窗口拖拽区是 `[data-shell-leading]`。所以正确做法是**测量**中栏 pane 的
`getBoundingClientRect()` 并把浮层铺在它上面，而不是维护一张偏移表——后者会在
侧栏折叠、右栏展开、浮动 pane 出现时全部失效。

只监听 `window.resize` 也不够：折叠侧栏会移动中栏而**不改变窗口尺寸**。
因此还要对 `document.body` 与已存在的 `[data-dockkit-pane]` / `[data-side="left"]`
挂 `ResizeObserver`，并在 pane 惰性挂载后补测一次。

状态栏也一并去掉了：内嵌页面自带页头，再叠一条就是第二个 header。
只在「正在启动」与「失败」时显示一颗悬浮胶囊（失败时带重试，重试必须**换新
lease**——壳把 lease 标记为已用后永久拒绝，无法原地重试）。

`test/harness` 里用 `#shell` 复刻了这个 grid，并断言：

```
pane    : {left: 260, top: 28, width: 1100}
overlay : {left: 260, top: 28, width: 1100, height: 735}
与 pane 对齐 / 侧栏未被盖住 / 旧状态条已移除 = true
```

---

## 9. 多桌面宿主适配架构：DesktopGuestAdapter 策略模式

为了在长期维护中支持 DSH 官方桌面版（Electron）、DSH Dock（Tauri v2）以及未来可能的其它第三方桌面壳（Wails、CEF、Qt 等），代码重构采用了标准策略模式（Strategy Pattern）：

```
                       ┌──────────────────────┐
                       │     EmbeddedChat     │ (UI 宿主协调器)
                       │ (Overlay/DOM/Resize) │
                       └──────────┬───────────┘
                                  │ 依赖抽象
                                  ▼
                    ┌────────────────────────────┐
                    │    DesktopGuestAdapter     │ (统一接口契约)
                    │  - mount(options)          │
                    │  - syncGeometry(box, frame)│
                    │  - setVisible(bool)        │
                    └─────────────┬──────────────┘
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
┌───────────────────────┐ ┌───────────────┐ ┌───────────────────────┐
│ ElectronGuestAdapter  │ │TauriGuestAdapter│ │CustomNativeGuestAdapter│
│ (DOM <webview>+Lease) │ │(Native Webview) │ │(window.__DSH_CHAT_..)  │
└───────────────────────┘ └───────────────┘ └───────────────────────┘
```

### 抽象职责划分：
1. **`EmbeddedChat`（单一职责）**：
   - 专注负责 Overlay DOM 节点测量、全屏/窗口变化监听、`ResizeObserver` 防抖测量；
   - 协调左侧导航面板（`main`）、顶部常驻按钮（`utilities` / `overlay`）与右侧栏（`sidebar.right.pane.tab`）的状态互斥；
   - **完全不感知底层的桌面平台差异与 IPC 协议细节**。
2. **`DesktopGuestAdapter`（开闭原则）**：
   - **`ElectronGuestAdapter`**：处理主世界 `window.dshDesktop.browser.acquire / release` 租约握手，创建并管理 DOM `<webview>` 节点，几何尺寸随 CSS 流自适应；
   - **`TauriGuestAdapter`**：处理基于 WebKit/WebView2 的原生子视窗（ADR-0033），负责 `embed_chat_open`、`embed_chat_resize`（带 titlebar 差值偏移）、`embed_chat_hide` 及 `embed_chat_eval` 脚本调用通道与 request-id 异步串行化；
   - **`CustomNativeGuestAdapter`**：开放给任何遵循 `window.__DSH_CHAT_EMBED__` 的第三方多视窗桌面壳；
   - **`resolveGuestAdapter()`**：按环境自适应探测当前宿主并返回单例策略，若均不可用则优雅降级为 Web 伴侣/引导视图。


---

## 10. 浮层的脱流不变量：不能只靠那张可被 dispose 的 `<style>`（2026-10-14 现场故障）

### 现象

Electron 桌面版上，滚轮能把**整个壳页面**推上去，壳内容下方露出「额外的内容」；
同一张截图里，聊天只剩一张 **538x124** 的白卡：硬边、无圆角、无阴影，贴在壳
`#root` 的下边缘、窗口最左侧，里面的 chat.deepseek.com 按 538 宽重排过（紧凑头部 +
被切一半的快捷胶囊）。

### 根因

`.dsce-overlay` 的「脱流」原本**只**由插件自己注入的 `<style>` 提供
（`.dsce-overlay{position:fixed}`），而那张样式表是可被 dispose 的：

- 样式先走、浮层后走（或没走）时，`.dsce-overlay` 退化成 `<body>` 末尾的普通块；
- 壳的 `html,body,#root{height:100%}`、frame 又是 `height:100%;overflow:hidden`，
  所以多出来的那一块**只能**来自 `#root` 之后的节点——正是浮层；
- 于是壳的文档被撑高（整页可滚），浮层按自己最后拿到的 `left/top/width/height`
  内联值画成那张白卡，里面还挂着一个**仍然活着**的 guest（租约没释放）。

Chromium 155（与 Electron 同引擎）实测，同样的 DOM + 同一份 CSS：

| | `scrollHeight - innerHeight` | 浮层 `position` | guest 盒 |
| --- | --- | --- | --- |
| 样式表在场 | 0 | `fixed` | 538x124 |
| 样式表撤走（修前） | **124** | **`static`** | 538x0 |
| 样式表撤走（修后） | 0 | `fixed` | 538x124 |

### 修法（四条，缺一条就还能复现）

1. **行内不变量**：`markOverlaySurface()` 把 `position/z-index/display/overflow/
   box-sizing/background` 写成行内样式，并给 surface / surface body 同样补上行内
   盒模型——不依赖任何可被移除的样式表；
2. **同寿**：样式表的 effect 清理里顺手按 DOM 标记（`data-dsh-deepseek-chat-embed-surface`）
   清掉浮层残骸，不依赖 `destroy()` 的调用顺序与成败；
3. **应用期清扫**：`apply()` 一进来就扫残骸（旧的只在 `open()` 里扫，等不到
   `open()` 的残骸就一直撑着文档）；
4. **`destroy()` 先摘 DOM 再放租约**，并吞掉 release 失败——反过来一旦 release
   抛错/挂起，就正好留下「入流的无样式浮层」。

### 附带修掉的两个面

- **宿主离开视口要让位**：原生子视窗不参与页面滚动、固定浮层也不会自己跟手。
  宿主滚出视口即 `hide()`，回来由 `syncToHost()` 末尾的 `open()` 接回；
- **滚动不触发 `ResizeObserver`**（尺寸没变），所以补一条 `scroll` 捕获监听：
  rAF 节流 + 只测宿主一个盒子，盒子没变就不重算（`chromeBottom()` 是文档级查询，
  逐帧跑就是插件自己记过的「1434 次 resize、全同一个 rect」那类事故）。

DSH Dock（原生子视窗）侧同口径的防线在 `dsh-dock` 的
`commands/chat_embed.rs::rect_is_placeable`：退化 rect（0 宽/0 高/NaN）一律让位，
不再按「最小 100x100」摆一张谁也点不动的白卡。
