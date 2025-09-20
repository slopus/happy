/**
 * Desktop window sizing utilities for Happy Coder
 * Handles automatic window sizing based on screen resolution and user preferences
 */

import { Dimensions, Platform } from 'react-native';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';

export interface ScreenResolution {
  width: number;
  height: number;
  availableWidth: number;
  availableHeight: number;
}

export interface WindowSize {
  width: number;
  height: number;
  maximized: boolean;
}

/**
 * Get screen resolution information for desktop platforms
 * Returns null for non-desktop platforms
 */
export function getScreenResolution(): ScreenResolution | null {
  // Only provide resolution for web platform (desktop)
  if (Platform.OS !== 'web') {
    return null;
  }

  // In web context, we can access screen information
  if (typeof window !== 'undefined' && window.screen) {
    return {
      width: window.screen.width,
      height: window.screen.height,
      availableWidth: window.screen.availWidth,
      availableHeight: window.screen.availHeight,
    };
  }

  // Fallback to React Native Dimensions
  const screen = Dimensions.get('screen');
  const window_dims = Dimensions.get('window');

  return {
    width: screen.width,
    height: screen.height,
    availableWidth: window_dims.width,
    availableHeight: window_dims.height,
  };
}

/**
 * Calculate optimal window size for first launch
 * Uses 80% of available screen space
 */
export function calculateOptimalWindowSize(resolution: ScreenResolution): WindowSize {
  const targetWidth = Math.floor(resolution.availableWidth * 0.8);
  const targetHeight = Math.floor(resolution.availableHeight * 0.8);

  // Minimum sizes for usability
  const minWidth = 1024;
  const minHeight = 768;

  // Maximum reasonable sizes
  const maxWidth = 1920;
  const maxHeight = 1080;

  return {
    width: Math.max(minWidth, Math.min(maxWidth, targetWidth)),
    height: Math.max(minHeight, Math.min(maxHeight, targetHeight)),
    maximized: false,
  };
}

/**
 * Get preferred window size from settings or calculate optimal size
 */
export function getPreferredWindowSize(): WindowSize | null {
  const resolution = getScreenResolution();
  if (!resolution) {
    return null; // Not a desktop platform
  }

  const settings = storage.getState().settings;

  // If user has set preferences, use them
  if (settings.desktopWindowWidth && settings.desktopWindowHeight) {
    return {
      width: settings.desktopWindowWidth,
      height: settings.desktopWindowHeight,
      maximized: settings.desktopWindowMaximized,
    };
  }

  // First launch - calculate optimal size
  return calculateOptimalWindowSize(resolution);
}

/**
 * Save window size preferences to settings
 */
export function saveWindowSizePreferences(windowSize: WindowSize): void {
  // Only save for desktop platforms
  if (Platform.OS !== 'web') {
    return;
  }

  sync.applySettings({
    desktopWindowWidth: windowSize.width,
    desktopWindowHeight: windowSize.height,
    desktopWindowMaximized: windowSize.maximized,
  });
}

/**
 * Apply window sizing on desktop startup
 * Should be called when the app initializes on desktop
 */
export function applyDesktopWindowSizing(): void {
  // Only apply on web platform (desktop)
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return;
  }

  const preferredSize = getPreferredWindowSize();
  if (!preferredSize) {
    return;
  }

  try {
    if (preferredSize.maximized) {
      // Try to maximize if supported
      if (window.screen && 'orientation' in window.screen) {
        // Modern browsers might support fullscreen
        document.documentElement.requestFullscreen?.();
      }
    } else {
      // Try to resize window if supported (mainly for Electron-like environments)
      if (window.resizeTo) {
        window.resizeTo(preferredSize.width, preferredSize.height);
      }

      // Try to center the window
      if (window.moveTo && window.screen) {
        const x = Math.floor((window.screen.availWidth - preferredSize.width) / 2);
        const y = Math.floor((window.screen.availHeight - preferredSize.height) / 2);
        window.moveTo(x, y);
      }
    }
  } catch (error) {
    console.warn('[DesktopWindow] Could not apply window sizing:', error);
  }
}

/**
 * Monitor window resize events and save user preferences
 * Should be called once during app initialization
 */
export function initializeWindowSizeMonitoring(): () => void {
  // Only monitor on web platform (desktop)
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return () => {}; // Return empty cleanup function
  }

  let resizeTimeout: any;

  const handleResize = () => {
    // Debounce resize events to avoid excessive saves
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      const isMaximized = window.outerWidth === window.screen.availWidth &&
                         window.outerHeight === window.screen.availHeight;

      saveWindowSizePreferences({
        width: window.outerWidth,
        height: window.outerHeight,
        maximized: isMaximized,
      });
    }, 1000); // Wait 1 second after resize stops
  };

  window.addEventListener('resize', handleResize);

  // Cleanup function
  return () => {
    window.removeEventListener('resize', handleResize);
    clearTimeout(resizeTimeout);
  };
}

/**
 * Get current window information for debugging
 */
export function getWindowInfo(): any {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return { platform: Platform.OS, available: false };
  }

  return {
    platform: Platform.OS,
    available: true,
    current: {
      width: window.innerWidth,
      height: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
    },
    screen: {
      width: window.screen?.width,
      height: window.screen?.height,
      availWidth: window.screen?.availWidth,
      availHeight: window.screen?.availHeight,
    },
    calculated: getPreferredWindowSize(),
  };
}