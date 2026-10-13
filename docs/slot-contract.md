# dsh 客户端插件 Slot 契约（可照抄）

调研日期：2026-10-08 ｜ 目标：给 `dsh-deepseek-chat-embed` 提供**逐字可抄**的 Slot 注册 / props / 自渲染契约。

> **先纠正一个前提**：`ctx.slots.register(slotName, { id, order, label }, Component)` 这个
> **三参数形式不存在**。真实签名是 `ctx.slots.register(options, Component)`，
> 目标 slot key 在 `options.name` 里。`{ id, order, label }` 是 `options` 的一部分，
> 且**只有 list slot 才需要 `id`**，single slot 连 `id` 都不认。
> 详见 §1、§2。

---

## 0. 证据来源与路径约定

下文用两个简写（**所有引用行号都是这两个前缀下的真实行号**）：

| 简写 | 展开 |
| --- | --- |
| `$RT` | `~/Library/Application Support/io.github.realguan.dsh-dock/engines/dsh-runtime/node_modules/@deepseek-ai` |
| `$REPO` | `~/git/dsh-plugin-hub` |

`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是**指向 `$RT` 的符号链接**
（已用 `readlink` 验证：`dsh-client-ui-renderer`、`dsh-cordis-client-runner`、
`dsh-client-ui-jobs`、`dsh-client-ui-sidebar-right`、`dsh-client-ui-layout`、
`dsh-client-ui-session`、`dsh-client-ui-conversation` 全部是 symlink）。
注意 **`dsh-client-ui-slots` 不在 profile 的符号链接表里**，只在 `$RT` 下真实存在，
所以 §1 对它的引用一律走 `$RT`。

本次调研**没有**跑构建、没有装依赖、没有动 `src/`。所有结论来自**已发布产物的源码** +
**`dsh-cordis-client-runner` 内置的 Slot 目录**（那个目录就是 `cordis_inspect_query(platform=client,
provider=Slots, method=listSubTree)` 的数据源）。

### 0.1 两处关键"官方目录"原始输出

`$RT/dsh-cordis-client-runner/lib/client.js` 里内嵌了完整的 Slot 目录，每个 slot 都带
`registerOptions` / `standardProps` / `occupants` / `example`。这就是"官方给出的照抄范例"，
原始片段（**逐字**，`\n` 是 JSON 转义）：

**`conversation.session.header.actions`**（`$RT/dsh-cordis-client-runner/lib/client.js:3508-3564`）：

```js
key: "conversation.session.header.actions",
kind: "list",
scope: "session",
registerOptions: [
  { name: "id",    requirement: "required", type: "string" },
  { name: "order", requirement: "optional", type: "number" },
  { name: "label", requirement: "optional", type: "string | (() => string)" },
],
occupants: [
  "client-ui-agent-preset AgentPresetLabel id 'agent-preset'",
  "client-ui-jobs JobListAction id 'job-list'",
  "client-ui-subagent SubagentCatalogAction id 'subagent-catalog'",
  "experimental-client-ui-agent-team TeamAction id 'agent-team'"
],
replaceRisk: "none",
example: "return {\n  inject: ['slots'],\n  apply(ctx) {\n    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(\n      { name: 'conversation.session.header.actions', id: 'my-entry', order: 100, label: 'My entry' },\n      () => React.createElement('div', null, 'hello'),\n    ))\n  },\n}",
```

**`conversation.session.header.corner`**（同文件 `:3566-3600`）：

```js
key: "conversation.session.header.corner",
kind: "single",
scope: "session",
registerOptions: [],                                  // ← single 没有任何注册选项
occupants: ["client-ui-sidebar-right ExpandButton"],  // ← 已被占用！见 §2.2
replaceRisk: "shadows-shipped-ui",
example: "return {\n  inject: ['slots'],\n  apply(ctx) {\n    ctx.slots.inject('conversation.session.header.corner', () => ctx.slots.register(\n      { name: 'conversation.session.header.corner' },\n      () => React.createElement('div', null, 'hello'),\n    ))\n  },\n}",
```

---

## 1. `ctx.slots.register` 的精确签名

### 1.1 类型层：就是 `SlotCore['register']`，没有任何包装

`$RT/dsh-client-ui-renderer/lib/types/client/registry.d.ts:69-85`：

```ts
/**
 * The ordinary Slot registration API. The typed face IS the core's register
 * (both overloads reused verbatim — one authority, no structural copy …)
 * … it MUST stay a prototype method (never an instance arrow) …
 */
