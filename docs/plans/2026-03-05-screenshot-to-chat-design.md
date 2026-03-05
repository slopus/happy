# Screenshot to Chat — Design

## Goal
Add a 📷 button to Preview toolbar that captures a screenshot of the current page via Puppeteer on the CLI and attaches it to the next chat message as an image. Claude sees the screenshot visually.

## Flow
1. User clicks 📷 in PreviewToolbar
2. App sends RPC `preview:screenshot { url, width?, height? }` to CLI
3. CLI launches headless Chrome via `puppeteer-core`, navigates to URL, calls `page.screenshot()`
4. CLI returns `{ success, base64, width, height }`
5. App adds image to `pendingImages` (existing attachment system)
6. Thumbnail chip appears above input field
7. User types message + sends → `sync.sendMessage(text, images)` — already works
8. Claude receives screenshot + text

## Architecture

### CLI: `screenshotService.ts`
- Uses `puppeteer-core` with existing Chrome binary (installed by Playwright MCP)
- Lazy browser launch, reuses single instance across requests
- `takeScreenshot(url, viewport?)` → `{ base64: string, width: number, height: number }`
- Default viewport: 1280×800
- Timeout: 10s
- Graceful cleanup on process exit

### CLI: `registerPreviewHandlers.ts`
- New RPC handler `preview:screenshot`
- Request: `{ url: string, width?: number, height?: number }`
- Response: `{ success: boolean, base64?: string, width?: number, height?: number, error?: string }`

### App: `PreviewToolbar.tsx`
- New `onScreenshot` prop
- Camera icon button between inspect and refresh buttons
- Loading state while screenshot is in progress

### App: `PreviewPanel.tsx` / `.web.tsx`
- `handleScreenshot` callback → RPC call → passes result up via `onScreenshot` prop
- Loading state management

### App: `SessionView.tsx`
- Receives screenshot → adds to `pendingImages` state (same as file attachment)
- Existing attachment UI shows thumbnail + remove button

## Files to change
1. `happy-cli/package.json` — add `puppeteer-core`
2. **NEW** `happy-cli/src/modules/preview/screenshotService.ts`
3. `happy-cli/src/modules/preview/registerPreviewHandlers.ts` — add handler
4. `happy-wire/src/previewTypes.ts` — add types
5. `happy-app/components/preview/PreviewToolbar.tsx` — add button
6. `happy-app/components/preview/PreviewPanel.tsx` — add handler
7. `happy-app/components/preview/PreviewPanel.web.tsx` — add handler
8. `happy-app/-session/SessionView.tsx` — wire to pendingImages

## Dependencies
- `puppeteer-core` (~2MB, no bundled Chrome)
- Chrome binary from Playwright MCP at standard path
