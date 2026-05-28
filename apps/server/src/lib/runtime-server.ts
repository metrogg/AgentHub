let runtimeServerPort: number | null = null

export function setRuntimeServerPort(port: number) {
  runtimeServerPort = Number.isFinite(port) ? port : null
}

export function getRuntimeServerPort() {
  return runtimeServerPort
}