readonly register: SlotCore['register'];
```

`SlotRegistry['register']` 的**运行时实现**（`$RT/dsh-client-ui-renderer/lib/client.js:1788-1795`）：

```js
SlotRegistry.prototype.register = function register(rawOptions, component) {
  const options = rawOptions;
  return this.ctx.effect(() => this["_register"](options, component), "slots.register()");
};
SlotRegistry.prototype.registerFactory = function registerFactory(rawOptions, component) {
  const options = rawOptions;
  return this.ctx.effect(() => this["_registerFactory"](options, component), "slots.registerFactory()");
};
```

→ **两个位置参数**：`(options, component)`。**没有** slotName 这个独立参数。
→ 返回值 = **幂等 disposer**（`() => void`），并且已经挂在**调用方 fiber** 的 `ctx.effect` 上，
   插件 unload 会自动回收（`$RT/dsh-client-ui-renderer/lib/client.js:1591-1597`）。

### 1.2 options 的完整形状

`$RT/dsh-client-ui-slots/lib/types/index.d.ts:596-613`（`BaseOptions`）：

```ts
type BaseOptions<K, EntryKey, D, H, M, N> = {
  name: K;                       // 目标 slot key（贡献到哪个 slot）
  children?: D;                  // 子 slot 声明表 = 渲染授权 + 运行时 spec
  store?: H;                     // store 座位
  locale?: N;                    // 字典命名空间 → 组件 props 上多一个 t(...)
  registrant?: string;           // 诊断用署名
} & KindOptions<K, EntryKey, M>;
```

`$RT/dsh-client-ui-slots/lib/types/index.d.ts:560-583`（`KindOptions`，**按 kind 分支**）：

```ts
// keyed
{ key: EntryKey; priority?: number }
// list
{ id: string; order?: number; label?: SlotLabel; priority?: number }
// chain
{ select: ChainSelect<...>; priority?: number }
// single（及其它）
{ priority?: number }
```

`SlotLabel = string | (() => string)`（`index.d.ts:555`）——传 thunk 则每次投影重新求值，
可在**不重新注册**的情况下跟随语言切换。

### 1.3 运行时校验（load-time，fail loud）

`$RT/dsh-client-ui-slots/lib/index.js:163-190`：

```js
register(options, component) {
  const rec = this.records.get(options.name);
  if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
  ...
  switch (spec.kind) {
    case "single": { const occupant = rec.entries.find(e => (e.options.priority ?? 0) === priority);
                     if (occupant) throw new Error(`single slot "${options.name}" already has a registration ...`); break }
    case "keyed":  { if (options.key === void 0) throw new Error(`keyed slot "${options.name}" requires options.key`); ... }
    case "list":   { if (options.id  === void 0) throw new Error(`list slot "${options.name}" requires options.id`); ... }
    case "chain":  { if (options.select === void 0) throw new Error(`chain slot "${options.name}" requires options.select`); ... }
  }
  ...
}
```

三条硬规则：

1. **注册到未声明的 slot 直接抛错** → 所以对 dsh 自带 slot 必须用 `ctx.slots.inject(key, cb)`（§6.1）。
2. **list slot 缺 `id` 抛错**；**single slot 不接受 `id`**（传了也只是被忽略，不报错，但没意义）。
3. **同一 cell 同一 `priority` 重复注册抛错**。cell 的定义：single = slot 本身；
   keyed = 同 `key`；list = 同 `id`。默认 `priority = 0`，**升序、最小者渲染**
   （`$RT/dsh-client-ui-slots/lib/types/index.d.ts:769-775`）。

---

## 2. list slot vs single slot：`conversation.session.header.*` 逐条对照

### 2.1 两者都由 `client-ui-conversation` 声明

`$RT/dsh-client-ui-conversation/lib/client.js:23086-23118`（**原始**）：

```js
const registerSessionHeader = () => slots.register({
  name: "conversation.session.header",
  locale: NS,
  children: {
    "conversation.session.header.lineage":   { kind: "single", scope: "session" },
    "conversation.session.header.actions":   { kind: "list",   scope: "session" },
    "conversation.session.header.utilities": { kind: "list",   scope: "session" },
    "conversation.session.header.corner":    { kind: "single", scope: "session" },
  },
  store: conversationStore,
  ...
}, ConversationSessionHeader);
```

一处渲染（同文件 `:21327` / `:21335`）：

```js
children: renderSlot("conversation.session.header.actions", {})
...
children: renderSlot("conversation.session.header.corner", {})
```

→ 这两个 slot **只在选中 Session 且该 header 挂载时存在**（目录里 `declaredBy` 字段：
`"an entry in 'conversation.session.header' (client-ui-conversation), so it exists while that entry is mounted"`）。

### 2.2 差异表

| | `...header.actions` | `...header.corner` |
| --- | --- | --- |
| kind | **list** | **single** |
| scope | session | session |
| 必填选项 | **`id`（string，必填）** | 无 |
| 可选选项 | `order?: number`、`label?: string \| (() => string)` | 无 |
| 重复注册 | 新 `id` = **新增一格（可加性）** | 同一 cell，同 priority 抛错 |
| `replaceRisk` | `none` | `shadows-shipped-ui` |
| 已有占用者 | 4 个（见 §0.1） | **`client-ui-sidebar-right ExpandButton`** |
| 排序 | `order` 升序（`$RT/dsh-client-ui-renderer/lib/client.js:1178-1193`） | 不适用 |

**⚠️ corner 的坑（重要）**：它已被 `client-ui-sidebar-right` 占用——

`$RT/dsh-client-ui-sidebar-right/lib/client.js:9188-9193`（原文）：

```js
const disposeExpand = ctx.slots.inject("conversation.session.header.corner", () => ctx.slots.register({
  name: "conversation.session.header.corner",
  locale: NS,
  store,
  inject: () => ({ hooks: { shortcuts: ctx.shortcuts.catalog } })
}, ExpandButton));
```

它没写 `priority` → 默认 `0`。而**动态包**注册时 runner 会**强制覆盖** `priority`
为一个递减的负数（§5.2），负 < 0 = 更小 = **胜出** → 你放进 corner 就把
sidebar-right 的展开按钮**顶掉了**（该 entry 仍在 ledger 里，但 `entriesOfSlot` 只返回最低
priority 的那个，`$RT/dsh-client-ui-renderer/lib/client.js:1148-1151`）。

**结论：切换按钮请放 `conversation.session.header.actions`（list、`replaceRisk: none`、
可加性、带 `sessionId`）。`corner` 只有在"明确要替换掉 sidebar-right 展开按钮"时才用。**

### 2.3 可直接照抄：注册进 `...header.actions`

```js
ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
  name: "conversation.session.header.actions",
  id: "deepseek-chat-embed.toggle",   // 必须：自己独有的 id，不与 shipped 的 4 个撞
  order: 100,                          // 可省，默认 0（升序排）
  label: "DeepSeek 聊天",              // 可省；只在该 slot 的 owner 需要投影文字时才有用
}, ToggleButton));
```

同仓库里 dsh 自带插件的**完全同形**写法（`$RT/dsh-client-ui-jobs/lib/client.js:610-621`）：

```js
ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
  name: "conversation.session.header.actions",
  id: "job-list",
  order: 20,
  locale: "job",
  inject: () => ({
    hooks: { jobs: ctx.jobs.state },
    watchRows: (sessionId) => ctx.jobs.watchRows(sessionId),
    ...
  })
}, JobListAction));
```

### 2.4 可直接照抄：注册进 `...header.corner`（会顶掉展开按钮）

```js
ctx.slots.inject("conversation.session.header.corner", () => ctx.slots.register({
  name: "conversation.session.header.corner",
  // 没有 id / order / label —— single slot 不接受这些
}, CornerButton));
```

---

## 3. 注册组件收到的 props

### 3.1 组装规则（运行时原文）

`$RT/dsh-client-ui-renderer/lib/client.js:747-769`：

```js
/**
 * One rendered entry: standard kit + cached entry inject + common slot inject
 * + owner props (owner wins). The shares are erased at this render boundary…
 */
