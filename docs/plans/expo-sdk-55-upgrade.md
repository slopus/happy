# Expo SDK 55 Upgrade

## Status: Next native submission

Current: SDK 54 / RN 0.81.4 / React 19.1. Last SDK 54 builds submitted 2026-03-22.
Target: SDK 55 / RN 0.83 / React 19.2.

RN 0.81 is out of the 3-version support window (0.82, 0.83, 0.84 supported). SDK 54 is "previous" — SDK 55 is current stable since Feb 2026.

## What we're excited about

- **react-native-keyboard-controller 1.21** — `KeyboardChatScrollView`, cross-platform `contentInset`. 400+ likes on Twitter. Direct win for our chat UI.
- **Expo Router v7** — Liquid Glass tab bar, Apple Zoom transitions, declarative headers, Stack.Toolbar API
- **75% smaller OTA updates** — Hermes bytecode diffing. Huge for our frequent preview OTAs.
- **React 19.2** — `<Activity>` component (keep off-screen components alive), `useEffectEvent`

## Other notable changes in SDK 55

- New Architecture is now **mandatory** (Legacy Arch removed, `newArchEnabled` flag gone)
- Unified package versioning (all expo-* packages = 55.x.x)
- expo-blur uses RenderNode API on Android 12+ (cheaper blurs)
- expo-widgets — iOS home screen widgets without native code
- Jetpack Compose beta — Material3 components
- expo-brownfield package for mixed-codebase apps
- expo-av removed from Expo Go (we use expo-audio, so fine)

## Upgrade order

1. Safe patches first (reanimated 4.2.3, livekit, socket.io, zustand) — no native rebuild
2. JS-only minors (flash-list 2.3, posthog, purchases) — no native rebuild
3. **Expo SDK 54 -> 55** via `npx expo install --fix` — native rebuild required
4. keyboard-controller 1.21, skia 2.5.3, unistyles 3.1.1, gesture-handler 2.30
5. Major migrations last: zod 4, react-native-mmkv 4 (independent, breaking API changes)

## Watch out for

- **react-native-screens v4.24** has iOS build issues (`undeclared identifier RNSBottomTabsScreenComponentView`). Pin to tested version.
- **expo-notifications** still buggy — headless background tasks fail when terminated (both platforms), Android channels ignored in background. No fix in SDK 55.
- **expo-blur** now requires `<BlurTargetView>` wrapper — breaking change
- **@expo/ui renames** — DateTimePicker->DatePicker, Switch->Toggle, CircularProgress->ProgressView
- **Hermes v1 opt-in** available but forces build-from-source (slower builds). Wait for SDK 56 / RN 0.84 where prebuilt binaries + Hermes v1 work together.
- **vision-camera** — slow maintenance, pin 4.7.3

## Version snapshot (current -> target)

| Package | Current | Target |
|---|---|---|
| expo | 54.0.0 | 55.0.8 |
| react-native | 0.81.4 | 0.83.1 |
| react | 19.1.0 | 19.2.4 |
| keyboard-controller | 1.18.5 | 1.21.1 |
| flash-list | 2.0.2 | 2.3.0 |
| react-native-skia | 2.2.12 | 2.5.3 |
| react-native-screens | 4.16.0 | 4.22+ (avoid 4.24) |
| purchases | 9.4.2 | 9.14.0 |
| posthog | 4.16.2 | 4.37.5 |
