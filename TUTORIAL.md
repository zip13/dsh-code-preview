# 教程：为 DSH Web GUI 编写一个「点击文件引用预览代码」外部插件

本教程完整记录 `dsh-code-preview` 插件的开发过程：从扩展机制调研、双面插件实现、
构建、测试到安装验证。读完你可以照此开发自己的 DSH 外部插件。

目标功能：在 DSH Web GUI 的聊天消息中点击文件路径引用（行内代码、文件 mention
按钮），在右侧边栏抽屉中预览该文件的代码（语法高亮、可复制、可在系统中打开）。

---

## 1. 先理解 DSH 的插件体系

DSH 基于 cordis 插件框架。一个 Web GUI 插件是**双面包**（dual-face package）：

- **主机半**（Node.js）：作为 cordis 插件行出现在配置树里，`apply(ctx)` 里可以
  inject 主机服务（`ctx.fs`、`ctx.connection`、`ctx.webServer` …）；
- **浏览器半**：package.json 声明 `dsh.client` 并导出 `./client` bundle，
  `client-modules` 服务扫描 Loader 条目时发现它，把它挂到
  `/plugins/<包名>/client.js` 并注入 `window.__DSH_BOOT__`，浏览器 shell 启动时加载。

两个 manifest 概念（详见 `docs/user/develop/basic/publish.md`）：

- **组合包（bundle）**：`package.json` 声明 `dsh.bundle: { patch }`，携带一个
  `cordis.patch.yml` 配置层，回答"这个包贡献什么"；
- **profile**：`$DSH_HOME/profiles/<name>`（Windows 默认
  `C:\Users\<user>\.dsh\profiles\<name>`），`dsh.profile.bundles` 按序组合各 bundle 层。

安装就是 `dsh plugin --profile web add <路径>`：pnpm 把包 link 进 profile 的
`node_modules`，并把包名追加进 `dsh.profile.bundles`。**插件集合只在启动时扫描，
安装后必须重启 `dsh web`。**

### 关键约束（调研得到的硬事实）

1. **官方 API 网关的方法表是封闭的**（`packages/host/apiproxy/src/api/rpc-map.ts`），
   外部插件不能往里加方法；也没有现成的"读文件内容"RPC（`host.listDirectory`
   只列目录，`host.openPath` 只能交给 OS 打开）。
2. 但 `dsh-client-connection` 提供了**通用 RPC 通道扩展点**：
   - 主机侧：`ctx.connection.rpc.handle('/my-channel', handler, { authority })`
     注册一个新的前缀通道（自带 webserver 路由 + trust 围栏）；
   - 浏览器侧：`ctx.connection.rpc.call('/my-channel', 'endpoint', payload, signal)`。
3. `ctx.fs`（`@deepseek-ai/dsh-fs`）提供安全的文件抽象：`resolve` / `stat` /
   `readText` / `streamText` / `readBytes` / `contains`。**注意 fs-sandbox 只拦写
   不拦读，读的范围必须插件自己控制**（用 `contains` 做包含性检查）。
4. 浏览器 bundle 必须是 **CJS 闭包工厂格式**：

   ```js
   window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {
     var module = { exports: {} }; var exports = module.exports;
     /* bundle 正文，通过注入的 require 取平台模块 */
     return module.exports;
   } });
   ```

   可以 `require` 的只有**平台模块白名单**（`packages/client/web/src/platform.ts`
   + 文档化的 runtime 豁免）：

   ```
   react, react/jsx-runtime, react-dom, react-dom/client,
   @deepseek-ai/cordis,
   @deepseek-ai/dsh-client-ui-slots,
   @deepseek-ai/dsh-client-web-react,
   @deepseek-ai/dsh-client-ui-primitives,
   @deepseek-ai/dsh-client-ui-attachment,
   @deepseek-ai/dsh-client-schema-form,
   @deepseek-ai/dsh-client-runtime/client
   ```

   其余依赖必须内联进 bundle。
5. 浏览器侧 UI 扩展走 **slot 系统**：`ctx.slots.register({ name, ... }, Component)`
   注册组件，`ctx.slots.inject('slot名', cb)` 等待别的插件声明的 slot 出现后再注册。
   `shell.overlay`（list/root，ui-layout 声明）是专门留给外部插件的全局弹层席位。
6. RPC 错误码是**封闭集合**（`RpcErrorDetailsMap`），插件业务错误一律用
   `{ code: 'internal', message, details: {} }`，语义放在 message 里。

### 扩展点调研方法

写插件前先搞清楚"挂在哪里"。本次的关键发现：

- 聊天 markdown 由 `MarkdownText`（`ui-primitives/src/markdown`）渲染；行内代码
  若命中 `fileMentions` resolver，会渲染成 `<code><button class="fileMention"
  title="完整路径">`；普通行内代码就是 `<code>`；代码块是 `<pre><code>`。