function ContextualEntry({ slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext }) {
  ...
  return (0, react_jsx_runtime.jsx)(Comp, {
    ...kit,             // ① standard kit（含 renderFactorySlot / t / useStore / actions / renderSlot / SessionProvider）
    ...injected,        // ② 你自己 inject() 的返回
    ...slotInjected.props,
    ...contextual,
    ...ownerProps       // ③ owner 在 renderSlot(key, owner) 调用点传的
  });
}
```

**所以 props = 三份 share 的浅合并，`ownerProps` 优先级最高。** `kit` 的内容由
`standardKit()`（`$RT/dsh-client-ui-renderer/lib/client.js:715-746`）决定：

| props key | 何时出现 | 出处 |
| --- | --- | --- |
| scope 标准 props | 总是（按 scope 决定哪一套） | `:715-718` |
| `renderFactorySlot` | **总是** | `:719` |
| `t` | 声明了 `locale` 时 | `:721-725` |
| `useStore` / `actions` | 声明了 `store` 时 | `:727-731` |
| `renderSlot` | **声明了 `children` 时** | `:732-733` |
| `renderSlotChain` | `children` 里有 chain 时 | `:734` |
| `SessionProvider` | `children` 里有非 root scope 时 | `:735-739` |

### 3.2 session scope 的标准 props —— `sessionId` 是**普通 prop**，能直接拿到 ✅

`$RT/dsh-client-ui-session/lib/types/client/index.d.ts:67-93`（`declare module` 合并）：

```ts
interface GlobalStandardProps {
  useSessions: UseSessions;
  useSessionStatus: UseSessionStatus;
  useSessionRetainInfo: UseSessionRetainInfo;
}
interface SessionStandardProps {
  useSession: SessionSnapshotSelector;   // 当前 Session 生命周期/控制状态
  sessionId: SessionId;                  // ← 当前 Session 标识（普通值，不是 hook）
  useProjection: UseProjection;
}
```

`sessionId` 确实是**普通属性**而不是 hook：session scope 的 source descriptor 里
`props: ["sessionId"]` + `resolve: binding => ({ props: { sessionId: binding.sessionId } })`
（`$RT/dsh-client-ui-session/lib/client.js:756-763`）。`materializeStandardBinding`
把 `binding.props` 逐字展开（`$RT/dsh-client-ui-renderer/lib/client.js:646-657`），
所以到了组件里就是 `props.sessionId`。

`client-ui-conversation` 再往 session scope 叠加（`$RT/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:332-344`）：

```ts
interface SessionStandardProps {
  useConversation: UseConversation;
  useInput: SnapshotSelectorHook<InputState>;
  inputActions: InputActions;
}
```

`client-ui-chat` 又叠了 `useChat` / `useTrajectory` 等。

### 3.3 `conversation.session.header.actions` 的实际 props 清单

runner 目录里对**这一个 slot** 的实况枚举（`$RT/dsh-cordis-client-runner/lib/client.js:3535-3551`）：

```
standardProps: [
  useResource, useWorkspaces, usePanelInfo,
  useSessions, useSessionStatus, useSessionRetainInfo,
  useChat, useConversation, useInput, inputActions,
  useSession, sessionId, useProjection, useTrajectory
]
ownerProps: [ ConversationHeaderActionOwnerProps ]
```

其中 owner props 的定义（`slots.d.ts`，runner 目录 `:3533` 原文）：

```ts
/** Header actions derive their state from standard Session props. */
export interface ConversationHeaderActionOwnerProps {
  /** Marker field: entries receive no owner-specific values. */
  children?: never;
}
```

→ **owner 什么都没传**（owner 侧的调用点是 `renderSlot("conversation.session.header.actions", {})`，
§2.1）。你要的数据全部来自上面的 `standardProps`。

### 3.4 对照：`shell.overlay`（root scope）拿不到 sessionId

runner 目录 `:4928-4936` 枚举的 `shell.overlay` standardProps：

```
useResource, useWorkspaces, usePanelInfo,
useSessions, useSessionStatus, useSessionRetainInfo
```

**没有 `sessionId`**（root scope 的 std props 里就没有它）。
`conversation.session.header.corner` 的清单与 §3.3 **完全一致**（同文件 `:3575-3591`）。

### 3.5 props 速查表（写代码时按这个抄）

```js
function ToggleButton(props) {
  // scope: session
  props.sessionId            // SessionId（普通值）✅ 当前会话
  props.useSession           // selector hook
  props.useConversation      // selector hook
  props.useInput             // selector hook
  props.useChat / useTrajectory / useProjection / useResource / usePanelInfo
  props.useSessions / useSessionStatus / useSessionRetainInfo / useWorkspaces
  props.inputActions         // 当前会话的输入机动作
  props.renderFactorySlot    // 总是有
  props.renderSlot           // 只在 options.children 非空时有
  props.t                    // 只在 options.locale 时有
  // props.<你的 inject() 返回值>   ← 见 §6
}
```

**React hooks 允许用**（组件就是普通 React 函数组件，`React` 来自闭包符号，§5）。
`React.useSyncExternalStore` 可用——runtime 自己就在用
（`$RT/dsh-client-ui-renderer/lib/client.js:693, 1097, 1210`）。

---

## 4. 在自己的插件里注册并渲染一个自定义 slot

这是 task 的第 3 问，答案是**三步**，而且"渲染"的返回值是 **ReactElement（ReactNode）**，
不是回调、不是 DOM 挂载。

### 4.1 机制

1. **声明即授权**：`register` 的 `children` 表同时是"声明 + 渲染授权 + 运行时 spec"
   （`$RT/dsh-client-ui-slots/lib/types/index.d.ts:152-160`：
   *"Declaring is claiming: the registering entry becomes the only entry allowed to render these keys"*）。
2. **父组件拿到 `renderSlot` prop**，**调用它返回一个 ReactElement**：
   `$RT/dsh-client-ui-renderer/lib/client.js:326-343`：

   ```js
   function boundRenderSlot(host, entry) {
     ...
     binding = (key, owner, opts) => {
       if (!host.isLive(entry)) throw new StaleAuthorizationError(`renderSlot('${key}') from a disposed registration`);
       const declared = entry.children?.[key];
       if (declared === void 0) throw new SlotOwnershipError(`slot '${key}' is not declared by this entry's children`);
       if (declared.kind === "chain") throw new SlotOwnershipError(`slot '${key}' is declared 'chain' — use renderSlotChain`);
       return jsx(SlotOutlet, { slotKey: key, ownerProps: owner, opts });   // ← 返回 ReactElement
     };
     ...
   }
   ```

   所以用法是**把这个返回值塞进你自己的 `createElement` children 里**：

   ```js
   props.renderSlot("myplugin.panel", {})
   ```
3. **子组件另外注册**：`ctx.slots.inject("myplugin.panel", () => ctx.slots.register({ name: "myplugin.panel", ... }, Child))`。
4. **disposer 级联**：父 entry 的 disposer 会**递归塌掉所有已声明的子 slot**
   （`$RT/dsh-client-ui-slots/lib/types/index.d.ts:777-780`：
   *"the disposer removes the contribution AND collapses every declared child slot (child entries clear recursively; their stale disposers become no-ops)"*）。
5. 父组件**必须**消费 `renderSlot`——类型层有 `RendersCheck` 强制
   （`$RT/dsh-client-ui-slots/lib/types/index.d.ts:591-595`）。

### 4.2 最小可用示例（父 entry + 自渲染子 slot）

```js
// ── 父：注册进 shell.overlay，并声明一个只属于本插件的子 slot ────────────────
ctx.slots.inject("shell.overlay", () => ctx.slots.register({
  name: "shell.overlay",
  id: "deepseek-chat-embed.overlay",
  order: 1000,
  children: {
    // 名字自己起（全局唯一即可），scope 按需要选 root / session
    "deepseek-chat-embed.panel": { kind: "single", scope: "root" },
  },
}, OverlayHost));

