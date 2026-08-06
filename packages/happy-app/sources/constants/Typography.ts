import { Platform } from 'react-native';

/**
 * Typography system for Paws app
 * 
 * Default typography: IBM Plex Sans on native, system UI stack on web
 * Monospace typography: IBM Plex Mono  
 * Logo typography: Bricolage Grotesque (specific use only)
 * 
 * Usage Examples:
 * 
 * // Default typography (IBM Plex Sans)
 * <Text style={{ fontSize: 16, ...Typography.default() }}>Regular text</Text>
 * <Text style={{ fontSize: 16, ...Typography.default('italic') }}>Italic text</Text>
 * <Text style={{ fontSize: 16, ...Typography.default('semiBold') }}>Semi-bold text</Text>
 * 
 * // Monospace typography (IBM Plex Mono)
 * <Text style={{ fontSize: 14, ...Typography.mono() }}>Code text</Text>
 * <Text style={{ fontSize: 14, ...Typography.mono('italic') }}>Italic code</Text>
 * <Text style={{ fontSize: 14, ...Typography.mono('semiBold') }}>Bold code</Text>
 * 
 * // Logo typography (Bricolage Grotesque - use sparingly!)
 * // Note: Don't add fontWeight as this font is already bold
 * <Text style={{ fontSize: 28, ...Typography.logo() }}>Logo Text</Text>
 * 
 * // Alternative direct usage
 * <Text style={{ fontSize: 16, fontFamily: getDefaultFont('semiBold') }}>Direct usage</Text>
 * <Text style={{ fontSize: 14, fontFamily: getMonoFont() }}>Direct mono usage</Text>
 * <Text style={{ fontSize: 28, fontFamily: getLogoFont() }}>Direct logo usage</Text>
 */

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

  // Fredoka (Paws 圆萌展示字体 — 标题 / 品牌字标。注：仅含拉丁字形，
  // 中文会回退到系统字体，故只用在标题这类「中英混排、英文要出彩」的场景)
  display: {
    semiBold: 'Fredoka-SemiBold',
    bold: 'Fredoka-Bold',
  },
  
  // Legacy fonts (keep for backward compatibility)
  legacy: {
    spaceMono: 'SpaceMono',
    systemMono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  }
};

// Web uses the platform UI family so Latin and CJK glyphs come from one
// coherent system stack. Native keeps the bundled IBM Plex family.
export const WEB_DEFAULT_FONT_FAMILY = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

// Helper functions for easy access to font families
export const getDefaultFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
  return Platform.OS === 'web' ? WEB_DEFAULT_FONT_FAMILY : FontFamilies.default[weight];
};

export const getMonoFont = (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => {
  return FontFamilies.mono[weight];
};

export const getLogoFont = () => {
  return FontFamilies.logo.bold;
};

export const getDisplayFont = (weight: 'semiBold' | 'bold' = 'semiBold') => {
  return FontFamilies.display[weight];
};

// Font weight mappings for the font families
export const FontWeights = {
  regular: '400',
  semiBold: '600', 
  bold: '700',
} as const;

type DefaultTypographyStyle = {
  fontFamily: string;
  fontStyle?: 'italic';
  fontWeight?: '600';
};

function getDefaultTypographyStyle(weight: 'regular' | 'italic' | 'semiBold' = 'regular'): DefaultTypographyStyle {
  const style: DefaultTypographyStyle = { fontFamily: getDefaultFont(weight) };
  if (Platform.OS !== 'web') return style;

  if (weight === 'semiBold') style.fontWeight = FontWeights.semiBold;
  if (weight === 'italic') style.fontStyle = 'italic';
  return style;
}

// Style utilities for easy inline usage
export const Typography = {
  // Default font styles (IBM Plex Sans on native, system UI stack on web)
  default: getDefaultTypographyStyle,
  
  // Monospace font styles (IBM Plex Mono)
  mono: (weight: 'regular' | 'italic' | 'semiBold' = 'regular') => ({
    fontFamily: getMonoFont(weight),
  }),
  
  // Logo font style (Bricolage Grotesque)
  logo: () => ({
    fontFamily: getLogoFont(),
  }),

  // Display font style (Fredoka 圆萌 — 标题 / 品牌字标)
  display: (weight: 'semiBold' | 'bold' = 'semiBold') => ({
    fontFamily: getDisplayFont(weight),
  }),
  
  // Header text style
  header: () => getDefaultTypographyStyle('semiBold'),
  
  // Body text style
  body: () => getDefaultTypographyStyle('regular'),
  
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
