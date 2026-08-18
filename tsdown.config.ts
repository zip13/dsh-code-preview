/**
 * dsh-code-preview 浏览器 bundle 构建配置。
 *
 * 复刻 DSH 仓库内 packages/client/tsdown.client.ts 的 client bundle 约定
 * （外部包无法 import 该 preset，按 turtle-ui 模式自带一份）：
 *   - CJS 闭包工厂产物：window.__ModuleLoader__.load({ id, factory })；
 *   - 平台模块保持 external，运行时由 loader 模块表 require；
 *   - 其余依赖全部内联。
 */
/** @type {import('tsdown').UserConfig} */

const ID = 'dsh-code-preview'

// 与 packages/client/web/src/platform.ts 的 PLATFORM_MODULES + 文档化的
// runtime store 豁免（dsh-client-runtime/client）保持一致。
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: true,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
