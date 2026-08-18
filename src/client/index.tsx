/**
 * dsh-code-preview — 浏览器半（Client half）。
 *
 * 两个挂载点：
 *   1. document 捕获阶段点击委托：命中聊天消息里的文件引用
 *      （button.fileMention，或路径样的行内 code）时拦截默认行为，
 *      打开预览；
 *   2. `shell.overlay` slot 里的宿主组件：读取插件自建 store，通过
 *      `/code-preview` RPC 拉取文件内容，以**右侧停靠抽屉**（侧边栏面板）
 *      形式渲染 CodeBlock（shiki 高亮）。抽屉不遮挡聊天区，点击其他
 *      文件引用会直接切换内容。
 *
 * 跨插件协作全部走 cordis 服务；value import 仅限平台模块白名单
 * （react / ui-primitives），运行时由 loader 模块表提供。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'

/** 必需的 cordis 服务：slot 注册、RPC 调用、会话 cwd、OS 打开兜底。 */
export const inject = ['slots', 'connection', 'sessions', 'workspaces']

const STYLE_TAG_ID = 'dsh-code-preview/styles'
const RPC_CHANNEL = '/code-preview'

/** 绝对路径判定：POSIX /、Windows 盘符、UNC、~ 开头。 */
const ABSOLUTE_PATH = /^(\/|\\\\|[A-Za-z]:[/\\]|~[/\\])/

/** 扩展名 → shiki grammar 提示；未命中的由 CodeBlock 退化为纯文本。 */
const LANG_BY_EXT = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  vue: 'vue', svelte: 'svelte',
  json: 'json', jsonc: 'jsonc',
  md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', swift: 'swift', kt: 'kotlin',
  css: 'css', less: 'less', scss: 'scss', html: 'html', xml: 'xml', svg: 'xml',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', bat: 'batch', cmd: 'batch',
  sql: 'sql', lua: 'lua', dockerfile: 'dockerfile',
  txt: 'text', log: 'text',
}

/**
 * @param {string} text
 * @returns {boolean} 这段行内代码文本是否像一个文件路径。
 */
function looksLikePath(text) {
  if (text === '' || text.length > 300) return false
  if (/\s/.test(text)) return false
  // URI scheme（http:、mailto: 等）不是路径；Windows 盘符 C:\ 除外。
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[A-Za-z]:[/\\]/.test(text)) return false
  return ABSOLUTE_PATH.test(text) || /[/\\]/.test(text) || /\.[A-Za-z0-9]{1,10}$/.test(text)
}

/**
 * @param {string} path
 * @returns {string} 路径 basename（兼容两种分隔符）。
 */
function basenameOf(path) {
  const normalized = path.replace(/[/\\]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index < 0 ? normalized : normalized.slice(index + 1)
}

/**
 * @param {string} path
 * @returns {string | undefined} 按扩展名猜 shiki grammar。
 */
function langOf(path) {
  const name = basenameOf(path).toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  return LANG_BY_EXT[name.slice(dot + 1)]
}

/** 预览状态 store：插件作用域单例，useSyncExternalStore 直连。 */
function createPreviewStore() {
  let state = { open: false, path: '', cwd: undefined, nonce: 0 }
  const listeners = new Set()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot() {
      return state
    },
    open(path, cwd) {
      state = { open: true, path, cwd, nonce: state.nonce + 1 }
      emit()
    },
    close() {
      if (!state.open) return
      state = { ...state, open: false }
      emit()
    },
  }
}

const STYLES = `
.dsh-code-preview-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(560px, 45vw);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border-left: 1px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-shadow-lv3);
  pointer-events: auto;
  z-index: 1000;
  animation: dsh-code-preview-slide-in 140ms ease-out;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
@keyframes dsh-code-preview-slide-in {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.dsh-code-preview-drawer-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh-code-preview-drawer-titles {
  flex: 1;
  min-width: 0;
}
.dsh-code-preview-drawer-title {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-code-preview-drawer-path {
  margin-top: 2px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
.dsh-code-preview-drawer-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font: inherit;
  font-size: 16px;
  line-height: 1;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-code-preview-drawer-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-code-preview-drawer-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
}
.dsh-code-preview-status {
  padding: 24px 4px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-code-preview-error {
  padding: 24px 4px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-all;
}
.dsh-code-preview-truncated {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-code-preview-drawer-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 10px 16px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-code-preview-drawer-footer button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  padding: 0 14px;
  border-radius: 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.dsh-code-preview-drawer-footer button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-code-preview-drawer-footer button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.dsh-code-preview-drawer-footer button.dsh-code-preview-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dsh-code-preview-drawer-footer button.dsh-code-preview-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}
`

/**
 * @param {import('@deepseek-ai/dsh-client-runtime/client').ClientContext} ctx
 */
