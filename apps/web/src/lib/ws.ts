import { WsEvent } from '@agenthub/shared'

type Listener = (event: WSEvent) => void

export interface WSEvent {
  type: WsEvent
  payload?: any
}

class WSClient {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private reconnectTimer: number | null = null
  private currentSessionId: string | null = null

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/ws`
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      if (this.currentSessionId) {
        this.joinSession(this.currentSessionId)
      }
    }

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as WSEvent
        this.listeners.forEach((l) => l(data))
      } catch {
        // ignore malformed
      }
    }

    this.ws.onclose = () => {
      this.ws = null
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 2000)
  }

  joinSession(sessionId: string) {
    this.currentSessionId = sessionId
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: WsEvent.SessionJoin, payload: { sessionId } }))
    } else {
      this.connect()
    }
  }

  on(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  disconnect() {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.currentSessionId = null
  }
}

export const wsClient = new WSClient()
