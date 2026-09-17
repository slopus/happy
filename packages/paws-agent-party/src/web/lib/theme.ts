/**
 * Theme handling without the site's cookie ThemeProvider: the chosen scheme is stored in localStorage and applied as a
 * `.light` / `.dark` class on <html>. The token CSS drives colours off `color-scheme` (via `light-dark()`), which those
 * classes set. No stored preference ⇒ follow the OS.
 */

export type Scheme = 'light' | 'dark'

const KEY = 'ap-theme'

const systemScheme = (): Scheme =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

export const getStoredScheme = (): Scheme | null => {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

/** The scheme actually showing right now (stored preference, else the OS). */
export const getScheme = (): Scheme => getStoredScheme() ?? systemScheme()

export const applyStoredTheme = (): void => {
  const stored = getStoredScheme()
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  if (stored) {
    root.classList.add(stored)
  }
}

export const setScheme = (scheme: Scheme): void => {
  try {
    localStorage.setItem(KEY, scheme)
  } catch {
    /* storage unavailable — theme just won't persist */
  }
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(scheme)
}

export const toggleScheme = (): Scheme => {
  const next: Scheme = getScheme() === 'dark' ? 'light' : 'dark'
  setScheme(next)
  return next
}