// ── 子：注册进刚声明的子 slot ────────────────────────────────────────────
ctx.slots.inject("deepseek-chat-embed.panel", () => ctx.slots.register({
  name: "deepseek-chat-embed.panel",
}, ChatPanel));

// ── 父组件：把 renderSlot 的返回值放进 React 树 ───────────────────────────
function OverlayHost(props) {
  if (!isOpen()) return null;                        // 关闭时不占位
  return React.createElement("div", {
    style: { position: "fixed", inset: 0, zIndex: 100, pointerEvents: "auto" },
  }, props.renderSlot("deepseek-chat-embed.panel", {}));   // ← ReactElement
}

function ChatPanel(props) {
  return React.createElement("webview", { src: "https://chat.deepseek.com/" });
}
```

> `single` / `list` / `root` / `session` 都只是 `children` 表里的字面量，
> 形状就是 `{ kind, scope, inject? }`（`$RT/dsh-client-ui-slots/lib/types/index.d.ts:140-151`）。
> `list` 子 slot 注册时要给 `id`，`single` 不用。

### 4.3 为什么"父 `shell.overlay` + 子 slot"是推荐切法

- `shell.overlay` 是 `list` + `scope: root` + `replaceRisk: "none"` → **纯可加**，不顶任何现有 UI。
- 浮层本体（全屏、带 `<webview>`）放在自己声明的**子 slot** 里，
  父组件只负责"开/关"与 `renderSlot`，职责干净、卸载时一起塌掉。

---

## 5. 动态客户端包（`cordis_define` 的 `code.client`）里怎么写 UI

### 5.1 闭包符号表 —— 只有这 6 个是真的

`$RT/dsh-cordis-client-runner/lib/client.js:152-187`（**源码原文，逐字**）：

```js
const parameters = [
  "React",
  "console",
  "styles",
  "host",
  "harness",
  ...Object.keys(traps),   // setTimeout / setInterval / clearTimeout / clearInterval / fetch / require
  "process",
  "Buffer"
];
closure = new Function(...parameters, `return (async () => {\n${clientCode}\n})()`);
const returned = await closure(react, taggedConsole(...), styles, { call: ... }, harnessTrap(), ...Object.values(traps), void 0, void 0);
```

| 符号 | 实际是什么 | 证据 |
| --- | --- | --- |
| `React` | **完整 react 命名空间**（`React.createElement` / `React.useState` / `React.useSyncExternalStore` …） | `:171` 传入 `react`；renderer 自己在用 `react.useSyncExternalStore` |
| `console` | 带 `[cordis:<id>]` 前缀的 console；`error` 会额外进 load report | `:118-133` |
| `styles` | `{ insert(css) → disposer, count, dispose() }`；`data-dyn=<pluginId>` 标记，卸载自动清除 | `:72-105` |
| `host` | `{ call(method, args) }` — 调回 host half | `:173-181` |
| `harness` | Proxy，**任何访问都抛错**（它只属于 host half） | `:66-70` |
| `setTimeout/setInterval/clearTimeout/clearInterval` | **教学性抛错**，提示改用 `inject: ['timer']` | `:41, 50-53` |
| `fetch` | **教学性抛错**，提示走 `harness.handle` + `host.call` | `:54` |
| `require` | **教学性抛错**（"React arrives as the `React` closure symbol"） | `:55` |
| `process` / `Buffer` | `undefined`（显式传入） | `:181` |

**`ctx` 不是闭包符号**——它是 `apply(ctx)` 的形参，由 Cordis 传入。
**`document` / `window` 没有被 shadow**（trap 表里没有），动态包可以碰 DOM
（`$REPO/dsh-mermaid-preview/src/client.js:19-20` 的注释明确写了这一点）。

### 5.2 动态包的 `ctx.slots` 被包了一层 Proxy

`$RT/dsh-cordis-client-runner/lib/client.js:250-290`（**原文摘录**）：

```js
function guardedSlots(slots, env) {
  return new Proxy(slots, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (prop !== "register" && prop !== "registerFactory") { ... 透传 ... }
    return (rawOptions, component) => {
      if (typeof rawOptions !== "object" || rawOptions === null) return rejectGuard(env, "slots.register(options, component) needs an options object with a `name`");
      const options = { ...rawOptions };
      const slot = options.name;
      if (typeof slot !== "string" || slot.length === 0) return rejectGuard(env, `slots.${prop} options need a string \`name\``);
      ...
      const spec = slots.spec(slot);
      let priority = options.priority;
      if (spec === void 0 || spec.kind !== "chain") {
        priority = env.allocatePriority();     // ← 强制覆盖 priority！
        options.priority = priority;
      }
      const dispose = Reflect.get(target, "register", target).call(target, options, component);
      env.ledger.push({ slot, priority });
      env.claim(component);
      return dispose;
    };
  } });
}
```

`allocatePriority` 的定义（`:393, 615`）：

```js
nextPriority = 0;                              // "A later registration receives a lower priority."
allocatePriority: () => --this.nextPriority,   // → -1, -2, -3 …
```

**三条后果，务必记住：**

1. **你自己写的 `options.priority` 会被丢掉**（非 chain slot）。动态包拿到的永远是递减负数。
2. 负数 = 升序最小 = **动态包总是"胜出方"**。放进 single slot 就**顶掉**原占用者（§2.2 的 corner 就是这个坑）；
   放进 list slot 的**新 `id`** 则是新增一格（不冲突，因为 cell 由 `id` 区分）。
3. **同一个 `id` 重复注册不会抛错**（priority 不同），旧 entry 会在 unload 时被 dispose。

> 这条也回答了 task 的第 5 问的一半：**`ctx.slots.register` 不是 `SlotCore['register']` 的直接暴露**——
> 类型层是（`registry.d.ts:85`），但**动态包**的 `ctx.slots` 外面套了这层 Proxy
> （自动 priority + ledger + 组件归属）；`ctx.slots.inject`/`spec`/`entries` 等只是透传。

### 5.3 ⚠️ 动态包里**没有** `ctx.effect` 包 `styles` 的写法差异

- **动态包**：用闭包符号 `styles.insert(css)`（`$RT/dsh-cordis-client-runner/lib/client.js:84-95`），
  返回一个 disposer，卸载时 runner 还会 `styles.dispose()` 兜底（`:541, 641`）。
- **native bundle 插件**（`dsh plugin --profile web add`）：**没有** `styles` 符号，
  得像 `$REPO/dsh-mermaid-preview/src/client.js:49-95` 那样
  `ctx.effect(() => { const s = document.createElement('style'); …; return () => s.remove() })`。
  该文件 `:46-48` 的注释已经把这点写明："The browser client runtime exposes no `ctx.styles` service"。

两种写法**不要混**。

### 5.4 可直接运行的最小动态插件（本插件的骨架）

`cordis_define` 的 `code.client` = **一个 async 函数体**，必须 `return` 插件
（`$RT/dsh-cordis-client-runner/lib/client.js:182-185` 的报错文案给出了两种合法形状）。

```js
// ← 这是 code.client 的全部内容（函数体，不是模块）
const KEY = 'deepseek-chat-embed'
let open = false
const listeners = new Set()
const isOpen = () => open
const setOpen = (next) => { open = next; for (const l of [...listeners]) l() }
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l) }

