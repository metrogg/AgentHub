import { useEffect, useRef, useCallback } from 'react'

export function useWebSocket(url: string) {
  const ws = useRef<WebSocket | null>(null)

  useEffect(() => {
    const socket = new WebSocket(url)
    ws.current = socket

    return () => {
      socket.close()
    }
  }, [url])

  const sendMessage = useCallback((data: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(data))
    }
  }, [])

  return { sendMessage, ws }
}
