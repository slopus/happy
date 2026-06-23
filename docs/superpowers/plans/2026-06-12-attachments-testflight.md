# Attachments (Camera + Files) + Local TestFlight Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Happy's existing image-attachment pipeline with camera capture, file/PDF attachments, and HEIC/size normalization; then ship a personal iOS TestFlight build that bundles PRs #1372, #1373, and this feature.

**Architecture:** Upstream main already has the full image pipeline (app picker → encrypted server blob → `t:'file'` session event → CLI download/decrypt → SDK `image` content block), gated by the `expImageUpload` setting. We extend the edges only: app-side capture sources + normalization, CLI-side non-image content-block conversion. TestFlight ships from a local integration branch via headless xcodebuild + ASC API key.

**Tech Stack:** Expo SDK 55 (expo-image-picker, expo-image-manipulator, expo-document-picker — all already in package.json), vitest, @anthropic-ai/sdk content blocks, xcodebuild + altool.

**Conventions (from packages/happy-app/CLAUDE.md):** 4-space indent, `t(...)` for ALL user-visible strings added to ALL 10 translation files, `Modal` from `@/modal` (never RN Alert), `pnpm` only, run `pnpm typecheck` after app changes. Commit messages end with the Happy/Claude co-author block:

```
Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
```

**Branch:** all Phase A tasks on `feat/attachments` (already exists, off upstream/main). Phase B on `local/testflight`.

**Working dir:** `/Users/jlixfeld/Code/happy`.

---

## Phase A — feature (upstream PR)

### Task 1: Image normalization decision logic (pure function)

**Files:**
- Create: `packages/happy-app/sources/utils/attachmentNormalize.ts`
- Test: `packages/happy-app/sources/utils/attachmentNormalize.spec.ts`

The CLI drops any attachment whose bytes aren't JPEG/PNG/GIF/WebP (`claudeRemoteLauncher.ts:358` skips HEIC silently). The Claude API also caps images at 5 MB and downscales anything over 1568 px long edge. Normalize app-side, before upload.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/happy-app/sources/utils/attachmentNormalize.spec.ts
import { describe, it, expect } from 'vitest';
import { planImageNormalization, CLAUDE_VISION_MAX_EDGE } from './attachmentNormalize';