// 返回值是一个 disposer；不管它也行，卸载时 runner 会 styles.dispose() 兜底
styles.insert(`
  .dsc-embed-toggle { font: inherit; font-size: 12px; padding: 2px 10px; cursor: pointer;
    color: var(--dsw-alias-label-secondary); background: transparent;
    border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
  .dsc-embed-layer { position: fixed; inset: 0; z-index: 100; pointer-events: auto;
    background: var(--dsw-alias-bg-base); display: flex; flex-direction: column; }
  .dsc-embed-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex: none; }
  .dsc-embed-body { flex: 1; min-height: 0; display: block; width: 100%; border: 0; }
`)

function useOpen() {
  return React.useSyncExternalStore(subscribe, isOpen, isOpen)
}

function ToggleButton(props) {
  const opened = useOpen()
  return React.createElement('button', {
    type: 'button',
    className: 'dsc-embed-toggle',
    onClick: () => setOpen(!opened),
  }, opened ? 'DSH 聊天' : 'DeepSeek 聊天')
}

function OverlayHost(props) {
  const opened = useOpen()
  if (!opened) return null
  return React.createElement('div', { className: 'dsc-embed-layer' },
    React.createElement('div', { className: 'dsc-embed-bar' },
      React.createElement('span', null, 'DeepSeek 聊天'),
      React.createElement('button', { type: 'button', className: 'dsc-embed-toggle',
        onClick: () => setOpen(false) }, '返回 DSH')),
    React.createElement('div', { className: 'dsc-embed-body' },
      props.renderSlot(KEY + '.panel', {})))
}

