import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import {
  STUDIO_THEME_STORAGE_KEY,
  applyStudioThemeVariables,
  createStudioTheme,
  normalizeStudioThemeId,
  type StudioThemeId,
} from './studioTheme'

interface StudioThemeContextValue {
  themeId: StudioThemeId
  setThemeId: (themeId: StudioThemeId) => void
}

const StudioThemeContext = createContext<StudioThemeContextValue | null>(null)

export function StudioThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeIdState] = useState<StudioThemeId>(() => {
    if (typeof window === 'undefined') return 'dark'
    const stored = window.localStorage.getItem(STUDIO_THEME_STORAGE_KEY)
    return normalizeStudioThemeId(stored)
  })

  const theme = useMemo(() => createStudioTheme(themeId), [themeId])

  const setThemeId = (nextThemeId: StudioThemeId) => {
    document.documentElement.classList.add('studio-theme-transition')
    setThemeIdState(nextThemeId)
    window.localStorage.setItem(STUDIO_THEME_STORAGE_KEY, nextThemeId)
    window.setTimeout(() => {
      document.documentElement.classList.remove('studio-theme-transition')
    }, 420)
  }

  useEffect(() => {
    applyStudioThemeVariables(themeId)
    window.localStorage.setItem(STUDIO_THEME_STORAGE_KEY, themeId)
  }, [themeId])

  const value = useMemo(() => ({ themeId, setThemeId }), [themeId])

  return (
    <StudioThemeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </StudioThemeContext.Provider>
  )
}

export function useStudioTheme() {
  const context = useContext(StudioThemeContext)
  if (!context) throw new Error('useStudioTheme must be used within StudioThemeProvider')
  return context
}