describe('planImageNormalization', () => {
    it('passes through a small JPEG untouched', () => {
        expect(planImageNormalization({ mimeType: 'image/jpeg', width: 800, height: 600 }))
            .toEqual({ action: 'passthrough' });
    });

    it('converts HEIC to JPEG', () => {
        expect(planImageNormalization({ mimeType: 'image/heic', width: 800, height: 600 }))
            .toEqual({ action: 'normalize', resize: undefined });
    });

    it('downscales an oversized JPEG to 1568px long edge (landscape)', () => {
        expect(planImageNormalization({ mimeType: 'image/jpeg', width: 4032, height: 3024 }))
            .toEqual({ action: 'normalize', resize: { width: CLAUDE_VISION_MAX_EDGE } });
    });

    it('downscales an oversized PNG to 1568px long edge (portrait)', () => {
        expect(planImageNormalization({ mimeType: 'image/png', width: 3024, height: 4032 }))
            .toEqual({ action: 'normalize', resize: { height: CLAUDE_VISION_MAX_EDGE } });
    });

    it('passes through supported formats at exactly the ceiling', () => {
        expect(planImageNormalization({ mimeType: 'image/webp', width: 1568, height: 1000 }))
            .toEqual({ action: 'passthrough' });
    });

    it('normalizes unknown/missing mime types defensively', () => {
        expect(planImageNormalization({ mimeType: undefined, width: 800, height: 600 }))
            .toEqual({ action: 'normalize', resize: undefined });
    });

    it('treats zero dimensions as unknown size — converts format only', () => {
        expect(planImageNormalization({ mimeType: 'image/heic', width: 0, height: 0 }))
            .toEqual({ action: 'normalize', resize: undefined });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/happy-app && pnpm vitest run sources/utils/attachmentNormalize.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/happy-app/sources/utils/attachmentNormalize.ts
/**
 * Decides whether a picked image needs normalization before upload.
 *
 * The CLI converts attachments to Claude API image blocks by magic-byte
 * sniffing and SKIPS anything that isn't JPEG/PNG/GIF/WebP — iOS HEIC would
 * be silently dropped. The Claude vision API also downscales anything over
 * 1568px long edge server-side and rejects images over 5MB, so uploading
 * larger is pure waste. Pure function — tested in attachmentNormalize.spec.ts.
 */

export const CLAUDE_VISION_MAX_EDGE = 1568;
export const NORMALIZE_JPEG_QUALITY = 0.9;

const CLAUDE_SUPPORTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export type NormalizationPlan =
    | { action: 'passthrough' }
    | { action: 'normalize'; resize: { width: number } | { height: number } | undefined };

export function planImageNormalization(input: {
    mimeType: string | undefined;
    width: number;
    height: number;
}): NormalizationPlan {
    const supported = input.mimeType !== undefined && CLAUDE_SUPPORTED_MIMES.has(input.mimeType);
    const longEdge = Math.max(input.width, input.height);
    const oversized = longEdge > CLAUDE_VISION_MAX_EDGE;

    if (supported && !oversized) {
        return { action: 'passthrough' };
    }

    let resize: { width: number } | { height: number } | undefined = undefined;
    if (oversized) {
        resize = input.width >= input.height
            ? { width: CLAUDE_VISION_MAX_EDGE }
            : { height: CLAUDE_VISION_MAX_EDGE };
    }
    return { action: 'normalize', resize };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/happy-app && pnpm vitest run sources/utils/attachmentNormalize.spec.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-app/sources/utils/attachmentNormalize.ts packages/happy-app/sources/utils/attachmentNormalize.spec.ts
git commit -m "feat(app): image normalization decision logic for attachments"
```

---

### Task 2: Native normalization executor (expo-image-manipulator)

**Files:**
- Modify: `packages/happy-app/sources/utils/attachmentNormalize.ts` (append function)

- [ ] **Step 1: Verify the expo-image-manipulator 55 API surface before writing code**

Run: `sed -n 1,80p packages/happy-app/node_modules/expo-image-manipulator/build/ImageManipulator.d.ts` and check for the object-context API (`ImageManipulator.manipulate(uri)` → context with `.resize()` / `.renderAsync()` / `.saveAsync()`), and the legacy `manipulateAsync` export. Use whichever the installed version documents as current; the code below assumes the SDK 52+ object API. If only `manipulateAsync(uri, actions, saveOptions)` exists, use that form instead with the same actions/options.

- [ ] **Step 2: Append the executor**

```typescript
// append to packages/happy-app/sources/utils/attachmentNormalize.ts
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/**
 * Applies a normalization plan to an image URI. Returns the (possibly new)
 * uri + dimensions + mime. Native + web (expo-image-manipulator supports both).
 * Not unit-tested — exercised manually; the decision logic above carries the tests.
 */
export async function normalizeImage(
    uri: string,
    plan: NormalizationPlan,
): Promise<{ uri: string; width: number; height: number; mimeType: string } | null> {
    if (plan.action === 'passthrough') return null;
    const context = ImageManipulator.manipulate(uri);
    if (plan.resize) {
        context.resize(plan.resize);
    }
    const image = await context.renderAsync();
    const result = await image.saveAsync({ format: SaveFormat.JPEG, compress: NORMALIZE_JPEG_QUALITY });
    return { uri: result.uri, width: result.width, height: result.height, mimeType: 'image/jpeg' };
}
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/happy-app && pnpm typecheck`
Expected: clean. (If the import shape differs per Step 1, adjust and re-run.)

- [ ] **Step 4: Commit**

```bash
git add packages/happy-app/sources/utils/attachmentNormalize.ts
git commit -m "feat(app): expo-image-manipulator normalization executor"
```

---

### Task 3: Wire normalization + camera + file picking into the picker hook

**Files:**
- Modify: `packages/happy-app/sources/hooks/useImagePicker.ts`

The hook currently exposes `{ selectedImages, pickImages, removeImage, clearImages, addImages }` (see file, 136 lines). Add `takePhoto` and `pickFiles`, and run every picked/captured image through normalization. Keep the existing name and signature — additive only.

- [ ] **Step 1: Extract the shared asset→preview conversion and add normalization**

Inside `useImagePicker`, above `pickImages`, add:

```typescript
    // Shared by gallery + camera: enforce size cap, normalize (HEIC→JPEG,
    // downscale >1568px — see attachmentNormalize.ts), generate thumbhash.
    const assetsToPreviews = useCallback(async (assets: ImagePicker.ImagePickerAsset[]): Promise<AttachmentPreview[]> => {
        const previews: AttachmentPreview[] = [];
        for (const asset of assets) {
            let { uri, width, height } = asset;
            let mimeType = asset.mimeType ?? undefined;
            let size = asset.fileSize ?? 0;

            const plan = planImageNormalization({ mimeType, width, height });
            const normalized = await normalizeImage(uri, plan).catch(() => null);
            if (normalized) {
                uri = normalized.uri;
                width = normalized.width;
                height = normalized.height;
                mimeType = normalized.mimeType;
                size = 0; // unknown after re-encode; server enforces the cap
            }

            if (size > MAX_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.fileName ?? 'image', maxMb: 10 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }

            const thumbhash = (width > 0 && height > 0)
                ? await generateThumbhash(uri, width, height)
                : undefined;

            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                uri,
                width,
                height,
                mimeType: mimeType ?? 'image/jpeg',
                size,
                name: asset.fileName ?? `image_${Date.now()}.jpg`,
                thumbhash,
            });
        }
        return previews;
    }, []);
```

Add imports at top: `import { planImageNormalization, normalizeImage } from '@/utils/attachmentNormalize';` and `import * as DocumentPicker from 'expo-document-picker';`.

Replace the body of the existing `for (const asset of assets)` loop in `pickImages` (lines 84–111) with a call to the shared helper:

```typescript
        const previews = await assetsToPreviews(assets);
```

(delete the now-redundant inline loop; keep the `remaining` clamp and the `setSelectedImages` tail unchanged; add `assetsToPreviews` to the `pickImages` dependency array.)

- [ ] **Step 2: Add `takePhoto`**

```typescript
    const takePhoto = useCallback(async () => {
        if (Platform.OS !== 'web') {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status !== 'granted') {
                Modal.alert(
                    t('imageUpload.cameraPermissionTitle'),
                    t('imageUpload.cameraPermissionMessage'),
                    [{ text: t('common.ok') }],
                );
                return;
            }
        }
        if (MAX_IMAGES_PER_MESSAGE - selectedCountRef.current <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
            return;
        }

        const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            quality: 1, // normalization handles size/format downstream
            exif: false,
        });
        if (result.canceled || !result.assets.length) return;

        const previews = await assetsToPreviews(result.assets);
        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, [assetsToPreviews]);
```

- [ ] **Step 3: Add `pickFiles`**

Files reuse the same `AttachmentPreview` shape with `width/height: 0` and no thumbhash — the existing upload path (`sync.ts uploadAttachmentsForSession`) and `t:'file'` event already carry `mimeType` and omit the `image` sub-object when dimensions are 0.

```typescript
    const pickFiles = useCallback(async () => {
        const remaining = MAX_IMAGES_PER_MESSAGE - selectedCountRef.current;
        if (remaining <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
            return;
        }

        const result = await DocumentPicker.getDocumentAsync({
            multiple: true,
            copyToCacheDirectory: true,
        });
        if (result.canceled || !result.assets.length) return;

        const previews: AttachmentPreview[] = [];
        for (const asset of result.assets.slice(0, remaining)) {
            const size = asset.size ?? 0;
            if (size > MAX_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.name, maxMb: 10 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }
            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                uri: asset.uri,
                width: 0,
                height: 0,
                mimeType: asset.mimeType ?? 'application/octet-stream',
                size,
                name: asset.name,
                thumbhash: undefined,
            });
        }
        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, []);