- `ui-conversation` 已通过 `ctx.provide('chatFileMentions', …)`（ui-deliverables
  提供）占用了 mention 服务，**重复 provide 会冲突**，且 mention 只覆盖已结束
  turn 的收尾消息。
- 因此选择**兜底的点击委托方案**：在 `document` 上注册捕获阶段（capture）的
  click 监听——它先于 React 根容器上的合成事件触发，`stopPropagation()` 即可拦截
  fileMention 按钮自带的"在系统中打开"行为。覆盖面也更广（所有消息、所有路径样
  行内代码）。

---

## 2. 插件骨架

```
dsh-code-preview/
├── package.json          # dsh.bundle + dsh.client 双声明
├── cordis.patch.yml      # 组合层：一行激活双面
├── index.js              # 主机半（手写 ESM，免构建）
├── src/client/index.tsx  # 浏览器半源码
├── lib/client.js         # 浏览器 bundle（tsdown 构建产物）
├── tsdown.config.ts      # 自包含构建配置
├── tsconfig.json         # 关键：钉住 jsx: react-jsx（见 §5 的坑）
└── scripts/smoke.mjs     # 冒烟测试
```

### package.json

```jsonc
{
  "name": "dsh-code-preview",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",                      // 主机半入口
    "./client": "./lib/client.js",          // 浏览器 bundle（client-modules 扫描这里）
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 使 dsh plugin add 把它加入 profile 层
    "client": {
      "platform": "web",
      // 信息性依赖边：这些客户端包先加载
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-primitives"
      ]
    }
  }
}
```

### cordis.patch.yml

```yaml
- insert:
    - id: code-preview
      name: dsh-code-preview        # 按包名从 profile node_modules 解析
      # config:                      # 可选，见主机半
      #   maxBytes: 524288
      #   maxChars: 200000
```

只要包声明了 `dsh.client` 且导出 `./client`，这一行就同时激活主机半和浏览器半。

---

## 3. 主机半：安全的文件读取 RPC

`index.js`（纯 ESM JavaScript，无需构建；cordis 约定导出 `name` / `inject` /
`apply`）：

```js
export const name = 'dsh-code-preview'
export const inject = ['connection', 'fs']   // 等待这两个服务就绪再激活

export function apply(ctx, config) {
  const maxBytes = config?.maxBytes ?? 512 * 1024
  const maxChars = config?.maxChars ?? 200_000

  ctx.connection.rpc.handle('/code-preview', async (endpoint, payload, signal) => {
    if (endpoint !== 'readFile') return fail(`unknown endpoint`)
    try {
      return await readFile(ctx, payload, signal, maxBytes, maxChars)
    } catch (error) {
      return fail(String(error))
    }
  }, { authority: 'loopback' })   // 钉在本机回环：只允许本机浏览器调用
}
```

`readFile` 的四步安全管线：

```js
async function readFile(ctx, payload, signal, maxBytes, maxChars) {
  const { path, cwd } = payload
  // 1) 相对路径必须带 cwd（浏览器从当前会话取）；纯相对路径 + 无 cwd → 拒绝
  const fileTarget = await ctx.fs.resolve(path, cwd ? { cwd } : {})

  // 2) 包含性检查：已知会话工作区时，目标必须落在工作区内（防 ../ 逃逸）。
  //    fs-sandbox 只拦写不拦读，这一关必须插件自己做。
  if (cwd) {
    const ws = await ctx.fs.resolve(cwd)
    if (!ctx.fs.contains(ws, fileTarget)) return fail('路径不在会话工作区内')
  }

  // 3) stat 探明存在性与类型（目录/不存在/其他 → 明确报错）
  const info = await ctx.fs.stat(fileTarget, signal)

  // 4) 小文件 readText 全量；大文件 streamText 截断（避免一次性缓冲）；
  //    二进制由后端 FS_NOT_TEXT 拒绝
  if (info.size > maxBytes) { /* streamText 累加到 maxChars 后截断 */ }
  const content = await ctx.fs.readText(fileTarget, signal)
  return { ok: true, value: { path: ctx.fs.processPath(fileTarget), content, truncated: false } }
}
```

要点：

- `RpcResult` 形状：`{ ok: true, value } | { ok: false, error: { code, message, details } }`；
  错误码用 `'internal'`（封闭集合里的通用码），中文语义放 `message`。
- `endpoint` 段字符集限制为 `[A-Za-z0-9_$.-]+`（`'readFile'` 合法）。
- 返回的 `path` 用 `ctx.fs.processPath(target)` 取解析后的绝对路径，浏览器拿它做
  "在系统中打开"。

---

## 4. 浏览器半：点击委托 + 侧边抽屉

`src/client/index.tsx`。入口约定与所有 `ui-*` 包一致：

