import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'

let cachedProxyTarget: { target: string; expiresAt: number } | null = null

function resolveProxyTarget(): string {
  if (process.env.VITE_PROXY_TARGET) return process.env.VITE_PROXY_TARGET
  const now = Date.now()
  if (cachedProxyTarget && cachedProxyTarget.expiresAt > now) return cachedProxyTarget.target

  try {
    const portFile = path.resolve(__dirname, '../../.agenthub-port')
    const raw = readFileSync(portFile, 'utf8').trim()
    const parsed = JSON.parse(raw) as { port?: unknown; pid?: unknown }
    if (typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0) {
      if (serverHealthOk(parsed.port)) {
        return cacheProxyTarget(`http://127.0.0.1:${parsed.port}`)
      }
    }
  } catch {
    // Port file not found, stale, or from an older build; fall back to the default dev port.
  }
  return cacheProxyTarget(findLiveServerTarget() ?? 'http://127.0.0.1:8000')
}

function resolveWsProxyTarget(): string {
  if (process.env.VITE_WS_PROXY_TARGET) return process.env.VITE_WS_PROXY_TARGET
  return resolveProxyTarget().replace(/^http/, 'ws')
}

function useDynamicProxyTarget(isWebSocket = false): NonNullable<ProxyOptions['configure']> {
  return (proxy) => {
    const web = proxy.web.bind(proxy)
    const ws = proxy.ws.bind(proxy)

    proxy.web = (req, res, options, callback) => {
      web(
        req,
        res,
        {
          ...options,
          target: resolveProxyTarget(),
          changeOrigin: true,
        },
        callback,
      )
    }

    if (isWebSocket) {
      proxy.ws = (req, socket, head, options, callback) => {
        ws(
          req,
          socket,
          head,
          {
            ...options,
            target: resolveWsProxyTarget(),
            changeOrigin: true,
          },
          callback,
        )
      }
    }
  }
}

function cacheProxyTarget(target: string) {
  cachedProxyTarget = {
    target,
    expiresAt: Date.now() + 2_000,
  }
  return target
}

function findLiveServerTarget() {
  for (let port = 8000; port < 8010; port += 1) {
    if (serverHealthOk(port)) return `http://127.0.0.1:${port}`
  }
  return null
}

function serverHealthOk(port: number) {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      [
        'const http = require("node:http");',
        'const port = Number(process.argv[2]);',
        'const req = http.get({ hostname: "127.0.0.1", port, path: "/health", timeout: 350 }, (res) => {',
        '  let body = "";',
        '  res.setEncoding("utf8");',
        '  res.on("data", (chunk) => body += chunk);',
        '  res.on("end", () => process.exit(res.statusCode === 200 && body.includes("\"status\":\"ok\"") ? 0 : 1));',
        '});',
        'req.on("timeout", () => req.destroy(new Error("timeout")));',
        'req.on("error", () => process.exit(1));',
      ].join(''),
      String(port),
    ],
    {
      stdio: 'ignore',
      timeout: 700,
    },
  )
  return probe.status === 0
}

const apiProxyTarget = resolveProxyTarget()
const wsProxyTarget = resolveWsProxyTarget()

export default defineConfig({
  plugins: [react()],
  publicDir: path.resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    },
    watch: {
      ignored: ['**/dist/**', '**/node_modules/**', '**/.git/**'],
    },
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        timeout: 0,
        configure: useDynamicProxyTarget(),
      },
      '/ws': {
        target: wsProxyTarget,
        ws: true,
        configure: useDynamicProxyTarget(true),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