function ChatPanel() {
  return React.createElement('webview', {
    src: 'https://chat.deepseek.com/',
    className: 'dsc-embed-body',
    allowpopups: 'true',
  })
}

return {
  name: 'dsh-deepseek-chat-embed',
  inject: ['slots'],                        // ← 必须：否则 ctx.slots 不可见
  apply(ctx) {
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'deepseek-chat-embed.toggle',
      order: 100,
      label: 'DeepSeek 聊天',
    }, ToggleButton))

    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'deepseek-chat-embed.overlay',
      order: 1000,
      children: { [KEY + '.panel']: { kind: 'single', scope: 'root' } },
    }, OverlayHost))

    ctx.slots.inject(KEY + '.panel', () => ctx.slots.register({
      name: KEY + '.panel',
    }, ChatPanel))
  },
}
```

要点逐条：

- **无 JSX、无 TS**：`new Function` 直接 eval，语法错误有专门报错
  （`$RT/dsh-cordis-client-runner/lib/client.js:166-170`：
  *"The browser half is plain JavaScript (no JSX, no TypeScript); build elements with React.createElement."*）。
- **必须 `return` 插件**；`undefined` 会报 "did you forget `return`?"
  （`:182-185`）。
- `inject: ['slots']` 是**必需**的——guard 只暴露插件在 `inject` 里声明过的服务
  （`:332`：*"any service your returned plugin declared in inject (slots and theme are the usual UI seats)"*）。
- `styles.insert` 的返回值可以不管（卸载自动清），但要早点拿到句柄以便手动清也可以。
- 两个组件共享状态：它们在**同一个包闭包**里，闭包变量天然共享
  （runner 明确保证每个包的 browser half 在**独立闭包**中求值，`:407-411`）。
  用 `useSyncExternalStore` 通知 React 重渲染（runtime 自己就这么做）。

---

## 6. `inject` vs `registerFactory`，以及 disposer 语义

### 6.1 `ctx.slots.inject(key, callback)`

签名（`$RT/dsh-client-ui-renderer/lib/types/client/registry.d.ts:99-116`，目录 `:1384`）：

```ts
inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void
```

语义（`$RT/dsh-client-ui-renderer/lib/client.js:1328-1402` 的 doc 与实现）：

- **"为 slot 的每一个声明生命周期装一个 effect"**：声明已存在 → **同步立即执行**；
  还不存在 → 等到**声明它的那次 `register()` 提交之后**在同一调用里执行。
- 声明塌掉 → effect 被 dispose；**之后再声明会再跑一次**。
- callback 返回 **单个 disposer，或一个 disposer 的可迭代**（生成器 `function* () { yield ... }` 是
  shipped 代码里的常见写法，见 `$RT/dsh-client-ui-chat/lib/client.js:13244-13259`）。
- 归属**调用方 fiber**，插件卸载会取消等待并移除已装 effect。
- 返回**幂等 disposer**。

**什么时候必须用 `inject`**：`register` 到**别人声明的** slot 时（dsh 自带 slot 全是这种）。
因为 `SlotCore.register` 对未声明 slot **直接抛错**（§1.3 第 1 条），而
`conversation.session.header.actions` 的声明只在 `client-ui-conversation` 的 entry 挂载期间存在。
shipped 代码**无一例外**都是 `slots.inject(<foreign key>, () => slots.register(...))`。

**什么时候可以直接 `register`**：注册到**本插件自己刚声明的**子 slot 时
（上例第三段 `ctx.slots.inject(KEY + '.panel', ...)` 其实也可以直接 register，
但用 `inject` 更稳，且和上游风格一致）。

### 6.2 `registerFactory` —— 完全不同的东西

签名 `registerFactory: RegisterFactory`（`registry.d.ts:95`），options 形状见
`$RT/dsh-cordis-client-runner/lib/client.js:2042`：

```ts
export type RegisterFactoryOptions<F> = {
  name: F;
  scope: FactoryDefOf<F>['scope'];
  children?: ...; store?: ...; inject?: ...; locale?: ...;
  slots?: RuntimeFactorySlots<F>;    // ← 调用方选择的局部 Component
};
```

| | `register` | `registerFactory` |
| --- | --- | --- |
| 解决什么 | 向**父 slot** 贡献一个 entry | 定义一个**可复用装配体**，供无关父组件各自渲染 |
| 谁渲染 | 父 slot 的 owner（`renderSlot`） | 任意调用方通过 `props.renderFactorySlot(name, props, { slots })` |
| 局部 Component | 无 | `slots` 选项按 occurrence 选一个 Component，定义侧用 `useFactorySlot(name, fallback)` 读 |
| 声明 | entry 的 `children` 表 | Factory 的 `children`（仍是普通全局 Slot）/ `slots`（局部，不占全局 key） |
| 本次需求 | ✅ **用这个** | ❌ 不需要（本插件只有一个宿主） |

出处：`$RT/dsh-client-ui-slots/README.md:30-34`（"Reusable Component Factories" 一节）
+ `$RT/dsh-client-ui-slots/lib/types/index.d.ts:387-410`。

### 6.3 disposer 语义汇总

| 对象 | 返回 | 幂等？ | 卸载时 |
| --- | --- | --- | --- |
| `slots.register(...)` | `() => void` | ✅（`disposed` 旗标，`client.js:1591-1597`） | 自动（挂在 `ctx.effect`，且**级联塌掉子 slot**） |
| `slots.registerFactory(...)` | `() => void` | ✅（`:1613-1620`） | 自动 |
| `slots.inject(...)` | `() => void` | ✅（`stop()` 有 `stopped` 旗标，`:1350-1358`） | 自动 |
| `styles.insert(css)`（动态包） | `() => void` | 重复调用安全（`tag.remove()` 对已移除节点是 no-op） | 自动（`styles.dispose()` 兜底） |

→ **插件里可以不保存 disposer**：所有注册都已经绑定到插件自己的 fiber。
（`$RT/dsh-cordis-client-runner/lib/client.js:291-298` 对 theme 有同样的说明：*"register hangs its own cleanup"*。）

---

## 7. `shell.overlay`：放全屏浮层的正确座位

目录原文（`$RT/dsh-cordis-client-runner/lib/client.js:4904-4905`）：

> *"Frame-wide floating layer, above every column and outside their scroll containers.
> Deliberately generic and unowned by any feature … **The layer itself is click-through —
> entries opt back into pointer events** — so an occupant never blocks the app underneath."*

| 字段 | 值 | 出处 |
| --- | --- | --- |
| kind | `list` | `:4902` |
| scope | `root` | `:4903` |
| 必填 | `id` | `:4906-4912` |
| 可选 | `order`、`label` | `:4913-4924` |
| `replaceRisk` | **`none`**（纯可加） | `:4953` |
| 现有占用者 | 10 个（chat / sidebar-right / schedule / …） | `:4941-4952` |
| 谁声明 | `client-ui-layout` 的 root entry | `:4940` |

容器与 pointer-events（`$RT/dsh-client-ui-layout/lib/client.js`）：

- `:73` 的 CSS 原文：`.overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}`，
  紧跟 `.overlayLayer>*{pointer-events:auto}`。
- `:313` `const overlays = useMemo(() => renderSlot("shell.overlay", {}), [renderSlot])`
- `:349-353` `React.createElement("div", { className: overlayLayer, "data-shell-overlay": true, children: overlays })`

→ **`z-index: 20` 的绝对定位层，覆盖整个 frame**；直接子元素自动拿回 `pointer-events: auto`。
SlotOutlet 的 anchor 是 `style: { display: "contents" }`
（`$RT/dsh-client-ui-renderer/lib/client.js:1094, 1099-1103`），不产生盒子，
所以**你组件的最外层元素就是 `.overlayLayer` 的直接子元素** → 自动可点。
（要更保险就在自己的 CSS 里再写一次 `pointer-events: auto`，上例已写。）

**注意 `shell.overlay` 是 root scope，props 里没有 `sessionId`**（§3.4），
开关状态必须走插件闭包（§5.4）。

---

## 8. 未验证项 / 风险清单

标注 **【未验证】** 的条目**没有**被端到端跑通，请以实测为准：

1. **【未验证】本次没有做任何真实注册**。按任务边界，我没有跑构建、没有装依赖、
   没有 load 插件；`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree)`
   与 `provider=Builtin, method=listBuiltins` 在撰写时**连续超时**
   （`Client inspect query … timed out after 10000ms`，需重新连接 Harness 页面）。
   本文所有 slot 事实来自**落盘的历史 inspect 输出**
   （`/var/folders/3v/_t00r02x3q96px3q3ywncr_40000gn/T/dsh-spill-ALSXJU/session-b02b6a0a068c/37990dc7f36f-cordis_inspect_query.txt`，
   2026-10-08 15:39，同一个 session）+ **`dsh-cordis-client-runner` 内置 Slot 目录源码**
   （与 inspect 同源）+ **已发布包源码**。三者互相一致。
2. **【未验证】`<webview>` 在官方 dsh 桌面版里会被 lease 门禁拒绝**。这与 slot 契约无关，
   但会直接决定本插件能否真的显示聊天页：见
   `$REPO/deepseek-chat-embed/docs/feasibility.md:54-71`（`will-attach-webview` 的 lease 检查）
   与 `:68-71`（动态包拿不到 `window.dshDesktop`）。Slot 契约本身不受影响——
   **按钮和浮层一定能渲染，`<webview>` 能否 attach 取决于壳侧。**
3. **【未验证，仅源码推断】`conversation.session.header.corner` 的 `ExpandButton` 占位是常态**。
   我读的是 shipped 源码（`$RT/dsh-client-ui-sidebar-right/lib/client.js:9188-9193`），
   没有实测"运行时有 Session 时 corner 里到底是什么"。结论"你会顶掉它"是按
   `priority: -N < 0` + `entriesOfSlot` 取最低者推出来的（`$RT/dsh-client-ui-renderer/lib/client.js:1148-1151`），
   机制确定，现象未实测。
4. **【未验证】`React` 的确切版本号**。`$RT/.../dsh-client-ui-renderer/package.json` 的
   `dependencies` 为空、`react` 不在 engine 顶层 `node_modules`——React 是被打进 client bundle 的。
   但 `React.useSyncExternalStore` **可用**这点是确定的：runtime 自己在用
   （`$RT/dsh-client-ui-renderer/lib/client.js:693, 1097, 1210`）。这只是 React ≥18 的下界。
5. **【未验证】`label` 在 `conversation.session.header.actions` 里是否真的被用到**。
   目录把 `label` 列为可选注册项，但 owner 的渲染点（`$RT/dsh-client-ui-conversation/lib/client.js:21327`）
   是 `renderSlot(..., {})`，我**没有**逐行确认 owner 是否投影了 `label`。
   **对切换按钮完全可以不传 `label`**，不影响功能。
6. **【未验证】native bundle 与动态包两条交付路线的取舍**。本文 §5.4 的示例是**动态包**
   （`cordis_define` 的 `code.client`）形态。若走 `dsh plugin --profile web add`，
   打包方式见 `$REPO/dsh-mermaid-preview/scripts/build-dynamic.mjs:35`（动态载荷：`export default` → `return`）
   与 `scripts/build-client-bundle.mjs:73-80`（native：`window.__ModuleLoader__.load({ id, factory })` 包装），
   `package.json:13-23` 的 `dsh.bundle.patch` / `dsh.client` 字段。两条路线的 UI 代码几乎相同，
   但 **`styles` 符号只在动态包里有**（§5.3）。

---

## 9. 一页速查

```js
// 1) 注册进 dsh 自带 slot —— 必须 inject 包住，options.name 是 slot key
ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
  name: "conversation.session.header.actions",   // list → id 必填
  id: "myplugin.toggle",
  order: 100,
  label: "DeepSeek 聊天",
}, ToggleButton));                                // props.sessionId 可用