```tsx
import { useEffect, useState, useSyncExternalStore } from 'react'
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'   // 平台模块，external

export const inject = ['slots', 'connection', 'sessions', 'workspaces']

export function apply(ctx) { /* 三个挂载动作，见下 */ }
```

`apply(ctx)` 里做三件事：

### 4.1 注入样式（ctx.effect 管理生命周期）

```tsx
ctx.effect(() => {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-code-preview'   // 与仓库内 CSS 注入约定一致
  tag.textContent = STYLES
  document.head.appendChild(tag)
  return () => tag.remove()                  // effect 清理 = 插件卸载时移除
}, 'dsh-code-preview: styles')
```

样式必须用 **DSH 设计令牌**（`ui-theme/src/styles/design-platform.css`），否则
不会跟随明暗主题（本次迭代踩过的坑：自造 `--dsh-surface` 变量名不存在，兜底成
纯黑背景）。常用令牌：

```css
.dsh-code-preview-drawer {
  background: var(--dsw-alias-bg-layer-2);            /* 卡片层背景 */
  color: var(--dsw-alias-label-primary);              /* 主文字 */
  border-left: 1px solid var(--dsw-alias-border-l2);  /* 边框 */
  box-shadow: var(--dsw-shadow-lv3);                  /* 阴影 */
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);  /* 滚动条重绑 */
}
/* 次要文字 --dsw-alias-label-secondary；悬停 --dsw-alias-interactive-bg-hover；
   主按钮 --dsw-alias-button-primary-fill + --dsw-alias-label-primary-foreground；
   错误 --dsw-alias-state-error-primary */
```

### 4.2 点击委托（捕获阶段拦截文件引用）

```tsx
ctx.effect(() => {
  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('.dsh-code-preview-drawer')) return   // 抽屉内部不拦截

    // fileMention 按钮：title 属性承载完整路径
    const button = target.closest('button')
    if (button?.className?.includes('fileMention')) {
      const path = (button.getAttribute('title') ?? button.textContent).trim()
      if (tryOpen(path, event, false)) return
    }
    // 路径样的行内 code（pre 内代码块不拦）
    const code = target.closest('code')
    if (code && !code.closest('pre')) {
      tryOpen(code.textContent.trim(), event, true)   // 要求可解析（绝对路径或有 cwd）
    }
  }
  document.addEventListener('click', onClick, true)   // capture：先于 React 合成事件
  return () => document.removeEventListener('click', onClick, true)
}, 'dsh-code-preview: click delegation')
```

