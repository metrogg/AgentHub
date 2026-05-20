import { createTheme, type Theme } from '@mui/material/styles'

export type StudioThemeId = 'dark' | 'light'

export interface StudioThemeOption {
  id: StudioThemeId
  name: string
  description: string
  swatches: string[]
}

export const STUDIO_THEME_STORAGE_KEY = 'agenthub.studioTheme'

export const studioThemeOptions: StudioThemeOption[] = [
  {
    id: 'dark',
    name: '深色',
    description: '默认的 Mastra 风格深色界面，适合长时间调试 Agent。',
    swatches: ['#050505', '#111111', '#8fd060', '#f4f4f4'],
  },
  {
    id: 'light',
    name: '亮色',
    description: '低眩光浅色界面，适合白天整理提示词、数据集和设计文档。',
    swatches: ['#f7f4ed', '#ffffff', '#2f8f64', '#1f2528'],
  },
]

export function isStudioThemeId(value: string | null): value is StudioThemeId {
  return value === 'dark' || value === 'light'
}

export function normalizeStudioThemeId(value: string | null): StudioThemeId {
  if (value === 'daylight') return 'light'
  if (value === 'midnight' || value === 'graphite') return 'dark'
  return isStudioThemeId(value) ? value : 'dark'
}

export function createStudioTheme(themeId: StudioThemeId): Theme {
  const tokens = themeTokens[themeId]
  return createTheme({
    palette: {
      mode: tokens.mode,
      primary: {
        main: tokens.primary,
        dark: tokens.primaryDark,
        light: tokens.primaryLight,
      },
      secondary: {
        main: tokens.accent,
      },
      success: {
        main: tokens.success,
      },
      warning: {
        main: tokens.warning,
      },
      background: {
        default: tokens.background,
        paper: tokens.paper,
      },
      text: {
        primary: tokens.textPrimary,
        secondary: tokens.textSecondary,
      },
      divider: tokens.divider,
    },
    shape: {
      borderRadius: 8,
    },
    typography: {
      fontFamily: '"Aptos", "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
      h4: { fontWeight: 760, letterSpacing: 0 },
      h5: { fontWeight: 760, letterSpacing: 0 },
      h6: { fontWeight: 760, letterSpacing: 0 },
      button: { textTransform: 'none', fontWeight: 700 },
    },
    components: {
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            boxShadow: 'none',
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
          },
        },
      },
    },
  })
}

export function applyStudioThemeVariables(themeId: StudioThemeId) {
  const tokens = themeTokens[themeId]
  const root = document.documentElement
  root.dataset.studioTheme = themeId
  root.style.setProperty('--studio-bg', tokens.background)
  root.style.setProperty('--studio-paper', tokens.paper)
  root.style.setProperty('--studio-surface', tokens.surface)
  root.style.setProperty('--studio-surface-soft', tokens.surfaceSoft)
  root.style.setProperty('--studio-border', tokens.divider)
  root.style.setProperty('--studio-text', tokens.textPrimary)
  root.style.setProperty('--studio-text-muted', tokens.textSecondary)
  root.style.setProperty('--studio-accent', tokens.accent)
  root.style.setProperty('--studio-accent-soft', tokens.accentSoft)
  root.style.setProperty('--studio-inverse', tokens.inverse)
}

const themeTokens: Record<
  StudioThemeId,
  {
    mode: 'dark' | 'light'
    background: string
    paper: string
    surface: string
    surfaceSoft: string
    textPrimary: string
    textSecondary: string
    primary: string
    primaryDark: string
    primaryLight: string
    accent: string
    accentSoft: string
    success: string
    warning: string
    divider: string
    inverse: string
  }
> = {
  dark: {
    mode: 'dark',
    background: '#050505',
    paper: '#111111',
    surface: '#151515',
    surfaceSoft: '#1f1f1f',
    textPrimary: '#f4f4f4',
    textSecondary: '#9b9b9b',
    primary: '#f2f2f2',
    primaryDark: '#d6d6d6',
    primaryLight: '#ffffff',
    accent: '#8fd060',
    accentSoft: 'rgba(143,208,96,0.16)',
    success: '#76c76b',
    warning: '#f0a04b',
    divider: 'rgba(255,255,255,0.09)',
    inverse: '#050505',
  },
  light: {
    mode: 'light',
    background: '#f7f4ed',
    paper: '#ffffff',
    surface: '#f0ece3',
    surfaceSoft: '#e7e1d5',
    textPrimary: '#1f2528',
    textSecondary: '#687076',
    primary: '#1f2528',
    primaryDark: '#111416',
    primaryLight: '#394145',
    accent: '#2f8f64',
    accentSoft: 'rgba(47,143,100,0.14)',
    success: '#2f8f64',
    warning: '#a05d22',
    divider: 'rgba(31,37,40,0.12)',
    inverse: '#ffffff',
  },
}
