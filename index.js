/**
 * dsh-code-preview — 主机半（Host half）。
 *
 * 通过 Connection 的通用 RPC 通道注册 `/code-preview` 端点，用 ctx.fs 在
 * 会话工作区内安全地读取文本文件：
 *   1. 相对路径以浏览器传来的会话 cwd 解析（ctx.fs.resolve(path, { cwd })）；
 *   2. 已知 cwd 时强制包含性检查（ctx.fs.contains），拒绝工作区外的路径；
 *   3. 小文件 readText 全量返回，大文件 streamText 截断返回；
 *   4. 二进制 / 非 UTF-8 文件由后端的 FS_NOT_TEXT 拒绝。
 *
 * 通道钉在 loopback：只有本机浏览器能调用（DNS-rebinding 围栏由
 * Connection 的 isTrustedApiRequest 完成）。
 */

export const name = 'dsh-code-preview'

export const inject = ['connection', 'fs']

const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_MAX_CHARS = 200_000

/** 绝对路径判定：POSIX /、Windows 盘符、UNC、~ 开头。 */
const ABSOLUTE_PATH = /^(\/|\\\\|[A-Za-z]:[/\\]|~[/\\])/

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ maxBytes?: number, maxChars?: number } | undefined} config
 */
export function apply(ctx, config) {
  const maxBytes = Number.isFinite(config?.maxBytes) ? Number(config.maxBytes) : DEFAULT_MAX_BYTES
  const maxChars = Number.isFinite(config?.maxChars) ? Number(config.maxChars) : DEFAULT_MAX_CHARS

  ctx.connection.rpc.handle('/code-preview', async (endpoint, payload, signal) => {
    if (endpoint !== 'readFile') {
      return fail(`code-preview: unknown endpoint ${JSON.stringify(endpoint)}`)
    }
    try {
      return await readFile(ctx, payload, signal, maxBytes, maxChars)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }, { authority: 'loopback' })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} payload
 * @param {AbortSignal} signal
 * @param {number} maxBytes
 * @param {number} maxChars
 */
async function readFile(ctx, payload, signal, maxBytes, maxChars) {
  if (typeof payload !== 'object' || payload === null) {
    return fail('code-preview: payload must be an object')
  }
  const { path, cwd } = /** @type {{ path?: unknown, cwd?: unknown }} */ (payload)
  if (typeof path !== 'string' || path.trim() === '') {
    return fail('code-preview: payload.path must be a non-empty string')
  }
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  if (base === undefined && !ABSOLUTE_PATH.test(path)) {
    return fail('code-preview: 没有可用的会话工作区，无法解析相对路径')
  }

  const fileTarget = await ctx.fs.resolve(path, base === undefined ? {} : { cwd: base })

  // 读的 scope 由本插件控制（fs-sandbox 只拦写不拦读）：已知会话工作区时，
  // 目标必须落在工作区之内。
  if (base !== undefined) {
    const workspaceTarget = await ctx.fs.resolve(base)
    if (!ctx.fs.contains(workspaceTarget, fileTarget)) {
      return fail(`code-preview: 路径不在会话工作区内: ${path}`)
    }
  }

  const info = await ctx.fs.stat(fileTarget, signal)
  if (info === undefined) {
    return fail(`code-preview: 文件不存在: ${path}`)
  }
  if (info.type !== 'file') {
    return fail(`code-preview: 不是常规文件: ${path}`)
  }

  const resolvedPath = ctx.fs.processPath(fileTarget)

  try {
    if (typeof info.size === 'number' && info.size > maxBytes) {
      // 大文件：流式读取并截断，避免一次性缓冲。
      let content = ''
      let truncated = false
      for await (const chunk of await ctx.fs.streamText(fileTarget, signal)) {
        content += chunk
        if (content.length >= maxChars) {
          content = content.slice(0, maxChars)
          truncated = true
          break
        }
      }
      return ok({ path: resolvedPath, content, truncated, sizeBytes: info.size })
    }
    const content = await ctx.fs.readText(fileTarget, signal)
    return ok({ path: resolvedPath, content, truncated: false, sizeBytes: info.size ?? content.length })
  } catch (error) {
    const code = /** @type {{ code?: unknown }} */ (error)?.code
    if (code === 'FS_NOT_TEXT') {
      return fail(`code-preview: 不是文本文件（可能是二进制）: ${path}`)
    }
    if (code === 'FS_TOO_LARGE') {
      return fail(`code-preview: 文件超过大小上限 (${maxBytes} 字节): ${path}`)
    }
    throw error
  }
}

/** @param {unknown} value */
function ok(value) {
  return { ok: true, value }
}

/** @param {string} message */
function fail(message) {
  // RpcError 的 code 是封闭集合；业务错误一律走 'internal'，消息承载语义。
  return { ok: false, error: { code: 'internal', message, details: {} } }
}