```

- [ ] **Step 4: Extend the result type and return**

```typescript
type UseImagePickerResult = {
    selectedImages: AttachmentPreview[];
    pickImages: () => Promise<void>;
    takePhoto: () => Promise<void>;
    pickFiles: () => Promise<void>;
    removeImage: (id: string) => void;
    clearImages: () => void;
    addImages: (images: AttachmentPreview[]) => void;
};
```

Return: `{ selectedImages, pickImages, takePhoto, pickFiles, removeImage, clearImages, addImages }`.

Update the hook's doc comment (lines 1–11) to mention camera + files.

- [ ] **Step 5: Typecheck + existing tests**

Run: `cd packages/happy-app && pnpm typecheck && pnpm vitest run`
Expected: clean / all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-app/sources/hooks/useImagePicker.ts
git commit -m "feat(app): camera capture and file picking in attachment hook"
```

---

### Task 4: Attachment-source chooser in SessionView

**Files:**
- Modify: `packages/happy-app/sources/-session/SessionView.tsx`
- Modify: `packages/happy-app/app.config.js`

- [ ] **Step 1: Replace the direct gallery call with a chooser**

In `SessionView.tsx`, the hook destructure becomes:

```typescript
    const { selectedImages, pickImages, takePhoto, pickFiles, removeImage, clearImages, addImages } = useImagePicker();
```