`tryOpen` 里做路径判定（`looksLikePath`：无空白、非 URI scheme、含 `/` `\` 或
带扩展名），取当前会话 cwd：

```tsx
const currentCwd = () => {
  const list = ctx.sessions.list.getSnapshot()        // SessionListState
  return list.current === undefined ? undefined : list.byId[list.current]?.cwd
}
// 命中后：event.preventDefault(); event.stopPropagation(); store.open(path, cwd)
```

### 4.3 预览抽屉（shell.overlay + 自建 store）

插件作用域的极简 store（`useSyncExternalStore` 直连）：

```tsx
function createPreviewStore() {
  let state = { open: false, path: '', cwd: undefined, nonce: 0 }
  const listeners = new Set()
  return {
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    getSnapshot: () => state,
    open(path, cwd) { state = { open: true, path, cwd, nonce: state.nonce + 1 }; emit() },
    close() { /* ... */ },
  }
}
```

注册进 `shell.overlay`（用 `slots.inject` 等 ui-layout 先声明该 slot）：

```tsx
ctx.slots.inject('shell.overlay', () => ctx.slots.register(
  { name: 'shell.overlay', id: 'code-preview' },
  function CodePreviewDrawer() {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
    const [result, setResult] = useState({ status: 'idle' })

    useEffect(() => {   // 打开/切换文件时拉取内容
      if (!state.open) return
      setResult({ status: 'loading' })
      const controller = new AbortController()
      ctx.connection.rpc
        .call('/code-preview', 'readFile', { path: state.path, cwd: state.cwd }, controller.signal)
        .then((res) => !controller.signal.aborted && setResult(
          res.ok ? { status: 'ok', ...res.value } : { status: 'error', message: res.error.message }))
      return () => controller.abort()
    }, [state.open, state.path, state.cwd, state.nonce])

    if (!state.open) return null    // 关闭时不渲染（overlay 层保持 click-through）
    return (
      <div className="dsh-code-preview-drawer" role="dialog">
        {/* 头部：文件名 + 完整路径 + 关闭；正文：CodeBlock；底部：在系统中打开 / 关闭 */}
        <CodeBlock code={result.content} lang={langOf(resolvedPath)}
                   copyLabel="复制" copiedLabel="已复制" />
      </div>
    )
  },
))
```

`CodeBlock` 是平台模块 `ui-primitives` 的现成组件：自带 shiki 高亮（未知 grammar
退化为纯文本）和复制按钮，主题色自动跟随 GUI。

> 为什么不注册进右侧 `details` slot？它是 single 类型且被 ui-conversation 的
> 工具详情面板独占，抢占会破坏既有功能。`shell.overlay` 是加法席位，自绘
> `position: fixed` 右侧抽屉视觉效果相同且无冲突。

---

## 5. 构建：复刻 client bundle 约定

外部包无法 import 仓库内的 `packages/client/tsdown.client.ts` preset，按
[turtle-ui 模式](https://github.com/deepseek-harness/turtle-ui) 自带一份
`tsdown.config.ts`：

```ts
const ID = 'dsh-code-preview'
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  sourcemap: true,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),  // 其余全内联
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
```

### 坑 1：JSX 没有被转译

tsdown 会从 cwd 向上找 `tsconfig.json`。插件目录放在另一个项目（Vue）里时，
它捡到了父项目的 `"jsx": "preserve"`，产物里残留原始 JSX（浏览器直接语法错误）。
**对策：插件目录放自己的 `tsconfig.json`，钉住 `"jsx": "react-jsx"`**（产物
require `react/jsx-runtime`，在白名单内）。构建后务必检查：

```powershell
Select-String '</_' lib\client.js   # 应为 0 个原始 JSX 标签
```

### 坑 2：没有 npm 安装权限/依赖解析失败时的构建法

插件源码只 import 平台模块（external，不需要安装），唯一需要的构建工具是
tsdown——**直接借用 DSH 仓库 node_modules 里的那份**，一行都不用装：

```sh
node <dsh-checkout>/node_modules/tsdown/dist/run.mjs
```

### 验证 bundle 格式

```powershell
Get-Content lib\client.js -Total 6    # 头部应是 __ModuleLoader__.load 包装
[regex]::Matches($c, 'require\("([^"]+)"\)')   # require 的模块必须全部在白名单内
```

---

## 6. 冒烟测试（不依赖 DSH 运行时）

`scripts/smoke.mjs` 用 mock 对象驱动真实代码路径：

- **主机半**：mock `ctx.connection.rpc.handle` 捕获 handler，mock `ctx.fs`
  （基于 `node:fs` 实现 resolve/stat/readText/streamText/contains），覆盖：
  正常读取、`../` 逃逸拒绝、文件不存在、二进制拒绝、目录拒绝、流式截断、
  无 cwd 相对路径拒绝、绝对路径读取、未知端点；
- **浏览器半**：stub `window.__ModuleLoader__.load` 和白名单模块表，`eval`
  bundle 后调用 `factory(require)` 得到 `apply`/`inject`，再用 mock ctx 验证
  注册了两个 effect 和 `shell.overlay` 注入。

```sh
node scripts/smoke.mjs
# host half: 9/9 assertions passed
# client half: bundle loads, apply registers 2 effects + shell.overlay injection
```

---

## 7. 安装与验证

```sh
# 在 DSH 源码 checkout 中（等价于已安装 CLI 时的 dsh plugin ...）：
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add <path-to>/dsh-code-preview
```

安装后验证三件事：

1. profile 的 `package.json`：`dsh.profile.bundles` 含 `dsh-code-preview`，
   `dependencies` 里是 `link:` 指向源码目录（改代码重建即生效，无需重装）；
2. `--dump-config` 输出里有 `# == dsh-code-preview` 层和 `- id: code-preview` 行；
3. `profiles/web/node_modules/dsh-code-preview` 软链存在，`lib/client.js` 就位。

然后**重启 `dsh web` 并刷新页面**（插件集合只在启动时扫描；之后的 bundle 重建
由 rev 缓存破坏机制在刷新后生效）。在任意会话点一条消息里的文件路径引用即可
看到右侧抽屉。

卸载：

```sh
dsh plugin --profile web remove dsh-code-preview
```

---

## 8. 经验总结

1. **先调研扩展点再动手**：封闭表（API 网关）不要硬闯，找官方 seam
   （Connection 通用 RPC 通道、slot 系统、shell.overlay）。
2. **读安全自己负责**：fs-sandbox 不拦读，`resolve` + `contains` 包含性检查
   + 大小上限 + loopback 围栏是最低配置。
3. **不要抢占 single slot**：用 list 加法席位（`shell.overlay`）自绘，不破坏
   既有功能。
4. **样式只用 `--dsw-*` 设计令牌**，自造变量名不会跟随主题。
5. **构建产物三查**：JSX 已转译、wrapper 格式正确、require 全在白名单。
6. **effect 即生命周期**：DOM 监听、样式注入都走 `ctx.effect` 并返回清理函数，
   插件卸载/HMR 时才不泄漏。