export function apply(ctx) {
  const store = createPreviewStore()

  ctx.effect(() => {
    if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-code-preview'
      tag.dataset.pluginCss = STYLE_TAG_ID
      tag.textContent = STYLES
      document.head.appendChild(tag)
    }
    return () => {
      document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`)?.remove()
    }
  }, 'dsh-code-preview: styles')

  /** 当前选中会话的 cwd（相对路径解析基准）。 */
  const currentCwd = () => {
    const list = ctx.sessions.list.getSnapshot()
    return list.current === undefined ? undefined : list.byId[list.current]?.cwd
  }

  /**
   * 拦截点击并打开预览。
   * @returns {boolean} 是否已拦截（调用方据此停止继续匹配）。
   */
  const tryOpen = (path, event, requireResolvable) => {
    if (!looksLikePath(path)) return false
    const cwd = currentCwd()
    if (requireResolvable && cwd === undefined && !ABSOLUTE_PATH.test(path)) return false
    event.preventDefault()
    event.stopPropagation()
    store.open(path, cwd)
    return true
  }

  ctx.effect(() => {
    /**
     * 捕获阶段委托：先于 React 根容器的合成事件触发，stopPropagation
     * 即可拦截 fileMention 按钮自带的 openPath 行为。
     */
    const onClick = (event) => {
      if (event.defaultPrevented || event.button !== 0) return
      const target = event.target
      if (!(target instanceof Element)) return
      // 抽屉内部的点击不拦截（标题路径、复制按钮等）。
      if (target.closest('.dsh-code-preview-drawer') !== null) return

      const button = target.closest('button')
      if (button !== null && typeof button.className === 'string' && button.className.includes('fileMention')) {
        const path = (button.getAttribute('title') ?? button.textContent ?? '').trim()
        if (tryOpen(path, event, false)) return
      }

      const code = target.closest('code')
      // 只处理行内 code；代码块（pre 内）不拦截。
      if (code !== null && code.closest('pre') === null) {
        const text = (code.textContent ?? '').trim()
        tryOpen(text, event, true)
      }
    }
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
    }
  }, 'dsh-code-preview: click delegation')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'code-preview',
  }, function CodePreviewDrawer() {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
    const [result, setResult] = useState({ status: 'idle' })

    useEffect(() => {
      if (!state.open) return undefined
      setResult({ status: 'loading' })
      const controller = new AbortController()
      ctx.connection.rpc.call(
        RPC_CHANNEL,
        'readFile',
        { path: state.path, cwd: state.cwd },
        controller.signal,
      ).then((response) => {
        if (controller.signal.aborted) return
        setResult(response.ok
          ? { status: 'ok', ...response.value }
          : { status: 'error', message: response.error.message })
      }).catch((error) => {
        if (!controller.signal.aborted) {
          setResult({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })
      return () => { controller.abort() }
    }, [state.open, state.path, state.cwd, state.nonce])

    // Escape 关闭（抽屉无遮罩，键盘是主要退出路径之一）。
    useEffect(() => {
      if (!state.open) return undefined
      const onKeyDown = (event) => {
        if (event.key === 'Escape') store.close()
      }
      document.addEventListener('keydown', onKeyDown)
      return () => { document.removeEventListener('keydown', onKeyDown) }
    }, [state.open])

    if (!state.open) return null

    const resolvedPath = result.status === 'ok' ? result.path : state.path
    const title = basenameOf(state.path) || '代码预览'

    return (
      <div className="dsh-code-preview-drawer" role="dialog" aria-label={title}>
        <div className="dsh-code-preview-drawer-header">
          <div className="dsh-code-preview-drawer-titles">
            <div className="dsh-code-preview-drawer-title">{title}</div>
            <div className="dsh-code-preview-drawer-path" title={resolvedPath}>{resolvedPath}</div>
          </div>
          <button type="button" className="dsh-code-preview-drawer-close" aria-label="关闭" onClick={store.close}>
            ×
          </button>
        </div>
        <div className="dsh-code-preview-drawer-body">
          {result.status === 'loading' && <div className="dsh-code-preview-status">加载中…</div>}
          {result.status === 'error' && <div className="dsh-code-preview-error">{result.message}</div>}
          {result.status === 'ok' && (
            <>
              {result.truncated && (
                <p className="dsh-code-preview-truncated">
                  文件过大，仅显示前 {result.content.length} 个字符。
                </p>
              )}
              <CodeBlock
                code={result.content}
                lang={langOf(resolvedPath)}
                copyLabel="复制"
                copiedLabel="已复制"
              />
            </>
          )}
        </div>
        <div className="dsh-code-preview-drawer-footer">
          <button
            type="button"
            disabled={result.status !== 'ok'}
            onClick={() => { void ctx.workspaces.openPath(resolvedPath) }}
          >
            在系统中打开
          </button>
          <button type="button" className="dsh-code-preview-primary" onClick={store.close}>
            关闭
          </button>
        </div>
      </div>
    )
  }))
}