Below it, add (web keeps the direct file-picker behavior — paste/drag already covers images there, and a camera option is meaningless on desktop):

```typescript
    const handlePickAttachment = React.useCallback(() => {
        if (Platform.OS === 'web') {
            pickImages();
            return;
        }
        Modal.alert(t('imageUpload.addTitle'), undefined, [
            { text: t('imageUpload.optionLibrary'), onPress: () => { pickImages(); } },
            { text: t('imageUpload.optionCamera'), onPress: () => { takePhoto(); } },
            { text: t('imageUpload.optionFiles'), onPress: () => { pickFiles(); } },
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    }, [pickImages, takePhoto, pickFiles]);
```

Change the AgentInput prop wiring from `onPickImages={expImageUpload ? pickImages : undefined}` to `onPickImages={expImageUpload ? handlePickAttachment : undefined}`.

Check imports: `Platform` from `react-native`, `Modal` from `@/modal`, `t` from `@/text` — add any missing.

Note: `Modal.alert`'s `AlertButton` follows the RN shape (`{ text, onPress?, style? }`) — confirm against `sources/modal/types.ts` if typecheck complains.

- [ ] **Step 2: Add the camera permission string to app.config.js**

In the `ios.infoPlist` block (lines ~75–85), after `NSMicrophoneUsageDescription`:

```javascript
            NSCameraUsageDescription: "Allow $(PRODUCT_NAME) to use the camera to take photos to attach to messages.",
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/happy-app && pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/happy-app/sources/-session/SessionView.tsx packages/happy-app/app.config.js
git commit -m "feat(app): attachment source chooser (library/camera/files)"
```

---

### Task 5: i18n keys (all 10 languages)

**Files:**
- Modify: `packages/happy-app/sources/text/_default.ts` (the `imageUpload` section, ~line 223, and `settings.imageUpload*` ~line 219)
- Modify: all of `packages/happy-app/sources/text/translations/{ca,en,es,it,ja,pl,pt,ru,zh-Hans,zh-Hant}.ts`

- [ ] **Step 1: Add keys to `_default.ts`** (inside the existing `imageUpload` section):

```typescript
        addTitle: 'Add Attachment',
        optionLibrary: 'Photo Library',
        optionCamera: 'Take Photo',
        optionFiles: 'Choose File',
        cameraPermissionTitle: 'Camera Access',
        cameraPermissionMessage: 'Allow camera access to take photos to attach to messages.',
```

Also update the settings labels (~line 219):

```typescript
        imageUpload: 'Attachments',
        imageUploadSubtitle: 'Attach images and files to messages for Claude to analyze',
```

- [ ] **Step 2: Add the same keys to every translation file.** Mirror the structure of the existing `imageUpload` section in each file. Translations:

| key | en | es | ca | it | pt | pl | ru | ja | zh-Hans | zh-Hant |
|---|---|---|---|---|---|---|---|---|---|---|
| addTitle | Add Attachment | Añadir adjunto | Afegeix un fitxer adjunt | Aggiungi allegato | Adicionar anexo | Dodaj załącznik | Добавить вложение | 添付ファイルを追加 | 添加附件 | 新增附件 |
| optionLibrary | Photo Library | Fototeca | Fototeca | Libreria foto | Biblioteca de fotos | Biblioteka zdjęć | Фототека | フォトライブラリ | 照片图库 | 照片圖庫 |
| optionCamera | Take Photo | Tomar foto | Fes una foto | Scatta foto | Tirar foto | Zrób zdjęcie | Сделать фото | 写真を撮る | 拍照 | 拍照 |
| optionFiles | Choose File | Elegir archivo | Tria un fitxer | Scegli file | Escolher arquivo | Wybierz plik | Выбрать файл | ファイルを選択 | 选择文件 | 選擇檔案 |
| cameraPermissionTitle | Camera Access | Acceso a la cámara | Accés a la càmera | Accesso alla fotocamera | Acesso à câmera | Dostęp do aparatu | Доступ к камере | カメラへのアクセス | 相机权限 | 相機權限 |
| cameraPermissionMessage | Allow camera access to take photos to attach to messages. | Permite el acceso a la cámara para tomar fotos y adjuntarlas a los mensajes. | Permet l'accés a la càmera per fer fotos i adjuntar-les als missatges. | Consenti l'accesso alla fotocamera per scattare foto da allegare ai messaggi. | Permita o acesso à câmera para tirar fotos e anexá-las às mensagens. | Zezwól na dostęp do aparatu, aby robić zdjęcia i dołączać je do wiadomości. | Разрешите доступ к камере, чтобы делать фото и прикреплять их к сообщениям. | メッセージに添付する写真を撮るには、カメラへのアクセスを許可してください。 | 允许访问相机以拍摄照片并附加到消息中。 | 允許存取相機以拍攝照片並附加到訊息中。 |
| settings.imageUpload | Attachments | Adjuntos | Fitxers adjunts | Allegati | Anexos | Załączniki | Вложения | 添付ファイル | 附件 | 附件 |
| settings.imageUploadSubtitle | Attach images and files to messages for Claude to analyze | Adjunta imágenes y archivos a los mensajes para que Claude los analice | Adjunta imatges i fitxers als missatges perquè Claude els analitzi | Allega immagini e file ai messaggi per l'analisi di Claude | Anexe imagens e arquivos às mensagens para o Claude analisar | Dołączaj obrazy i pliki do wiadomości do analizy przez Claude | Прикрепляйте изображения и файлы к сообщениям для анализа Claude | 画像やファイルをメッセージに添付して Claude に分析させる | 在消息中附加图片和文件供 Claude 分析 | 在訊息中附加圖片和檔案供 Claude 分析 |

