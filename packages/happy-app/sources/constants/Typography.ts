import { Platform } from 'react-native';

/**
 * Typography system for Happy Coder app
 *
 * Default typography: IBM Plex Sans (switchable via setFontPreference)
 * Monospace typography: IBM Plex Mono
 * Logo typography: Bricolage Grotesque (specific use only)
 *
 * Font preferences (web only):
 * - 'plex'   — IBM Plex Sans (default, bundled)
 * - 'system' — SF Pro / -apple-system (native Apple feel)
 * - 'inter'  — Inter (modern UI, loaded from Google Fonts)
 * - 'geist'  — Geist Sans (Vercel, loaded from Google Fonts)
 */

// ============ Font Preference (web only) ============

export type FontPreference = 'plex' | 'system' | 'inter' | 'geist';

let _fontPreference: FontPreference = 'plex';

// Load from localStorage on init (web only)
if (typeof localStorage !== 'undefined') {
  try {
    const stored = localStorage.getItem('learn_font');
    if (stored === 'system' || stored === 'inter' || stored === 'geist' || stored === 'plex') {
      _fontPreference = stored;
    }
  } catch {}
}

// Listeners for reactivity
const _listeners = new Set<() => void>();

export function getFontPreference(): FontPreference {
  return _fontPreference;
}

export function setFontPreference(pref: FontPreference) {
  if (_fontPreference === pref) return;
  _fontPreference = pref;
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem('learn_font', pref); } catch {}
  }
  // Load web font
  if (Platform.OS === 'web') {
    _ensureWebFont(pref);
  }
  // Notify listeners
  _listeners.forEach(fn => fn());
}

export function subscribeFontPreference(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

// Web font loading
const _loadedFonts = new Set<string>();

function _ensureWebFont(pref: FontPreference) {
  if (Platform.OS !== 'web') return;
  if (pref === 'plex' || pref === 'system') return; // Already available
  if (_loadedFonts.has(pref)) return;
  _loadedFonts.add(pref);

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  if (pref === 'inter') {
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap';
  } else if (pref === 'geist') {
    link.href = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap';
  }
  document.head.appendChild(link);
}

// No CSS override needed — Typography.default() reads _fontPreference directly.
// Page reload on font change ensures all components pick up the new font.

// Load on init if needed
if (Platform.OS === 'web') {
  _ensureWebFont(_fontPreference);
}

// ============ Font family mappings per preference ============

const _webFontFamilies: Record<FontPreference, { regular: string; semiBold: string; italic: string }> = {
  plex: {
    regular: 'IBMPlexSans-Regular',
    italic: 'IBMPlexSans-Italic',
    semiBold: 'IBMPlexSans-SemiBold',
  },
  system: {
    regular: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif',
    italic: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif',
    semiBold: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  inter: {
    regular: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
    italic: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
    semiBold: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
  },
  geist: {
    regular: '"Geist", -apple-system, BlinkMacSystemFont, sans-serif',
    italic: '"Geist", -apple-system, BlinkMacSystemFont, sans-serif',
    semiBold: '"Geist", -apple-system, BlinkMacSystemFont, sans-serif',
  },
};

const _webFontWeights: Record<FontPreference, { regular: string; italic: string; semiBold: string }> = {
  plex: { regular: 'normal', italic: 'normal', semiBold: 'normal' }, // Weight baked into font file
  system: { regular: '400', italic: '400', semiBold: '600' },
  inter: { regular: '400', italic: '400', semiBold: '600' },
  geist: { regular: '400', italic: '400', semiBold: '600' },
};

// Font family constants
export const FontFamilies = {
  // IBM Plex Sans (default typography)
  default: {
    regular: 'IBMPlexSans-Regular',
    italic: 'IBMPlexSans-Italic',
    semiBold: 'IBMPlexSans-SemiBold',
  },

  // IBM Plex Mono (default monospace)
  mono: {
    regular: 'IBMPlexMono-Regular',
    italic: 'IBMPlexMono-Italic',
    semiBold: 'IBMPlexMono-SemiBold',
  },

  // Bricolage Grotesque (logo/special use only)
  logo: {
    bold: 'BricolageGrotesque-Bold',
  },

  // Audiowide (brand logo - 304.SYSTEMS)
  brand: {
    regular: 'Audiowide-Regular',
  },

  // Legacy fonts (keep for backward compatibility)
  legacy: {
    spaceMono: 'SpaceMono',
    systemMono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  }
};

// Helper functions for easy access to font families
export const getDefaultFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
  if (Platform.OS === 'web' && _fontPreference !== 'plex') {
    return _webFontFamilies[_fontPreference][weight];
  }
  return FontFamilies.default[weight];
};

export const getMonoFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
  return FontFamilies.mono[weight];
};

export const getLogoFont = () => {
  return FontFamilies.logo.bold;
};

// Font weight mappings for the font families
export const FontWeights = {
  regular: '400',
  semiBold: '600',
  bold: '700',
} as const;

// Style utilities for easy inline usage
export const Typography = {
  // Default font styles (respects font preference on web)
  default: (weight: 'regular' | 'italic' | 'semiBold' | 'medium' | 'bold' = 'regular') => {
    const w = weight === 'medium' ? 'semiBold' : weight === 'bold' ? 'semiBold' : weight;
    if (Platform.OS === 'web' && _fontPreference !== 'plex') {
      return {
        fontFamily: _webFontFamilies[_fontPreference][w],
        fontWeight: _webFontWeights[_fontPreference][w],
        ...(weight === 'italic' ? { fontStyle: 'italic' as const } : {}),
      };
    }
    return {
      fontFamily: getDefaultFont(w),
    };
  },

  // Monospace font styles (IBM Plex Mono, not affected by preference)
  mono: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
    fontFamily: getMonoFont(weight),
  }),

  // Logo font style (Bricolage Grotesque)
  logo: () => ({
    fontFamily: getLogoFont(),
  }),

  // Brand font style (Audiowide - 304.SYSTEMS)
  brand: () => ({
    fontFamily: FontFamilies.brand.regular,
  }),

  // Header text style
  header: () => ({
    fontFamily: getDefaultFont('semiBold'),
    ...(Platform.OS === 'web' && _fontPreference !== 'plex' ? { fontWeight: '600' } : {}),
  }),

  // Body text style
  body: () => ({
    fontFamily: getDefaultFont('regular'),
  }),

  // Legacy font styles (for backward compatibility)
  legacy: {
    spaceMono: () => ({
      fontFamily: FontFamilies.legacy.spaceMono,
    }),
    systemMono: () => ({
      fontFamily: FontFamilies.legacy.systemMono,
    }),
  }
}; 