/**
 * dsh-code-preview 冒烟测试（不依赖 DSH 运行时）：
 *   1. 主机半：mock ctx.connection / ctx.fs（基于 node:fs 的最小实现），
 *      走 apply() 注册的真实 handler 验证 readFile 全部分支；
 *   2. 浏览器半：stub window.__ModuleLoader__ 与平台模块 require 表，
 *      验证 bundle 可加载、apply() 注册 effect 与 shell.overlay 注入。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = fileURLToPath(new URL('..', import.meta.url))
const tmp = join(pluginDir, '.smoke')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

// ---- 主机半 ----

/** 最小 ctx.fs 模拟：target = { targetKey, displayPath }，canonical realpath。 */
const fsMock = {
  async resolve(path, opts = {}) {
    const abs = isAbsolute(path) ? path : resolve(opts.cwd ?? process.cwd(), path)
    let canonical = abs
    try { canonical = realpathSync(abs) } catch { /* 不存在时保留规范化路径 */ }
    return { targetKey: canonical, displayPath: canonical }
  },
  processPath: (target) => target.targetKey,
  contains: (parent, child) => {
    const rel = relative(parent.targetKey, child.targetKey)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${'\\'}`) && !rel.startsWith('../') && !isAbsolute(rel))
  },
  async stat(target) {
    try {
      const s = statSync(target.targetKey)
      return { version: 1, type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size }
    } catch {
      return undefined
    }
  },
  async readText(target) {
    const buf = await readFile(target.targetKey)
    if (buf.includes(0)) {
      const error = new Error('binary file')
      error.code = 'FS_NOT_TEXT'
      throw error
    }
    return buf.toString('utf8')
  },
  async streamText(target) {
    const text = await this.readText(target)
    return (async function* () {
      for (let i = 0; i < text.length; i += 4096) yield text.slice(i, i + 4096)
    })()
  },
}

let rpcHandler
let rpcHandlerSmall
const hostCtx = {
  fs: fsMock,
  connection: {
    rpc: {
      handle: (channel, handler, options) => {
        assert.equal(channel, '/code-preview')
        assert.equal(options.authority, 'loopback')
        rpcHandler = handler
        return async () => {}
      },
    },
  },
}
// 第二个实例使用小上限，独占一个通道注册来驱动截断分支。
const hostCtxSmall = {
  fs: fsMock,
  connection: {
    rpc: {
      handle: (channel, handler) => {
        rpcHandlerSmall = handler
        return async () => {}
      },
    },
  },
}

const hostPlugin = await import('../index.js')
assert.equal(hostPlugin.name, 'dsh-code-preview')
assert.deepEqual(hostPlugin.inject, ['connection', 'fs'])
hostPlugin.apply(hostCtx, undefined)
hostPlugin.apply(hostCtxSmall, { maxBytes: 100, maxChars: 150 })
assert.equal(typeof rpcHandler, 'function')

const controller = new AbortController()
const call = (endpoint, payload) => rpcHandler(endpoint, payload, controller.signal)

// 1. 正常读取（相对路径 + cwd）
{
  const res = await call('readFile', { path: 'package.json', cwd: pluginDir })
  assert.equal(res.ok, true, res.error?.message)
  assert.ok(res.value.content.includes('"dsh-code-preview"'))
  assert.equal(res.value.truncated, false)
  assert.ok(isAbsolute(res.value.path))
}
// 2. 目录遍历逃逸被拒绝
{
  writeFileSync(join(pluginDir, '.smoke-escape.txt'), 'secret')
  const res = await call('readFile', { path: '../.smoke-escape.txt', cwd: tmp })
  assert.equal(res.ok, false)
  assert.match(res.error.message, /不在会话工作区/)
  rmSync(join(pluginDir, '.smoke-escape.txt'))
}
// 3. 不存在的文件
{
  const res = await call('readFile', { path: 'no-such-file.txt', cwd: tmp })
  assert.equal(res.ok, false)
  assert.match(res.error.message, /不存在/)
}
// 4. 二进制文件
{
  writeFileSync(join(tmp, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]))
  const res = await call('readFile', { path: 'bin.dat', cwd: tmp })
  assert.equal(res.ok, false)
  assert.match(res.error.message, /二进制/)
}
// 5. 目录
{
  const res = await call('readFile', { path: '.', cwd: tmp })
  assert.equal(res.ok, false)
  assert.match(res.error.message, /不是常规文件/)
}
// 6. 大文件流式截断（小上限实例：maxBytes=100，maxChars=150，内容 200 字符）
{
  writeFileSync(join(tmp, 'big.txt'), 'x'.repeat(200))
  const res = await rpcHandlerSmall('readFile', { path: 'big.txt', cwd: tmp }, controller.signal)
  assert.equal(res.ok, true, res.error?.message)
  assert.equal(res.value.truncated, true)
  assert.equal(res.value.content.length, 150)
}
// 7. 相对路径但没有 cwd
{
  const res = await call('readFile', { path: 'package.json' })
  assert.equal(res.ok, false)
  assert.match(res.error.message, /相对路径/)
}
// 8. 绝对路径且在工作区内（带 cwd 的包含性检查仍生效）
{
  const inside = join(tmp, 'big.txt')
  const res = await call('readFile', { path: inside, cwd: tmp })
  assert.equal(res.ok, true)
}
// 9. 未知端点
{
  const res = await call('stat', {})
  assert.equal(res.ok, false)
  assert.match(res.error.message, /unknown endpoint/)
}
console.log('host half: 9/9 assertions passed')

// ---- 浏览器半 ----

let captured
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => { captured = entry },
  },
}

const bundleSource = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')
// bundle 是 classic script：直接 eval 即触发 __ModuleLoader__.load。
eval(bundleSource)
assert.equal(captured.id, 'dsh-code-preview')

const platformModules = {
  'react': {
    useEffect: () => {},
    useState: (initial) => [initial, () => {}],
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  },
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') },
  '@deepseek-ai/dsh-client-ui-primitives': { Modal: () => null, CodeBlock: () => null },
}
const moduleExports = captured.factory((id) => {
  assert.ok(id in platformModules, `unexpected require: ${id}`)
  return platformModules[id]
})
assert.deepEqual([...moduleExports.inject].sort(), ['connection', 'sessions', 'slots', 'workspaces'])
assert.equal(typeof moduleExports.apply, 'function')

const effects = []
const slotInjections = []
const clientCtx = {
  effect: (fn, label) => { effects.push(label) },
  slots: { inject: (name, callback) => { slotInjections.push(name); assert.equal(typeof callback, 'function') } },
  sessions: { list: { getSnapshot: () => ({ current: undefined, byId: {} }) } },
  connection: { rpc: { call: async () => ({ ok: false, error: { code: 'internal', message: 'stub', details: {} } }) } },
  workspaces: { openPath: async () => {} },
}
moduleExports.apply(clientCtx)
assert.deepEqual(effects, ['dsh-code-preview: styles', 'dsh-code-preview: click delegation'])
assert.deepEqual(slotInjections, ['shell.overlay'])
console.log('client half: bundle loads, apply registers 2 effects + shell.overlay injection')

rmSync(tmp, { recursive: true, force: true })
console.log('SMOKE OK')
