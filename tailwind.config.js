const { hairlineWidth } = require('nativewind/theme');

/** @type {import('tailwindcss').Config} */
module.exports = {
    // NOTE: Update this to include the paths to all files that contain Nativewind classes.
    content: ["./sources/components/**/*.{js,jsx,ts,tsx}", "./sources/app/**/*.{ts,tsx}"],
    presets: [require("nativewind/preset")],
    theme: {
      extend: {
        borderWidth: {
            hairline: hairlineWidth,
        },
        fontFamily: {
          // Default sans-serif (IBM Plex Sans)
          'sans': ['IBMPlexSans-Regular'],
          'sans-italic': ['IBMPlexSans-Italic'],
          'sans-semibold': ['IBMPlexSans-SemiBold'],
          
          // Monospace fonts (IBM Plex Mono)
          'mono': ['IBMPlexMono-Regular'],
          'mono-italic': ['IBMPlexMono-Italic'],
          'mono-semibold': ['IBMPlexMono-SemiBold'],
          
          // Logo font (Bricolage Grotesque)
          'logo': ['BricolageGrotesque-Bold'],
          
          // Legacy fonts for backward compatibility
          'space-mono': ['SpaceMono'],
          
          // If you want a dedicated italic family (alternative approach)
          'italic': ['IBMPlexSans-Italic'],
        },
      },
    },
    plugins: [],
  }