// 2) 全屏浮层 —— shell.overlay 是 list + root scope + replaceRisk none
ctx.slots.inject("shell.overlay", () => ctx.slots.register({
  name: "shell.overlay",
  id: "myplugin.overlay",
  order: 1000,
  children: { "myplugin.panel": { kind: "single", scope: "root" } },
}, OverlayHost));                                 // 组件内 props.renderSlot("myplugin.panel", {})

// 3) 自己的子 slot
ctx.slots.inject("myplugin.panel", () => ctx.slots.register({ name: "myplugin.panel" }, ChatPanel));

// 4) 动态包外壳
return { name: "myplugin", inject: ["slots"], apply(ctx) { /* 上面三段 */ } }
```

| 想做的事 | 用哪个 slot | kind | 必填 |
| --- | --- | --- | --- |
| 会话头部切换按钮 | `conversation.session.header.actions` | list / session | `id` |
| 会话头部右侧工具 | `conversation.session.header.utilities` | list / session | `id` |
| 替换头部最右角（会顶掉 sidebar-right） | `conversation.session.header.corner` | single / session | 无 |
| 全 frame 浮层 | `shell.overlay` | list / root | `id` |
| ❌ 不要碰 | `root` | single / root | — （会顶掉整个 AppFrame） |

---

## 10. 附录：对当前 `src/client.js` 的核对（2026-10-08 快照）

> 写这份文档时 `src/client.js` 已存在（611 行，非本次调研产出，我**没有修改**）。
> 把契约套上去，有 **3 处会直接失效**。以下只是核对结论，改不改由 Lead 决定。

### 10.1 ❌ `slots.register` 用了不存在的三参数形式 — `src/client.js:603-609`

```js
ctx.effect(() =>
  slots.register(
    'conversation.session.header.actions',            // ← 被当成 options
    { id: 'deepseek-chat-embed', order: 40, label: '聊天切换' },
    ChatSwitcher,                                     // ← 被当成 component
  ),
)
```

真实签名是 `(options, component)`（§1.1）。动态包还会先撞上 guard
（`$RT/dsh-cordis-client-runner/lib/client.js:258`）：

```
slots.register(options, component) needs an options object with a `name`
```

即使绕过 guard 也会在 `SlotCore.register` 里 `records.get(options.name)`
拿到 `undefined` → `slot "undefined" is not declared`（`$RT/dsh-client-ui-slots/lib/index.js:165`）。
**正确写法**（§2.3）：

```js
ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
  name: 'conversation.session.header.actions',
  id: 'deepseek-chat-embed',
  order: 40,
  label: '聊天切换',
}, ChatSwitcher))
```

### 10.2 ❌ 没有 `inject` 包裹 → 注册时机竞态

`conversation.session.header.actions` 是**别人声明**的 slot，声明只在
`client-ui-conversation` 的 header entry 挂载期间存在（§2.1）。直接 `register` 在
声明之前跑会抛 `slot "…" is not declared`。shipped 代码**无一例外**用
`ctx.slots.inject(key, cb)`（§6.1）。

### 10.3 ⚠️ `globalThis.React` 取不到 React — `src/client.js:498-499`

```js
const React = globalThis.React
if (React === undefined) return          // ← 会静默 return，插件什么都不做
```

**没有任何地方给 `globalThis.React` 赋值**（在 `$RT` 下全量 grep
`globalThis.React` / `window.React` 零命中）。React 只有两个来源：

| 交付路线 | React 从哪来 | 证据 |
| --- | --- | --- |
| **动态包**（`cordis_define` 的 `code.client`） | **闭包符号 `React`**（形参） | `$RT/dsh-cordis-client-runner/lib/client.js:155, 171` |
| **native bundle**（`window.__ModuleLoader__.load`） | `factory: (require) => { let React = require("react") }` | `$RT/dsh-client-ui-renderer/lib/client.js:11`；seed 表 `dsh-web-frontend/dist/assets/index-DjTxlw_T.js` 的 `staticModules`（`react` / `react-dom` / `react/jsx-runtime` …） |

`docs/feasibility.md` 里"动态包只有 `ctx / React / host / styles / console` 五个内建"这句
本身是对的——它说的就是这个**闭包符号**，不是全局变量。

### 10.4 ✅ 核对通过的部分

- `inject: ['slots']`（`:486`）✅ —— 属性式 `ctx.slots` 需要它；`ctx.get('slots')` 不需要
  但仍以声明为佳（`$RT/dsh-cordis-client-runner/lib/client.js:329-344`）。
- `ctx.get('slots')`（`:597`）✅ —— `readService(name, /* requireDeclaration */ false)`，
  返回的正是 `guardedSlots` 代理（`:344, 338`）。
- `ctx.effect(...)`（`:501, 512, 523`）✅ —— `ctx.effect` 在 `CTX_VERBS` 白名单里（`:205-216`）。
- 用 `<style>` + `ctx.effect` 而非 `styles.insert`（`:501-507`）✅ —— 这是 **native bundle**
  的正确姿势；只有动态包才有 `styles` 符号（§5.3）。
- 浮层走 `document.body.appendChild` + `position: fixed`（`:294-311`）——**可以工作**，
  但绕开了 `shell.overlay`（§7）。若要走 slot 路线，见 §4.2 / §5.4。
