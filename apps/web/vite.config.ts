import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'

function resolveProxyTarget(): string {
  if (process.env.VITE_PROXY_TARGET) return process.env.VITE_PROXY_TARGET
  try {
    const portFile = path.resolve(__dirname, '../../.agenthub-port')
    const port = readFileSync(portFile, 'utf8').trim()
    if (port && /^\d+$/.test(port)) return `http://localhost:${port}`
  } catch {
    // Port file not found; server may not be running yet
  }
  return 'http://localhost:8000'
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
