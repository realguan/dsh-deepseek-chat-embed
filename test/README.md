# test/

三层验证。**入口契约层不需要 Electron**，是改插件时的第一道门：

```bash
# 0. 语法 + 打包 + 两个入口的落位/行为契约（jsdom + 真实 React，驱动 dist 产物）
npm run check && npm run test:entries

# 1. 桌面壳租约回归（需 Electron；验证真实 <webview> 握手）
ELECTRON=/path/to/electron
"$ELECTRON" test/harness

# 2. 真实 dsh Web UI（需先起一个装了本插件的 Host）
#    见 test/live/main.cjs 顶部说明，通过 LIVE_URL 传入带 token 的地址
LIVE_URL='http://127.0.0.1:3080/?token=…' "$ELECTRON" test/live
```

## `entries/`

两个入口的契约，全部由 `dist/` 里真正被打包的产物驱动：注册了哪些席位（且**不注册**
任何会话顶栏席位）、右侧栏标签类型声明、常驻按钮在右栏展开/收起/新会话三种状态下的落位、
点击是打开标签还是收起右栏、标签体在可见/切走时对聊天 surface 的接管与让位。
详见 `entries/verify.mjs` 顶部的说明。

## `harness/`

桌面壳租约门禁的**忠实复刻**（逐行对应 `@deepseek-ai/dsh-desktop` 0.2.0-rc.2
的 `app.asar/lib/main.js` 里 `DesktopBrowserGuests.bind()`），加上一个只实现了
`__ModuleLoader__` 与 `react` 模块表的最小宿主。

它一次跑完这些断言：

| 断言 | 为什么 |
| --- | --- |
| bundle 以正确 `id` 装载 | 工厂协议写错会静默不注册 |
| `apply()` 不抛错 | 覆盖 Slot 契约的形状错误 |
| `ctx.inject(['slots'])` 被用上 | 用 `ctx.get('slots')` 会静默拿不到服务 |
| `register` 收到**两参数**、slot key 在 `options.name` | 三参数写法会当场抛错 |
| 样式注入 | 覆盖 `<style>` + `ctx.effect` 的生命周期 |
| 租约通过壳的校验并被放行 | 三个条件（src / partition / lease）缺一不可 |
| 导航抵达 `chat.deepseek.com` | `loadURL`/`src` 对租约 guest 无效，必须验证用的是 `executeJavaScript` |
| 无「使用环境异常」弹窗且 UA 已归一 | UA 没设对会触发风控 |
| lease 可释放 | 释放失败会漏掉 guest 进程 |

壳升级后必须重新转写 `harness/main.cjs` 里的 `BrowserGuests`。

**已知缺口（2026-10-10）**：`index.html` 的 `realRender` 断言仍指向已删除的
`[ DSH | DeepSeek ]` 胶囊（`.dsce-switch`），因此该段现在只报告 `switcherRendered:false`
后提前返回；租约握手、导航、UA 等断言不受影响。入口相关的断言已迁到 `test/entries/`。

## `live/`

把插件放进**真实 dsh Web 客户端**（真的 Slot 树、真的会话头部）。
需要另行准备一个装了本插件的 profile 与带 token 的 URL。

**已知缺口**：它尚未能自动在 UI 里创建出一个会话，因此依赖会话槽位的断言
通常为 `false`。新设计的常驻按钮挂在 `shell.overlay`（帧级浮层，`data-shell-overlay`），
只要页面里有会话头部就能测到；装好后请按 README 手动看一眼两个入口。