Before editing, read each translation file's `imageUpload` section to match its exact local structure (some files may interleave comments).

- [ ] **Step 3: Typecheck** (translation files are typed against `_default.ts` — missing keys fail here)

Run: `cd packages/happy-app && pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/happy-app/sources/text/
git commit -m "feat(app): i18n strings for attachment chooser and camera permission"
```

---

### Task 6: CLI — non-image attachments become document/text content blocks

**Files:**
- Create: `packages/happy-cli/src/claude/utils/attachmentContentBlocks.ts`
- Test: `packages/happy-cli/src/claude/utils/attachmentContentBlocks.test.ts`
- Modify: `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` (replace inline conversion at lines ~344–378, delete the now-moved `detectClaudeImageMime` at ~line 530)

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/happy-cli/src/claude/utils/attachmentContentBlocks.test.ts
import { describe, it, expect } from 'vitest';
import { attachmentsToContentBlocks } from './attachmentContentBlocks';

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]); // "%PDF-1.4"
const TEXT = new TextEncoder().encode('hello\nworld');
const BINARY = new Uint8Array([0x00, 0xFF, 0x13, 0x37, 0x00, 0x01]);

describe('attachmentsToContentBlocks', () => {
    it('converts a PNG to an image block', () => {
        const blocks = attachmentsToContentBlocks(
            [{ data: PNG, mimeType: 'image/png', name: 'shot.png' }], 'look');
        expect(blocks[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
        expect(blocks[blocks.length - 1]).toEqual({ type: 'text', text: 'look' });
    });

    it('converts a PDF to a document block regardless of declared mime', () => {
        const blocks = attachmentsToContentBlocks(
            [{ data: PDF, mimeType: 'application/octet-stream', name: 'doc.pdf' }], 'read');
        expect(blocks[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } });
    });

    it('inlines text/* attachments as fenced text blocks with filename', () => {
        const blocks = attachmentsToContentBlocks(
            [{ data: TEXT, mimeType: 'text/plain', name: 'log.txt' }], 'check');
        expect(blocks[0].type).toBe('text');
        const text = (blocks[0] as { type: 'text'; text: string }).text;
        expect(text).toContain('log.txt');
        expect(text).toContain('hello\nworld');
    });

    it('inlines UTF-8 attachments with unknown mime by extension fallback', () => {
        const blocks = attachmentsToContentBlocks(
            [{ data: TEXT, mimeType: 'application/octet-stream', name: 'notes.md' }], 'check');
        expect(blocks[0].type).toBe('text');
    });

    it('emits a visible notice for unsupported binary attachments', () => {
        const blocks = attachmentsToContentBlocks(
            [{ data: BINARY, mimeType: 'application/octet-stream', name: 'blob.bin' }], 'hi');
        const last = blocks[blocks.length - 1] as { type: 'text'; text: string };
        expect(last.type).toBe('text');
        expect(last.text).toContain('blob.bin');
        expect(last.text).toContain('not a supported');
        expect(last.text).toContain('hi');
    });

    it('returns a single text block when there are no attachments', () => {
        expect(attachmentsToContentBlocks([], 'just text'))
            .toEqual([{ type: 'text', text: 'just text' }]);
    });

    it('skips HEIC bytes that fail magic detection (defense in depth)', () => {
        const heicish = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]); // ftyp box, no JPEG/PNG magic
        const blocks = attachmentsToContentBlocks(
            [{ data: heicish, mimeType: 'image/heic', name: 'pic.heic' }], 'hi');
        const last = blocks[blocks.length - 1] as { type: 'text'; text: string };
        expect(last.text).toContain('pic.heic');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/happy-cli && pnpm vitest run src/claude/utils/attachmentContentBlocks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Move `detectClaudeImageMime` (currently `claudeRemoteLauncher.ts:530-548`, copy verbatim) into the new module and build around it:

```typescript
// packages/happy-cli/src/claude/utils/attachmentContentBlocks.ts
/**
 * Converts decrypted attachments into Claude API content blocks.
 *
 * Routing, in priority order on the decrypted BYTES (wire mimeType is
 * advisory only — iOS pickers lie):
 *   1. JPEG/PNG/GIF/WebP magic  -> image block
 *   2. %PDF- magic              -> document block (application/pdf)
 *   3. text/* mime, known text extension, or clean UTF-8 decode -> fenced text block
 *   4. anything else           -> visible notice appended to the text message
 *      (previously these were dropped with only a debug log)
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

export type PendingAttachmentLike = { data: Uint8Array; mimeType: string; name: string };

export function detectClaudeImageMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}

function isPdf(bytes: Uint8Array): boolean {
    return bytes.length >= 5 &&
        bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D;
}

const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'log', 'json', 'yaml', 'yml', 'csv', 'xml', 'html', 'css',
    'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp',
    'sh', 'toml', 'ini', 'cfg', 'conf', 'sql', 'swift', 'kt', 'env',
]);

function decodeAsText(att: PendingAttachmentLike): string | null {
    const ext = att.name.includes('.') ? att.name.split('.').pop()!.toLowerCase() : '';
    const looksTextual = att.mimeType.startsWith('text/') || TEXT_EXTENSIONS.has(ext);
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(att.data);
        // Reject decodes full of control chars even if technically valid UTF-8,
        // unless mime/extension already vouches for it.
        if (!looksTextual && /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(decoded)) return null;
        return decoded;
    } catch {
        return null;
    }
}

export function attachmentsToContentBlocks(
    attachments: PendingAttachmentLike[],
    messageText: string,
): ContentBlockParam[] {
    const blocks: ContentBlockParam[] = [];
    const unsupported: string[] = [];

    for (const att of attachments) {
        const imageMime = detectClaudeImageMime(att.data);
        if (imageMime) {
            blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: imageMime, data: Buffer.from(att.data).toString('base64') },
            });
            continue;
        }
        if (isPdf(att.data)) {
            blocks.push({
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(att.data).toString('base64') },
            });
            continue;
        }
        const text = decodeAsText(att);
        if (text !== null) {
            blocks.push({ type: 'text', text: `Attached file "${att.name}":\n\`\`\`\n${text}\n\`\`\`` });
            continue;
        }
        unsupported.push(att.name);
    }

    let tail = messageText;
    if (unsupported.length > 0) {
        tail += `\n\n[Note: attachment(s) ${unsupported.map(n => `"${n}"`).join(', ')} were not a supported type and were omitted.]`;
    }
    blocks.push({ type: 'text', text: tail });
    return blocks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/happy-cli && pnpm vitest run src/claude/utils/attachmentContentBlocks.test.ts`
Expected: 7 passed. If the SDK's `ContentBlockParam` union rejects the `document` literal, check `node_modules/@anthropic-ai/sdk/resources/messages.d.ts` for the exact `DocumentBlockParam`/`Base64PDFSource` shape and conform.

- [ ] **Step 5: Replace the inline conversion in claudeRemoteLauncher.ts**

At lines ~344–378, replace the whole `if (attachments.length > 0) { ... }` body with:

```typescript
                            const attachments = msg.attachments ?? [];
                            if (attachments.length > 0) {
                                const contentBlocks = attachmentsToContentBlocks(attachments, msg.message);
                                logger.debug(`[remote] Combined ${contentBlocks.length - 1} attachment block(s) with text message`);
                                return {
                                    message: contentBlocks,
                                    mode: msg.mode,
                                };
                            }
