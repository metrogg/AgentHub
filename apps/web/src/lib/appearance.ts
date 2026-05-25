export type AppearanceSettings = {
  accent?: string
  bodyFont?: string
  codeBlockFont?: string
  fontSize?: string
  inlineCodeFont?: string
  mainWindowTheme?: string
  embeddedWindowTheme?: string
  terminalFont?: string
  uiFont?: string
}

export function applyAppearanceSettings(settings: AppearanceSettings) {
  const root = document.documentElement
  const theme = resolveTheme(settings.mainWindowTheme ?? '跟随系统')
  const embeddedTheme = resolveTheme(settings.embeddedWindowTheme ?? settings.mainWindowTheme ?? '跟随系统')
  const palette = themePalette(theme)
  const embeddedPalette = themePalette(embeddedTheme)
  const accent = accentColor(settings.accent ?? '黑色')
  const isDark = theme === 'dark'
  const embeddedIsDark = embeddedTheme === 'dark'

  root.dataset.agenthubTheme = theme
  root.dataset.agenthubEmbeddedTheme = embeddedTheme
  root.style.setProperty('--agenthub-font-body', fontStack(settings.bodyFont ?? '默认', 'body'))
  root.style.setProperty('--agenthub-font-ui', fontStack(settings.uiFont ?? '默认', 'ui'))
  root.style.setProperty('--agenthub-font-code', fontStack(settings.codeBlockFont ?? '默认', 'mono'))
  root.style.setProperty('--agenthub-font-terminal', fontStack(settings.terminalFont ?? '默认', 'mono'))
  root.style.setProperty('--agenthub-font-size', `${settings.fontSize || '14'}px`)
  root.style.setProperty('--agenthub-accent', accent)
  root.style.setProperty('--agenthub-accent-soft', hexToRgba(accent, isDark ? 0.2 : 0.12))
  root.style.setProperty('--agenthub-app-bg', palette.bg)
  root.style.setProperty('--agenthub-app-sidebar', palette.chrome)
  root.style.setProperty('--agenthub-app-panel', palette.panel)
  root.style.setProperty('--agenthub-app-panel-muted', isDark ? '#1d1d1d' : '#f4f4ef')
  root.style.setProperty('--agenthub-app-control', isDark ? '#202020' : '#ffffff')
  root.style.setProperty('--agenthub-app-border', palette.border)
  root.style.setProperty('--agenthub-app-text', palette.text)
  root.style.setProperty('--agenthub-app-muted', palette.muted)
  root.style.setProperty('--agenthub-app-muted-text', isDark ? '#a3a3a3' : '#666660')
  root.style.setProperty('--agenthub-app-hover', isDark ? '#303030' : '#ecece7')
  root.style.setProperty('--agenthub-app-active', hexToRgba(accent, isDark ? 0.18 : 0.1))
  root.style.setProperty('--agenthub-menu-bg', palette.chrome)
  root.style.setProperty('--agenthub-menu-panel', palette.panel)
  root.style.setProperty('--agenthub-menu-border', palette.border)
  root.style.setProperty('--agenthub-menu-hover', isDark ? '#303030' : '#e9e9e4')
  root.style.setProperty('--agenthub-menu-muted', isDark ? '#a3a3a3' : '#737373')
  root.style.setProperty('--agenthub-embedded-bg', embeddedPalette.bg)
  root.style.setProperty('--agenthub-embedded-sidebar', embeddedPalette.chrome)
  root.style.setProperty('--agenthub-embedded-panel', embeddedPalette.panel)
  root.style.setProperty('--agenthub-embedded-panel-muted', embeddedIsDark ? '#1d1d1d' : '#f4f4ef')
  root.style.setProperty('--agenthub-embedded-control', embeddedIsDark ? '#202020' : '#ffffff')
  root.style.setProperty('--agenthub-embedded-border', embeddedPalette.border)
  root.style.setProperty('--agenthub-embedded-text', embeddedPalette.text)
  root.style.setProperty('--agenthub-embedded-muted', embeddedPalette.muted)
  root.style.setProperty('--agenthub-embedded-muted-text', embeddedIsDark ? '#a3a3a3' : '#666660')
  root.style.setProperty('--agenthub-embedded-hover', embeddedIsDark ? '#303030' : '#ecece7')
  root.style.setProperty('--agenthub-embedded-accent-soft', hexToRgba(accent, embeddedIsDark ? 0.2 : 0.12))
}

export function resolveTheme(value: string): 'light' | 'dark' {
  if (value === '暗色') return 'dark'
  if (value === '亮色') return 'light'
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'light'
}

export function themePalette(theme: 'light' | 'dark') {
  return theme === 'dark'
    ? {
        bg: '#171717',
        border: '#2f2f2f',
        chrome: '#242424',
        muted: '#737373',
        panel: '#111111',
        text: '#f5f5f5',
      }
    : {
        bg: '#fbfbf8',
        border: '#e5e5e0',
        chrome: '#f1f1ec',
        muted: '#c7c7c0',
        panel: '#ffffff',
        text: '#171717',
      }
}

export function accentColor(value: string) {
  const colors: Record<string, string> = {
    黑色: '#171717',
    蓝色: '#2563eb',
    绿色: '#059669',
    琥珀色: '#d97706',
  }
  return colors[value] ?? colors.黑色
}

export function hexToRgba(hex: string, alpha: number) {
  const value = hex.replace('#', '')
  if (value.length !== 6) return hex
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

export function fontStack(value: string, kind: 'body' | 'mono' | 'ui') {
  if (!value || value === '默认') {
    return kind === 'mono'
      ? '"JetBrains Mono", "Cascadia Mono", ui-monospace, SFMono-Regular, Consolas, monospace'
      : '"Aptos", "Microsoft YaHei UI", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif'
  }
  const fallback = kind === 'mono' ? 'ui-monospace, SFMono-Regular, Consolas, monospace' : 'ui-sans-serif, system-ui, sans-serif'
  return `"${value}", ${fallback}`
}
