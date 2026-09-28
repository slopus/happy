# DreamSkin PC Web Implementation Plan

> **For agentic workers:** Use the approved design in `docs/superpowers/specs/2026-09-27-dreamskin-pc-experience-design.md`. Implement on the sibling worktree only. PC Web is the supported target; keep mobile and existing Paws theme preferences unchanged.

## Goal and boundaries

Add an opt-in, device-local “休闲室内居家” desktop skin that retains all current Paws controls, session virtualization, right panel, and theme settings. A single photo canvas creates the home and session atmosphere. Reading material, tool logs, input, dialogs, file/diff and data-heavy routes remain legible. Switching off restores the saved `themePack` and `themePreference`.

The source DreamSkin ZIP is design input, not CSS to inject. Its image distribution license must be resolved before publishing the asset; implementation and local verification can use the research copy. Do not merge or deploy an unlicensed image.

## File map

- `sources/sync/localSettings.ts`, `sources/sync/persistence.ts`, `sources/unistyles.ts`: persisted `desktopSkinId` and startup/runtime theme resolution.
- `sources/themePacks.ts`, `sources/desktopSkin.ts`: DreamSkin semantic palette and PC-only material/asset parameters.
- `sources/app/(app)/settings/appearance.tsx`: opt-in skin selector with a clear off state and original theme controls intact.
- `sources/components/DesktopSkinCanvas.web.tsx`: one photo layer, overlay gradients and no-image fallback; other platforms get a no-op companion file if needed.
- `sources/components/SidebarNavigator.tsx`, `sources/components/SidebarView.tsx`: consistent desktop canvas and translucent navigation only when skin is active.
- `sources/components/ComposeHome.tsx`, `sources/-session/SessionView.tsx`: home composition and session reading surface; no changes to message identity, list geometry, tool grouping, send logic or sidebar width calculations.
- Focused tests next to the affected theme, settings and layout files; actual visual and interaction verification on the local Web build.

## Tasks

### 1. Resolve and persist the skin

Add `desktopSkinId: 'default' | 'dreamskin'` with default `default`. Introduce a `dreamskinDark` Unistyles theme using the ZIP palette and explicit Paws semantic surface mappings. At Web startup and on every theme change, choose it only when the skin is active; selecting another `themePack` or changing `themePreference` must keep those values for later restoration. Add focused tests for parse/default, non-default dark interactive surfaces, startup/theme switching and platform boundary. Commit after checks pass.

### 2. Add the appearance control and asset adapter

Place a PC Web skin selector in Appearance with a preview, active state and an off choice. Keep the existing palette/mascot controls and define their relationship to the active skin explicitly. Record the source manifest, hashes and attribution; provide a deterministic validation/import script that reads the downloaded package without executing CSS. Integrate a licensed photo asset only after provenance is acceptable. Test toggle persistence and the old theme restoration. Commit.

### 3. Establish the desktop photo and navigation materials

Mount one noninteractive photo canvas behind desktop content. Make the rail and secondary sidebar use skin-specific dark translucent material while keeping existing row hover/pressed/selected tokens. Other routes use a solid deep background. Ensure fallback and reduced-transparency behavior. Verify navigation, pinned/hover sidebar and resize at existing width constraints. Commit.

### 4. Restyle home and session without altering business flow

Home: keep `ComposeHome` controls and all busy/recovery states, shift greeting and composer to the approved visual axis with height-aware fallback, and quiet particles over the photo. Session: fix photo below the virtualized transcript, add the approved left-to-right translucent reading surface, and retain opaque tool/code/composer and right-panel surfaces. Use actual main width and right-panel state for portrait suppression. Preserve headers, avatar/share/pin and all tool-group actions. Run targeted component tests and source-level regression checks after each subchange. Commit.

### 5. Validate, review and deliver

Run theme/local settings tests, relevant home/session/sidebar tests, typecheck and Web export. Verify real PC routes and interactions via Ego browser at wide and constrained widths, including H1/H2, S2/S3/S8 and right-panel state. Compare against the prechange base. Obtain an independent code review and fix confirmed issues. Document license status and remaining risks, then create a PR; no merge or production deployment without the separately required approval/checks.