```

Add the import (`import { attachmentsToContentBlocks } from '@/claude/utils/attachmentContentBlocks'` — match the file's existing import style/aliases, check its other `@/claude/...` imports; use a relative path if that's the convention). Delete the old `detectClaudeImageMime` function (~line 530) and its now-unused comment block. Remove the `ContentBlockParam` import if no longer referenced.

- [ ] **Step 6: Full CLI test suite + build**

Run: `cd packages/happy-cli && pnpm vitest run && pnpm build`
Expected: all pass, build clean. (Check package.json — if the build script is named differently, e.g. `compile`, use that.)

- [ ] **Step 7: Commit**

```bash
git add packages/happy-cli/src/claude/utils/attachmentContentBlocks.ts packages/happy-cli/src/claude/utils/attachmentContentBlocks.test.ts packages/happy-cli/src/claude/claudeRemoteLauncher.ts
git commit -m "feat(cli): convert PDF and text attachments to Claude content blocks"
```

---

### Task 7: Full verification + upstream PR

- [ ] **Step 1: Run everything**

```bash
cd packages/happy-app && pnpm typecheck && pnpm vitest run
cd ../happy-cli && pnpm vitest run && pnpm typecheck
```

Expected: all clean.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/attachments
gh pr create --repo slopus/happy --title "feat: camera, file/PDF attachments + HEIC normalization" --body "<summary per template below>"
```

