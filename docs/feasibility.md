# 「DeepSeek 聊天嵌入 dsh 插件」可行性调研

调研日期：2026-10-08 ｜ 结论：**技术上可行，但两条路线代价差异极大**

## 1. 实测结论：iframe 路线已死

```
$ curl -sI https://chat.deepseek.com/
content-security-policy: frame-ancestors 'none'
```

chat.deepseek.com 明确禁止被任何源 frame 嵌入。dsh 桌面版的 Web UI 运行在
`http://127.0.0.1:19387`（HTTP 源），因此 `<iframe>` 必然被浏览器拒绝。
→ **纯前端插件 + iframe 方案不可行**（对 dsh Web GUI / 浏览器 profile 同样不可行）。

## 2. 实测结论：Electron webview 路线可行 ✅

用独立 Electron 44.7.0 探针（`/tmp/dsh-webview-test`）实测：

| 观测项 | 结果 |
| --- | --- |
| `<webview src="https://chat.deepseek.com/">` | 成功加载，未跳登录墙以外 |
| `document.title` | `DeepSeek - 探索未至之境` |
| 登录页 URL | `https://chat.deepseek.com/sign_in` |
| 页面文本 | `+86 发送验证码 / 密码登录 / 使用 Apple 账号登录 / 微信扫码登录` |
| 落地 Cookie | `ds_session_id`、`smidV2`、`HWWAFSESID` … 均写入 partition |
| 截图 | `/tmp/dsh-webview-test/window.png`（登录页完整渲染） |

关键差异：`frame-ancestors` 是**浏览器**的嵌入限制，webview 是独立顶层
WebContents，不受该指令约束。

### 2.1 附带坑：「使用环境异常」弹窗可消除

默认 Electron UA（含 `Electron/44.7.0`）会触发 chat 的风控弹窗
（"当前页面的使用环境可能存在数据和隐私泄露风险"）。
`session.setUserAgent()` 去掉 Electron token 后：

```
{"dialog":false,"bodyHasWarn":false,
 "text":"+86 发送验证码 … 用户协议 与 隐私政策 … 微信扫码登录"}
```

→ 必须做 UA 归一化。

## 3. dsh 桌面版（Electron）的真实结构

- 应用：`@deepseek-ai/dsh-desktop` 0.2.0-rc.2，Electron + Chrome 152
- 主进程：`app.asar/lib/main.js`（12331 行）
- 预加载：`app.asar/lib/preload-app.cjs`；渲染进程暴露
  `window.dshDesktop.browser.acquire(workspace)` / `.release(lease)`
- Host：Electron fork 出的 Node 子进程（`@deepseek-ai/dsh-desktop-host`），
  dsh 插件就跑在这里面 / 由它服务的 Web UI 里

### 3.1 webviewTag 是开着的，但被 lease 门禁看住

`main.js:11106` → `webviewTag: primary`（主应用窗口 = true）。
但 `DesktopBrowserGuests.bind()`（`main.js:9620+`）在 `will-attach-webview` 里：

```js
const lease = this.leases.get(id);   // id 取自 src = "about:blank#<lease>"
if (lease === undefined || lease.owner !== owner || lease.attached
    || params.partition !== lease.partition) {
  event.preventDefault();            // 未持 lease 的 webview 一律拒绝
  return;
}
```

lease 只能由 `window.dshDesktop.browser.acquire()` 取得，而该 bridge 只暴露在
**Electron 主世界**；dsh 客户端插件的动态包只有
`ctx / React / host / styles / console` 五个内建，**拿不到 `window.dshDesktop`**。
→ **不改 dsh 桌面版源码，纯插件无法创建 webview。**

### 3.2 意外的正面发现：guest 的导航策略是开放的

`allowedNavigation()` 只要求 `http(s)`、无 userinfo、且**不是 dsh Host 自身**。
`chat.deepseek.com` 完全在白名单内 → 壳本身对"侧边栏浏览器"类 guest 是通用的。

## 4. 「共享登录状态」的真实边界（重要）

| 凭据 | 存放位置 | 能否复用到 chat.deepseek.com |
| --- | --- | --- |
| dsh 桌面版自身登录态 | `Cookies` 表：`127.0.0.1 / dsh-auth-<token>` | ❌ 只是本地 Host 的 bearer token |
| DeepSeek 平台账号 | `session.fromPartition("persist:dsh-platform-<sha256(origin,userId)>")` | ❌ 见下 |
| chat.deepseek.com | **当前不存在** | — |

平台账号配置默认值（`dsh-deepseek-account-platform/lib/index.js:482`）：

```js
platformOrigin:  "https://platform.deepseek.com"
inferenceOrigin: "https://api.deepseek.com"
// 接口族：`${origin}/auth-api/v0/dsh/${method}`
```

即 dsh 的 DeepSeek 账号是**平台侧 dsh 专用凭据**（`/auth-api/v0/dsh/*`），
与消费端 chat.deepseek.com 的 `ds_session_id` 会话**不是同一套**。

**结论：不存在可"共享"的既有 chat 登录态。** 可行且唯一稳妥的做法是——
在 webview 的持久化 partition 里登录一次，之后跨会话复用
（这正是桌面版 `DesktopPlatformView` 对自己平台页采用的做法：
`persist:dsh-platform-<sha256(origin,userId)>`）。

## 5. 三条路线

| 路线 | 嵌入 chat | 登录态 | 代价 |
| --- | --- | --- | --- |
| **A 纯插件 + 官方桌面版** | ❌ 被 lease 门禁挡住 | — | 需官方壳配合（新增 lease 的插件通道），不 fork 做不到 |
| **B 独立 Electron 壳** | ✅ webview 全自主 | ✅ 自持持久化 partition | 新起一个桌面应用；dsh UI 经 127.0.0.1 + `dsh-auth` cookie 接入 |
| **C 复用官方桌面版 PlatformView** | ⚠️ 限 `platformOrigin` 单源 | ⚠️ 平台凭据，非 chat 会话 | 要拿到 `deepseekAccount` 凭据并改 origin/头部注入 |

## 6. 建议

走 **B**：本仓库已有 `dsh-dock`（Tauri 壳）的同类落地经验，Electron 版壳可以
完全自主地：加载 dsh Web UI（用桌面版同一份 `dsh-auth-<token>` cookie 实现
"共享 dsh 登录态"）+ 并排挂一个 chat.deepseek.com webview（`persist:` partition
持久化 chat 登录）+ UA 归一化消除风控弹窗。

若坚持「装进官方 dsh 桌面版、由插件提供界面」，则必须先推动官方壳开放
**插件可申请的 webview lease 通道**（`dsh-desktop` 侧 ~20 行改动 + 一个
`dsh-api-*` 插件服务）。这属于上游协作，不是本仓库单方面能完成的。
