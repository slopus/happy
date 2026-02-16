/**
 * useVoiceInput Hook
 *
 * Platform-specific implementations:
 * - useVoiceInput.native.ts - iOS/Android using react-native-audio-api
 * - useVoiceInput.web.ts - Web using MediaRecorder API
 *
 * This file serves as a fallback and re-exports the web implementation.
 */

export * from './useVoiceInput.web';