PR body: summarize — extends `expImageUpload` pipeline with camera capture + document picker; app-side normalization (HEIC→JPEG q0.9, downscale >1568px long edge — fixes silent HEIC drop at the CLI magic-byte check); CLI converts PDFs to document blocks and UTF-8 text files to fenced text blocks, with a visible notice for unsupported types. Reference issues #1319, #1270, #919, #70. End body with the 🤖 Generated with Claude Code footer.

Note: the spec/plan docs under `docs/superpowers/` are committed on this branch — move them to the final commit only if upstream wouldn't want them; default: keep them out of the PR by rebasing them onto a separate local branch if the maintainer objects. (Leave as-is initially; they're harmless docs.)

---

## Phase B — local TestFlight build

### Task 8: Integration branch

- [ ] **Step 1: Create `local/testflight`**

```bash
git fetch upstream main
git checkout -b local/testflight upstream/main
git merge --no-edit feat/fable-5-model
git merge --no-edit feat/claude-model-effort
git merge --no-edit feat/attachments
```

Expected: clean merges or small conflicts (upstream moved since #1372/#1373 branched — resolve keeping both sides' intent; the PR branches touch model lists/picker, attachments touches picker hook/SessionView).

- [ ] **Step 2: Verify merged tree**

```bash
cd packages/happy-app && pnpm typecheck && pnpm vitest run
cd ../happy-cli && pnpm vitest run
```

Expected: clean.

- [ ] **Step 3: Commit nothing extra yet** — merges only on this branch so far.

### Task 9: Local-only TestFlight commit

**Files:**
- Modify: `packages/happy-app/app.config.js`
- Create: `scripts/build-ios-testflight.sh`

- [ ] **Step 1: app.config.js overrides**

In the `bundleId` map (~line 9), change production: `production: "ca.lixfeld.happy"`. In the `name` map (find the equivalent display-name variant map near it — read lines 1–68 first), suffix the production name with nothing visible-breaking (keep "Happy"; ASC app record name disambiguates). Add `buildNumber` support inside the `ios` block:

```javascript
        buildNumber: process.env.HAPPY_BUILD_NUMBER ?? "1",
```

Flip the settings default for convenience: in `packages/happy-app/sources/sync/settings.ts:104`, `expImageUpload: true`.

- [ ] **Step 2: Build script** — create `scripts/build-ios-testflight.sh` (chmod +x):

```bash
#!/usr/bin/env bash
# Local TestFlight build for the Happy fork (bundle ca.lixfeld.happy).
# Headless signing via App Store Connect API key — Seneca/SoundSpotter pattern.
# Requires: APPLE_ASC_KEY_ID, APPLE_ASC_ISSUER_ID, APPLE_TEAM_ID in env (Infisical).
set -euo pipefail

cd "$(dirname "$0")/../packages/happy-app"

: "${APPLE_ASC_KEY_ID:?APPLE_ASC_KEY_ID not set}"
: "${APPLE_ASC_ISSUER_ID:?APPLE_ASC_ISSUER_ID not set}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set}"

P8_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_ASC_KEY_ID}.p8"
[[ -f "$P8_PATH" ]] || { echo "ERROR: ASC API key not found at $P8_PATH" >&2; exit 1; }

export HAPPY_BUILD_NUMBER="$(date +%y%m%d%H%M)"
BUILD_DIR="$(pwd)/build-testflight"
rm -rf "$BUILD_DIR" ios
mkdir -p "$BUILD_DIR"

echo "==> Prebuild (APP_ENV=production, buildNumber=$HAPPY_BUILD_NUMBER)"
APP_ENV=production npx expo prebuild --platform ios

WORKSPACE=$(ls ios/*.xcworkspace | head -1)
SCHEME=$(basename "$WORKSPACE" .xcworkspace)

echo "==> Archive"
xcodebuild archive \
    -workspace "$WORKSPACE" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$BUILD_DIR/Happy.xcarchive" \
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
    CODE_SIGN_STYLE=Automatic \
    -allowProvisioningUpdates \
    -authenticationKeyPath "$P8_PATH" \
    -authenticationKeyID "$APPLE_ASC_KEY_ID" \
    -authenticationKeyIssuerID "$APPLE_ASC_ISSUER_ID"

cat > "$BUILD_DIR/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>app-store-connect</string>
    <key>teamID</key><string>${APPLE_TEAM_ID}</string>
</dict>
</plist>
EOF

echo "==> Export"
xcodebuild -exportArchive \
    -archivePath "$BUILD_DIR/Happy.xcarchive" \
    -exportPath "$BUILD_DIR/export" \
    -exportOptionsPlist "$BUILD_DIR/ExportOptions.plist" \
    -allowProvisioningUpdates \
    -authenticationKeyPath "$P8_PATH" \
    -authenticationKeyID "$APPLE_ASC_KEY_ID" \
    -authenticationKeyIssuerID "$APPLE_ASC_ISSUER_ID"

IPA=$(ls "$BUILD_DIR"/export/*.ipa | head -1)
echo "==> Upload $IPA"
xcrun altool --upload-app -f "$IPA" -t ios \
    --apiKey "$APPLE_ASC_KEY_ID" --apiIssuer "$APPLE_ASC_ISSUER_ID"

echo "==> Done (build $HAPPY_BUILD_NUMBER)"
```

- [ ] **Step 3: Environment prereq checks** (before first run)

```bash
which pod || echo "MISSING: CocoaPods (brew install cocoapods)"   # known-missing on this machine (obs 8322)
ls ~/.appstoreconnect/private_keys/ 2>/dev/null || echo "MISSING: ASC key dir"
```

Install CocoaPods if missing. APPLE_* env values come from Infisical via the infisical-secrets skill — names only, never print values.

- [ ] **Step 4: Commit (local branch only — never push to a PR)**

```bash
git add packages/happy-app/app.config.js packages/happy-app/sources/sync/settings.ts scripts/build-ios-testflight.sh
git commit -m "local: TestFlight build config for ca.lixfeld.happy fork"
```

### Task 10: Manual prereqs + first build (interactive with user)

- [ ] **Step 1 (USER, manual):** Register bundle ID `ca.lixfeld.happy` at developer.apple.com → Identifiers; create ASC app record (name "Happy JL" or similar) at appstoreconnect.apple.com. Capabilities: associated domains off (fork build drops `applinks` for production? No — config keeps it; harmless), push notifications NOT required (known-dead in fork).
- [ ] **Step 2:** Run `scripts/build-ios-testflight.sh` with env set. First run surfaces signing/entitlement issues — fix iteratively (debug signature: missing entitlement → check generated `ios/Happy/Happy.entitlements` vs portal capabilities; trim capabilities in app.config.js if the portal bundle lacks them, e.g. associated domains).
- [ ] **Step 3:** Confirm build appears in TestFlight (processing takes ~5–15 min), install on device, smoke test: pair, send text, attach gallery image / camera photo / PDF, verify agent sees each (CLI runs from local dist with feat/attachments merged — restart daemon on new dist first: `pnpm cli:install` flow used previously).

---

## Self-review notes

- Spec coverage: HEIC fix (T1–3), camera (T3–4), files (T3–4, T6), i18n (T5), CLI blocks (T6), flag flip + bundle + script (T9), prereqs/build/verify (T10). Branch strategy (T8). ✓
- Existing-test risk: `runClaude.test.ts` mocks `drainAttachmentsForUserMessage` — unaffected. `settings.spec.ts` may assert `expImageUpload` default `false`; T9 flips it on local branch only — if that test breaks on local/testflight, update the assertion in the same local commit.
- The `document` content block must be verified against the installed @anthropic-ai/sdk version (T6 Step 4 covers it).
- expo-image-manipulator API shape verified at T2 Step 1 before use.
