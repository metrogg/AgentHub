import { useEffect, useRef, useCallback, useState } from 'react'

export interface WSEvent {
  type: string
  payload: Record<string, unknown>
}

export function useWebSocket(url: string) {
  const ws = useRef<WebSocket | null>(null)
  const [readyState, setReadyState] = useState<number>(WebSocket.CONNECTING)
  const listeners = useRef<Set<(event: WSEvent) => void>>(new Set())

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let shouldReconnect = true

    const connect = () => {
      if (!shouldReconnect) return
      const socket = new WebSocket(url)
      ws.current = socket
      setReadyState(WebSocket.CONNECTING)

      socket.onopen = () => {
        setReadyState(WebSocket.OPEN)
      }

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WSEvent
          for (const listener of listeners.current) {
            listener(data)
          }
        } catch {
          // ignore non-JSON messages
        }
      }

      socket.onclose = () => {
        setReadyState(WebSocket.CLOSED)
        ws.current = null
        if (shouldReconnect) {
          reconnectTimer = setTimeout(connect, 2000)
        }
      }

      socket.onerror = () => {
        // will trigger onclose
      }
    }

    connect()

    return () => {
      shouldReconnect = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws.current?.close()
    }
  }, [url])

  const sendMessage = useCallback((data: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(data))
    }
  }, [])

  const subscribe = useCallback((callback: (event: WSEvent) => void) => {
    listeners.current.add(callback)
    return () => { listeners.current.delete(callback) }
  }, [])

  return { sendMessage, subscribe, readyState }
}
