# dsh-code-preview

DSH（DeepSeek Harness）Web GUI 的外部用户插件：**点击聊天消息中的文件引用，在右侧边栏抽屉中预览代码**。

> 想了解这个插件是怎么写出来的？见 [TUTORIAL.md](TUTORIAL.md)——完整的开发教程（扩展机制调研、双面插件实现、构建、测试、安装）。

## 功能

- 点击聊天中的文件引用（`button.fileMention`，或路径样的行内代码，如 `src/index.ts`、`H:\code2\xxx\package.json`），在 GUI 右侧打开停靠抽屉式预览面板；
- 抽屉不遮挡聊天区：点击其他文件引用会直接切换内容，Escape 或关闭按钮收起；
- 文件内容通过插件自建的 `/code-preview` RPC 通道从主机读取，使用 GUI 自带的 shiki 高亮渲染（`CodeBlock`），支持一键复制；
- 相对路径以当前会话的工作区目录（cwd）解析；主机端强制包含性检查，拒绝读取会话工作区之外的路径；
- 大文件流式截断预览；二进制文件、目录、不存在的文件给出明确错误提示；
- 抽屉底部可一键"在系统中打开"（走原有 `host.openPath` 行为）。

> 为什么不用 GUI 的 details 侧栏 slot？右侧 details 列是 single 槽位，已被
> ui-conversation 的工具详情面板独占；本插件选择 `shell.overlay` 加法席位
> 自绘右侧抽屉，不影响既有工具详情功能。

## 结构

```
├── index.js            # 主机半：注册 /code-preview RPC（ctx.connection + ctx.fs）
├── src/client/index.tsx # 浏览器半：点击委托 + shell.overlay 弹层
├── lib/client.js       # 浏览器 bundle（tsdown 构建产物，CJS 闭包工厂格式）
├── cordis.patch.yml    # dsh.bundle 组合层
└── tsdown.config.ts    # 复刻仓库内 clientBundle preset 的自包含构建
```

## 构建

本目录不锁定自己的依赖；直接用 DSH 仓库里的 tsdown 构建即可：

```sh
node H:\code2\deepseek-harness\node_modules\tsdown\dist\run.mjs
```

（或在本目录 `npm install` 后 `npm run build`。）

## 安装 / 卸载

```sh
# 在 DSH 源码 checkout 中：
pnpm dsh plugin --profile web add H:\code2\hcwebv3\dsh-code-preview
# 或已安装 dsh CLI 时：
dsh plugin --profile web add H:\code2\hcwebv3\dsh-code-preview

# 移除：
dsh plugin --profile web remove dsh-code-preview
```

安装后**需要重启 `dsh web`**：插件集合的元数据在启动时扫描并缓存，重启后
`window.__DSH_BOOT__` 才会包含本插件的条目（`/plugins/dsh-code-preview/client.js`）。
之后的 bundle 重建（`lib/client.js` 内容变化）由 client-modules 的 rev 机制
在刷新页面后生效。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 中覆盖行配置：

```yaml
- id: code-preview
  name: dsh-code-preview
  config:
    maxBytes: 524288   # 直接全量读取的大小上限（超出则流式截断）
    maxChars: 200000   # 截断预览保留的最大字符数
```

## 安全说明

- RPC 通道注册为 `loopback` authority：只有本机回环地址的浏览器请求可调用；
- 已知会话 cwd 时，目标路径必须通过 `ctx.fs.contains` 包含性检查（禁止目录遍历逃逸）；
- 文件大小有硬上限，二进制内容由后端 `FS_NOT_TEXT` 拒绝；
- 本插件只读文件，没有任何写操作。

## 测试

```sh
node scripts/smoke.mjs
```

覆盖：正常读取、目录逃逸拒绝、文件不存在、二进制拒绝、目录拒绝、流式截断、
无 cwd 相对路径拒绝、绝对路径读取、未知端点，以及浏览器 bundle 的加载与注册。
