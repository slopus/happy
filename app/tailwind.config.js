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
      },
    },
    plugins: [],
  }