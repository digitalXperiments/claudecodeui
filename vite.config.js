import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': {
          target: `http://${proxyHost}:${serverPort}`,
          ws: true,
        },
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      // Keep old hashed chunks available for tabs that loaded an older entry
      // graph before a rebuild and only request a lazy view afterwards. Without
      // this, a stale tab asks for the previous StudioView/vendor chunk and the
      // browser reports "Failed to fetch dynamically imported module".
      // Hashed assets are immutable; deployments can prune old generations
      // during their normal artifact-retention window.
      emptyOutDir: false,
      outDir: 'dist',
      // Chat shell stays eager (~1.2 MB). Heavy views and vendors are split out.
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          // Keep manual chunks limited to dependency families with clean module
          // boundaries. Grouping the markdown/remark/rehype graph by path can
          // split circular dependencies across chunks and trigger a TDZ error
          // before React mounts ("Cannot access ... before initialization").
          manualChunks: {
            'vendor-react': [
              'react',
              'react-dom',
              'react-router-dom',
              // Tiny Babel helpers shared by @uiw/react-codemirror and
              // react-syntax-highlighter. Left alone, the object form drags them
              // into vendor-codemirror, so loading the highlighter would pull
              // all of CodeMirror. vendor-react is always eager anyway.
              '@babel/runtime/helpers/extends',
              '@babel/runtime/helpers/objectWithoutPropertiesLoose'
            ],
            'vendor-i18n': ['i18next', 'i18next-browser-languagedetector', 'react-i18next'],
            'vendor-ui': [
              'lucide-react',
              'cmdk',
              'react-dropzone',
              'react-error-boundary',
              '@dnd-kit/core',
              '@dnd-kit/sortable',
              '@dnd-kit/utilities'
            ],
            // jszip and yaml are only used by lazy views; leaving them out lets
            // Rollup split them into their consumers' chunks instead of the
            // eager vendor-utils preload. dompurify stays (PluginIcon is eager).
            'vendor-utils': ['dompurify', 'fuse.js', 'jsonrepair'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
            ,
            // Leaf libraries with no back-references into the app or the remark
            // graph, so they split cleanly: math rendering and code highlighting.
            'vendor-katex': ['katex'],
            // Only the PrismLight entry: the package index also pulls ~500
            // async-language modules (and Vite's preload helper) into the chunk.
            'vendor-highlight': ['refractor', 'react-syntax-highlighter/dist/esm/prism-light']
          }
        }
      }
    }
  }
})
