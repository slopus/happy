import { ScrollViewStyleReset } from 'expo-router/html';
import '../unistyles';

// This file is web-only and used to configure the root HTML for every
// web page during static rendering.
// The contents of this function only run in Node.js environments and
// do not have access to the DOM or browser APIs.
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
        {/* Theme color — StatusBarProvider.tsx updates this dynamically to match the app theme. */}
        <meta id="theme-color" name="theme-color" content="#1A1A1D" />
        {/* black-translucent: status bar is transparent in PWA mode, web content extends
            behind it. The app's header paddingTop (safe area inset) fills the space with
            the correct theme color. This avoids iOS PWA state bugs where the status bar
            text color gets stuck after switching between home screen apps. */}
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />

        {/*
          Disable body scrolling on web. This makes ScrollView components work closer to how they do on native.
          However, body scrolling is often nice to have for mobile web. If you want to enable it, remove this line.
        */}
        <ScrollViewStyleReset />

        {/* Using raw CSS styles as an escape-hatch to ensure the background color never flickers in dark-mode. */}
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
        {/* Add any additional <head> elements that you want globally available on web... */}
      </head>
      <body>{children}</body>
    </html>
  );
}

// Anti-flicker CSS — raw hex required (runs before React).
// Light: palette.neutral.gray50 (#ECECF0), Dark: palette.neutral.gray950 (#1A1A1D)
const responsiveBackground = `
body {
  background-color: #ECECF0;
}
@media (prefers-color-scheme: dark) {
  body {
    background-color: #1A1A1D;
  }
}`;
