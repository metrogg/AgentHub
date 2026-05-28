import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'

function resolveProxyTarget(): string {
  if (process.env.VITE_PROXY_TARGET) return process.env.VITE_PROXY_TARGET
  try {
    const portFile = path.resolve(__dirname, '../../.agenthub-port')
    const raw = readFileSync(portFile, 'utf8').trim()
    const parsed = JSON.parse(raw) as { port?: unknown; pid?: unknown }
    if (
      typeof parsed.port === 'number' &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      typeof parsed.pid === 'number' &&
      isProcessAlive(parsed.pid)
    ) {
      return `http://localhost:${parsed.port}`
    }
  } catch {
    // Port file not found, stale, or from an older build; fall back to the default dev port.
  }
  return 'http://localhost:8000'
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const apiProxyTarget = resolveProxyTarget()
const wsProxyTarget = process.env.VITE_WS_PROXY_TARGET ?? apiProxyTarget.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react()],
  publicDir: path.resolve(__dirname, '../../public'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    watch: {
      ignored: ['**/dist/**', '**/node_modules/**', '**/.git/**'],
    },
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        timeout: 0,
      },
      '/ws': {
        target: wsProxyTarget,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
