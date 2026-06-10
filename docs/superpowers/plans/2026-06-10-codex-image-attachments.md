# Codex Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex image attachment parity with Claude while preserving Happy encrypted attachment storage and safe fork/history behavior.

**Architecture:** The app keeps the existing encrypted upload plus `file` event flow and extends the support gate from Claude to Codex. The Codex CLI mirrors Claude's file-event ownership model, validates image bytes, writes local plaintext image files into a configured per-session cache, and sends Codex `localImage` input items through `codex app-server`. Provider-history fork backfill uses a side-effecting orchestrator that uploads existing local image paths through the normal Happy encrypted attachment API while keeping the pure Codex thread mapper side-effect-free.

**Tech Stack:** TypeScript, Vitest, React Native/Expo, Happy session protocol, Happy encrypted attachment APIs, Codex app-server JSON-RPC v2.

---

## File Structure

- Create `packages/happy-app/sources/sync/attachmentSupport.ts`: pure app helper for image attachment support decisions.
- Create `packages/happy-app/sources/sync/attachmentSupport.test.ts`: focused tests for Claude/Codex support and unsupported image-only sends.
- Modify `packages/happy-app/sources/sync/sync.ts`: use the support helper and avoid empty text messages for unsupported image-only sends.
- Modify `packages/happy-app/sources/text/_default.ts`: change image upload feature subtitle from Claude-only wording to supported-agent wording.
- Modify `packages/happy-app/sources/text/translations/en.ts`: keep English translation aligned with `_default.ts`.
- Modify `packages/happy-app/sources/text/translations/ru.ts`: update Russian subtitle wording.
- Modify `packages/happy-app/sources/text/translations/ca.ts`: replace Claude-only subtitle with neutral supported-agent wording.
- Modify `packages/happy-app/sources/text/translations/es.ts`: replace Claude-only subtitle with neutral supported-agent wording.
- Modify `packages/happy-app/sources/text/translations/it.ts`: replace Claude-only subtitle with neutral supported-agent wording.
- Modify `packages/happy-app/sources/text/translations/ja.ts`: replace Claude-only subtitle with neutral supported-agent wording.
- Modify `packages/happy-app/sources/text/translations/pl.ts`: replace Claude-only subtitle with neutral supported-agent wording.
- Modify `packages/happy-app/sources/text/translations/pt.ts`: replace Claude-only subtitle with neutral supported-agent wording.
- Modify `packages/happy-app/sources/text/translations/zh-Hans.ts`: replace Claude-only subtitle with neutral supported-agent wording.
- Modify `packages/happy-app/sources/text/translations/zh-Hant.ts`: replace Claude-only subtitle with neutral supported-agent wording.
- Modify `packages/happy-cli/src/codex/codexClearCommand.ts`: carry attachments when queueing normal Codex messages and isolated `/clear` messages.
- Modify `packages/happy-cli/src/codex/codexClearCommand.test.ts`: prove attachments are forwarded into queue calls.
- Modify `packages/happy-cli/src/codex/codexAppServerTypes.ts`: align image input items with generated Codex 0.137 wire shape by allowing optional `detail`.
- Modify `packages/happy-cli/src/codex/codexAppServerClient.ts`: allow callers to pass extra `InputItem`s and omit empty text items for image-only turns.
- Modify `packages/happy-cli/src/codex/codexAppServerClient.test.ts`: assert text-only input stays unchanged and image-only input is sent without `text: ""`.
- Create `packages/happy-cli/src/codex/utils/imageInput.ts`: detect supported image bytes, write generated cache files, and build Codex `localImage` input items.
- Create `packages/happy-cli/src/codex/utils/imageInput.test.ts`: cover byte detection, generated names, unsupported formats, and cache root selection.
- Create `packages/happy-cli/src/codex/utils/attachmentEvents.ts`: convert Happy `file` events into decrypted `PendingAttachment` promises for Codex.
- Create `packages/happy-cli/src/codex/utils/attachmentEvents.test.ts`: cover successful download/decrypt and failure isolation.
- Modify `packages/happy-cli/src/api/apiSession.ts`: expose a generic encrypted local image upload helper that can tag envelopes with `claudeUuid` or `codexItemId`.
- Modify `packages/happy-cli/src/api/apiSession.test.ts`: preserve Claude transcript image upload coverage and add Codex-tagged local image upload coverage.
- Modify `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts`: extract pure per-turn/per-item mapping helpers without adding upload or filesystem side effects.
- Modify `packages/happy-cli/src/codex/__tests__/sessionProtocolMapper.test.ts`: keep existing mapping behavior stable after extraction.
- Create `packages/happy-cli/src/codex/utils/threadImageBackfill.ts`: build ordered Codex fork-backfill envelopes, inserting uploaded local image file envelopes before the matching user text envelope.
- Create `packages/happy-cli/src/codex/utils/threadImageBackfill.test.ts`: cover image-before-text ordering, image-only user items, missing paths, and URL-image skip behavior.
- Modify `packages/happy-cli/src/codex/runCodex.ts`: register file-event handling, drain attachments per message, prepare Codex image input items, handle image-only turns, and use ordered image backfill for Codex fork sessions.

### Task 1: App Attachment Support Gate

**Files:**
- Create: `packages/happy-app/sources/sync/attachmentSupport.ts`
- Create: `packages/happy-app/sources/sync/attachmentSupport.test.ts`
- Modify: `packages/happy-app/sources/sync/sync.ts`
- Modify: `packages/happy-app/sources/text/_default.ts`
- Modify: `packages/happy-app/sources/text/translations/en.ts`
- Modify: `packages/happy-app/sources/text/translations/ru.ts`
- Modify: `packages/happy-app/sources/text/translations/ca.ts`
- Modify: `packages/happy-app/sources/text/translations/es.ts`
- Modify: `packages/happy-app/sources/text/translations/it.ts`
- Modify: `packages/happy-app/sources/text/translations/ja.ts`
- Modify: `packages/happy-app/sources/text/translations/pl.ts`
- Modify: `packages/happy-app/sources/text/translations/pt.ts`
- Modify: `packages/happy-app/sources/text/translations/zh-Hans.ts`
- Modify: `packages/happy-app/sources/text/translations/zh-Hant.ts`

- [ ] **Step 1: Write the failing support helper test**

Create `packages/happy-app/sources/sync/attachmentSupport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
    getImageAttachmentSendPlan,
    supportsImageAttachmentsForFlavor,
} from './attachmentSupport';

describe('supportsImageAttachmentsForFlavor', () => {
    it('supports legacy sessions, Claude, and Codex', () => {
        expect(supportsImageAttachmentsForFlavor(undefined)).toBe(true);
        expect(supportsImageAttachmentsForFlavor(null)).toBe(true);
        expect(supportsImageAttachmentsForFlavor('claude')).toBe(true);
        expect(supportsImageAttachmentsForFlavor('codex')).toBe(true);
    });

    it('rejects Gemini, OpenClaw, and unknown explicit flavors', () => {
        expect(supportsImageAttachmentsForFlavor('gemini')).toBe(false);
        expect(supportsImageAttachmentsForFlavor('openclaw')).toBe(false);
        expect(supportsImageAttachmentsForFlavor('custom-agent')).toBe(false);
    });
});

describe('getImageAttachmentSendPlan', () => {
    it('uses attachments and sends text for Codex', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'codex',
            text: '',
            attachmentCount: 1,
        })).toEqual({
            supportsAttachments: true,
            shouldUseAttachments: true,
            shouldShowUnsupportedAlert: false,
            shouldSendText: true,
        });
    });

    it('warns but still sends non-empty text for unsupported agents', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'gemini',
            text: 'describe this',
            attachmentCount: 1,
        })).toEqual({
            supportsAttachments: false,
            shouldUseAttachments: false,
            shouldShowUnsupportedAlert: true,
            shouldSendText: true,
        });
    });

    it('warns and sends nothing for unsupported image-only messages', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'openclaw',
            text: '   ',
            attachmentCount: 2,
        })).toEqual({
            supportsAttachments: false,
            shouldUseAttachments: false,
            shouldShowUnsupportedAlert: true,
            shouldSendText: false,
        });
    });
});
```

- [ ] **Step 2: Run the app test and verify it fails**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/attachmentSupport.test.ts
```

Expected: FAIL with an import error because `attachmentSupport.ts` does not exist.

- [ ] **Step 3: Add the support helper**

Create `packages/happy-app/sources/sync/attachmentSupport.ts`:

```ts
export type ImageAttachmentFlavor = string | null | undefined;

export type ImageAttachmentSendPlan = {
    supportsAttachments: boolean;
    shouldUseAttachments: boolean;
    shouldShowUnsupportedAlert: boolean;
    shouldSendText: boolean;
};

export function supportsImageAttachmentsForFlavor(flavor: ImageAttachmentFlavor): boolean {
    return !flavor || flavor === 'claude' || flavor === 'codex';
}

export function getImageAttachmentSendPlan(opts: {
    flavor: ImageAttachmentFlavor;
    text: string;
    attachmentCount: number;
}): ImageAttachmentSendPlan {
    const hasAttachments = opts.attachmentCount > 0;
    const supportsAttachments = supportsImageAttachmentsForFlavor(opts.flavor);
    const shouldShowUnsupportedAlert = hasAttachments && !supportsAttachments;

    return {
        supportsAttachments,
        shouldUseAttachments: hasAttachments && supportsAttachments,
        shouldShowUnsupportedAlert,
        shouldSendText: !shouldShowUnsupportedAlert || opts.text.trim().length > 0,
    };
}
```

- [ ] **Step 4: Use the helper in `sync.sendMessage`**

In `packages/happy-app/sources/sync/sync.ts`, add the import:

```ts
import { getImageAttachmentSendPlan } from './attachmentSupport';
```

Replace the current `supportsAttachments` block in `sendMessage` with:

```ts
        const flavor = session.metadata?.flavor;
        const attachmentPlan = getImageAttachmentSendPlan({
            flavor,
            text,
            attachmentCount: attachments?.length ?? 0,
        });
        const effectiveAttachments = attachmentPlan.shouldUseAttachments ? attachments : undefined;

        if (attachmentPlan.shouldShowUnsupportedAlert) {
            Modal.alert(
                t('imageUpload.notSupportedTitle'),
                t('imageUpload.notSupportedMessage'),
                [{ text: t('common.ok'), style: 'cancel' }],
            );
            if (!attachmentPlan.shouldSendText) {
                return;
            }
        }
```

- [ ] **Step 5: Update image upload feature copy**

Replace the English/default subtitle in `packages/happy-app/sources/text/_default.ts` and `packages/happy-app/sources/text/translations/en.ts`:

```ts
imageUploadSubtitle: 'Attach images to messages for supported agents to analyze',
```

Replace the English/default unsupported message in `packages/happy-app/sources/text/_default.ts` and `packages/happy-app/sources/text/translations/en.ts`:

```ts
notSupportedMessage: 'This agent does not support image attachments. Images were not sent.',
```

Replace the Russian subtitle in `packages/happy-app/sources/text/translations/ru.ts`:

```ts
imageUploadSubtitle: 'Прикрепляйте изображения к сообщениям для анализа поддерживаемыми агентами',
```

Replace the Russian unsupported message in `packages/happy-app/sources/text/translations/ru.ts`:

```ts
notSupportedMessage: 'Этот агент не поддерживает вложения изображений. Изображения не были отправлены.',
```

In `packages/happy-app/sources/text/translations/ca.ts`, replace both strings:

```ts
imageUploadSubtitle: 'Adjunta imatges als missatges perquè els agents compatibles les analitzin',
notSupportedMessage: 'Aquest agent no admet fitxers adjunts d\'imatge. Les imatges no s\'han enviat.',
```

In `packages/happy-app/sources/text/translations/es.ts`, replace both strings:

```ts
imageUploadSubtitle: 'Adjunta imágenes a los mensajes para que los agentes compatibles las analicen',
notSupportedMessage: 'Este agente no admite archivos adjuntos de imagen. Las imágenes no se enviaron.',
```

In `packages/happy-app/sources/text/translations/it.ts`, replace both strings:

```ts
imageUploadSubtitle: 'Allega immagini ai messaggi per farle analizzare dagli agenti supportati',
notSupportedMessage: 'Questo agente non supporta gli allegati immagine. Le immagini non sono state inviate.',
```

In `packages/happy-app/sources/text/translations/ja.ts`, replace both strings:

```ts
imageUploadSubtitle: '対応エージェントに分析させるため、メッセージに画像を添付する',
notSupportedMessage: 'このエージェントは画像の添付に対応していません。画像は送信されませんでした。',
```

In `packages/happy-app/sources/text/translations/pl.ts`, replace both strings:

```ts
imageUploadSubtitle: 'Dołączaj obrazy do wiadomości, aby obsługiwani agenci mogli je analizować',
notSupportedMessage: 'Ten agent nie obsługuje załączników obrazów. Obrazy nie zostały wysłane.',
```

In `packages/happy-app/sources/text/translations/pt.ts`, replace both strings:

```ts
imageUploadSubtitle: 'Anexe imagens às mensagens para que agentes compatíveis as analisem',
notSupportedMessage: 'Este agente não suporta anexos de imagem. As imagens não foram enviadas.',
```

In `packages/happy-app/sources/text/translations/zh-Hans.ts`, replace both strings:

```ts
imageUploadSubtitle: '将图片附加到消息中，以便受支持的代理进行分析',
notSupportedMessage: '此代理不支持图片附件。图片未发送。',
```

In `packages/happy-app/sources/text/translations/zh-Hant.ts`, replace both strings:

```ts
imageUploadSubtitle: '將圖片附加到訊息中，讓支援的代理分析',
notSupportedMessage: '此代理不支援圖片附件。圖片未傳送。',
```

- [ ] **Step 6: Run app tests and typecheck**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/attachmentSupport.test.ts
pnpm --dir packages/happy-app typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit app gate changes**

Run:

```bash
git add packages/happy-app/sources/sync/attachmentSupport.ts \
  packages/happy-app/sources/sync/attachmentSupport.test.ts \
  packages/happy-app/sources/sync/sync.ts \
  packages/happy-app/sources/text/_default.ts \
  packages/happy-app/sources/text/translations/en.ts \
  packages/happy-app/sources/text/translations/ru.ts \
  packages/happy-app/sources/text/translations/ca.ts \
  packages/happy-app/sources/text/translations/es.ts \
  packages/happy-app/sources/text/translations/it.ts \
  packages/happy-app/sources/text/translations/ja.ts \
  packages/happy-app/sources/text/translations/pl.ts \
  packages/happy-app/sources/text/translations/pt.ts \
  packages/happy-app/sources/text/translations/zh-Hans.ts \
  packages/happy-app/sources/text/translations/zh-Hant.ts
git commit -m "feat(app): enable image attachments for codex"
```

### Task 2: Preserve Attachments Through Codex Queueing

**Files:**
- Modify: `packages/happy-cli/src/codex/codexClearCommand.ts`
- Modify: `packages/happy-cli/src/codex/codexClearCommand.test.ts`

- [ ] **Step 1: Write failing queue attachment tests**

Append these tests to `packages/happy-cli/src/codex/codexClearCommand.test.ts`:

```ts
    it('passes attachments to normal queued messages', () => {
        const mode = { permissionMode: 'default' as const };
        const attachments = [{
            data: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            name: 'screen.png',
        }];
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };

        const result = enqueueCodexUserText({
            text: 'inspect this image',
            mode,
            queue,
            attachments,
        });

        expect(result).toBe('queued');
        expect(queue.push).toHaveBeenCalledWith('inspect this image', mode, attachments);
        expect(queue.pushIsolateAndClear).not.toHaveBeenCalled();
    });

    it('passes attachments to isolated clear messages', () => {
        const mode = { permissionMode: 'default' as const };
        const attachments = [{
            data: new Uint8Array([4, 5, 6]),
            mimeType: 'image/jpeg',
            name: 'photo.jpg',
        }];
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };

        const result = enqueueCodexUserText({
            text: '/clear',
            mode,
            queue,
            attachments,
        });

        expect(result).toBe('clear');
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/clear', mode, attachments);
        expect(queue.push).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run the queue test and verify it fails**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/codexClearCommand.test.ts
```

Expected: FAIL because `enqueueCodexUserText` does not accept or forward `attachments`.

- [ ] **Step 3: Update `enqueueCodexUserText`**

Replace `packages/happy-cli/src/codex/codexClearCommand.ts` with:

```ts
import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { PendingAttachment } from '@/utils/MessageQueue2';

type CodexUserTextQueue<T> = {
    push: (message: string, mode: T, attachments?: PendingAttachment[]) => void;
    pushIsolateAndClear: (message: string, mode: T, attachments?: PendingAttachment[]) => void;
};

export function isCodexClearText(text: string): boolean {
    return parseSpecialCommand(text).type === 'clear';
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    queue: CodexUserTextQueue<T>;
    attachments?: PendingAttachment[];
}): 'clear' | 'queued' {
    if (isCodexClearText(opts.text)) {
        opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments);
        return 'clear';
    }

    opts.queue.push(opts.text, opts.mode, opts.attachments);
    return 'queued';
}
```

- [ ] **Step 4: Run the queue test**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/codexClearCommand.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit queue changes**

Run:

```bash
git add packages/happy-cli/src/codex/codexClearCommand.ts \
  packages/happy-cli/src/codex/codexClearCommand.test.ts
git commit -m "feat(cli): preserve codex queued attachments"
```

### Task 3: Allow Codex App-Server Image Input Items

**Files:**
- Modify: `packages/happy-cli/src/codex/codexAppServerTypes.ts`
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.ts`
- Modify: `packages/happy-cli/src/codex/codexAppServerClient.test.ts`

- [ ] **Step 1: Write failing app-server input tests**

Append this test case inside `describe('CodexAppServerClient sandbox integration', ...)` in `packages/happy-cli/src/codex/codexAppServerClient.test.ts`:

```ts
    it('sends extra localImage input items and omits empty text for image-only turns', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2801,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-images', path: '/tmp/thread-images' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-images',
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('', {
            extraInputItems: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-images',
            input: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        await client.disconnect();
    });

    it('keeps text-only turn input unchanged when no extra input items are supplied', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2802,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-text', path: '/tmp/thread-text' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-text',
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('hello');

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-text',
            input: [{ type: 'text', text: 'hello' }],
        });

        await client.disconnect();
    });
```

- [ ] **Step 2: Run the app-server client test and verify it fails**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/codexAppServerClient.test.ts
```

Expected: FAIL because `sendTurnAndWait` options do not accept `extraInputItems`.

- [ ] **Step 3: Update Codex input item types**

In `packages/happy-cli/src/codex/codexAppServerTypes.ts`, replace the `InputItem` definition with:

```ts
export type ImageDetail = "auto" | "low" | "high";

export type InputItem =
    | { type: "text"; text: string; text_elements?: unknown[] }
    | { type: "image"; detail?: ImageDetail; url: string }
    | { type: "localImage"; detail?: ImageDetail; path: string };
```

- [ ] **Step 4: Update `sendTurn` and `sendTurnAndWait` options**

In `packages/happy-cli/src/codex/codexAppServerClient.ts`, add `extraInputItems?: InputItem[]` to both option objects:

```ts
    async sendTurn(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        extraInputItems?: InputItem[];
    }): Promise<void> {
```

```ts
    async sendTurnAndWait(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        extraInputItems?: InputItem[];
        turnTimeoutMs?: number;
    }): Promise<{ aborted: boolean }> {
```

Replace the hardcoded input array in `sendTurn` with:

```ts
        const extraInputItems = opts?.extraInputItems ?? [];
        const input: InputItem[] = [];
        if (prompt.length > 0 || extraInputItems.length === 0) {
            input.push({ type: 'text', text: prompt });
        }
        input.push(...extraInputItems);
```

In `sendTurnAndWait`, pass `extraInputItems` through to `sendTurn`:

```ts
            await this.sendTurn(prompt, {
                model: opts?.model,
                cwd: opts?.cwd,
                approvalPolicy: opts?.approvalPolicy,
                sandbox: opts?.sandbox,
                effort: opts?.effort,
                extraInputItems: opts?.extraInputItems,
            });
```

- [ ] **Step 5: Run the app-server client test**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/codexAppServerClient.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit app-server input changes**

Run:

```bash
git add packages/happy-cli/src/codex/codexAppServerTypes.ts \
  packages/happy-cli/src/codex/codexAppServerClient.ts \
  packages/happy-cli/src/codex/codexAppServerClient.test.ts
git commit -m "feat(cli): send codex image input items"
```

### Task 4: Build Codex Local Image Cache Helper

**Files:**
- Create: `packages/happy-cli/src/codex/utils/imageInput.ts`
- Create: `packages/happy-cli/src/codex/utils/imageInput.test.ts`

- [ ] **Step 1: Write failing image input helper tests**

Create `packages/happy-cli/src/codex/utils/imageInput.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

import {
    detectSupportedImageType,
    prepareCodexImageInputItems,
    resolveCodexImageCacheDir,
} from './imageInput';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-codex-image-input-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop()!;
        await rm(dir, { recursive: true, force: true });
    }
});

describe('detectSupportedImageType', () => {
    it('detects supported image formats by magic bytes', () => {
        expect(detectSupportedImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({
            mimeType: 'image/png',
            extension: 'png',
        });
        expect(detectSupportedImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toEqual({
            mimeType: 'image/jpeg',
            extension: 'jpg',
        });
        expect(detectSupportedImageType(new TextEncoder().encode('GIF89a'))).toEqual({
            mimeType: 'image/gif',
            extension: 'gif',
        });
        expect(detectSupportedImageType(new Uint8Array([
            0x52, 0x49, 0x46, 0x46,
            0x00, 0x00, 0x00, 0x00,
            0x57, 0x45, 0x42, 0x50,
        ]))).toEqual({
            mimeType: 'image/webp',
            extension: 'webp',
        });
    });

    it('rejects unsupported bytes', () => {
        expect(detectSupportedImageType(new TextEncoder().encode('not an image'))).toBeNull();
    });
});

describe('prepareCodexImageInputItems', () => {
    it('writes supported images with generated names and returns localImage items', async () => {
        const cacheRootDir = await makeTempDir();
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

        const result = await prepareCodexImageInputItems([{
            data: pngBytes,
            mimeType: 'image/heic',
            name: '../../original name.heic',
        }], {
            cacheRootDir,
            sessionId: 'session-1',
        });

        expect(result.skipped).toBe(0);
        expect(result.inputItems).toHaveLength(1);
        expect(result.inputItems[0].type).toBe('localImage');
        if (result.inputItems[0].type === 'localImage') {
            expect(result.inputItems[0].path).toContain(join(cacheRootDir, 'session-1'));
            expect(result.inputItems[0].path).toMatch(/\.png$/);
            expect(result.inputItems[0].path).not.toContain('original name');
            expect(new Uint8Array(await readFile(result.inputItems[0].path))).toEqual(pngBytes);
        }
    });

    it('skips unsupported images without writing fallback files', async () => {
        const cacheRootDir = await makeTempDir();

        const result = await prepareCodexImageInputItems([{
            data: new TextEncoder().encode('not an image'),
            mimeType: 'image/png',
            name: 'fake.png',
        }], {
            cacheRootDir,
            sessionId: 'session-2',
        });

        expect(result).toEqual({
            inputItems: [],
            skipped: 1,
        });
    });

    it('skips images when cache writes fail', async () => {
        const cacheRootDir = await makeTempDir();
        const fileRoot = join(cacheRootDir, 'not-a-directory');
        await writeFile(fileRoot, 'occupied');

        const result = await prepareCodexImageInputItems([{
            data: new Uint8Array([0xff, 0xd8, 0xff, 0xdb]),
            mimeType: 'image/jpeg',
            name: 'photo.jpg',
        }], {
            cacheRootDir: fileRoot,
            sessionId: 'session-3',
        });

        expect(result).toEqual({
            inputItems: [],
            skipped: 1,
        });
    });
});

describe('resolveCodexImageCacheDir', () => {
    it('uses the explicit cache root when provided', () => {
        expect(resolveCodexImageCacheDir({
            cacheRootDir: '/tmp/happy-cache',
            sessionId: 'session-1',
        })).toBe('/tmp/happy-cache/session-1');
    });
});
```

- [ ] **Step 2: Run the image input tests and verify they fail**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/utils/imageInput.test.ts
```

Expected: FAIL because `imageInput.ts` does not exist.

- [ ] **Step 3: Add the image input helper**

Create `packages/happy-cli/src/codex/utils/imageInput.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { PendingAttachment } from '@/utils/MessageQueue2';

import type { InputItem } from '../codexAppServerTypes';

export type SupportedImageType = {
    mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    extension: 'png' | 'jpg' | 'gif' | 'webp';
};

export type PreparedCodexImageInputs = {
    inputItems: InputItem[];
    skipped: number;
};

export function detectSupportedImageType(data: Uint8Array): SupportedImageType | null {
    if (
        data.length >= 8
        && data[0] === 0x89
        && data[1] === 0x50
        && data[2] === 0x4e
        && data[3] === 0x47
        && data[4] === 0x0d
        && data[5] === 0x0a
        && data[6] === 0x1a
        && data[7] === 0x0a
    ) {
        return { mimeType: 'image/png', extension: 'png' };
    }

    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return { mimeType: 'image/jpeg', extension: 'jpg' };
    }

    if (data.length >= 6) {
        const header = new TextDecoder().decode(data.slice(0, 6));
        if (header === 'GIF87a' || header === 'GIF89a') {
            return { mimeType: 'image/gif', extension: 'gif' };
        }
    }

    if (
        data.length >= 12
        && data[0] === 0x52
        && data[1] === 0x49
        && data[2] === 0x46
        && data[3] === 0x46
        && data[8] === 0x57
        && data[9] === 0x45
        && data[10] === 0x42
        && data[11] === 0x50
    ) {
        return { mimeType: 'image/webp', extension: 'webp' };
    }

    return null;
}

export function resolveCodexImageCacheDir(opts: {
    sessionId: string;
    cacheRootDir?: string;
}): string {
    return join(opts.cacheRootDir ?? join(configuration.happyHomeDir, 'codex-image-cache'), opts.sessionId);
}

export async function prepareCodexImageInputItems(
    attachments: PendingAttachment[] | undefined,
    opts: {
        sessionId: string;
        cacheRootDir?: string;
    },
): Promise<PreparedCodexImageInputs> {
    if (!attachments || attachments.length === 0) {
        return { inputItems: [], skipped: 0 };
    }

    const cacheDir = resolveCodexImageCacheDir(opts);
    const inputItems: InputItem[] = [];
    let skipped = 0;

    for (const attachment of attachments) {
        const detected = detectSupportedImageType(attachment.data);
        if (!detected) {
            logger.debug('[Codex] Skipping unsupported image attachment', {
                name: attachment.name,
                mimeType: attachment.mimeType,
                size: attachment.data.length,
            });
            skipped += 1;
            continue;
        }

        try {
            await mkdir(cacheDir, { recursive: true });
            const filePath = join(cacheDir, `${randomUUID()}.${detected.extension}`);
            await writeFile(filePath, Buffer.from(attachment.data));
            inputItems.push({ type: 'localImage', path: filePath });
        } catch (error) {
            logger.debug('[Codex] Failed to cache image attachment for localImage input', {
                name: attachment.name,
                mimeType: detected.mimeType,
                size: attachment.data.length,
                error,
            });
            skipped += 1;
        }
    }

    return { inputItems, skipped };
}
```

- [ ] **Step 4: Run the image input tests**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/utils/imageInput.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit image input helper**

Run:

```bash
git add packages/happy-cli/src/codex/utils/imageInput.ts \
  packages/happy-cli/src/codex/utils/imageInput.test.ts
git commit -m "feat(cli): prepare codex local image inputs"
```

### Task 5: Convert Codex File Events Into Queue Attachments

**Files:**
- Create: `packages/happy-cli/src/codex/utils/attachmentEvents.ts`
- Create: `packages/happy-cli/src/codex/utils/attachmentEvents.test.ts`
- Modify: `packages/happy-cli/src/codex/runCodex.ts`

- [ ] **Step 1: Write failing attachment event tests**

Create `packages/happy-cli/src/codex/utils/attachmentEvents.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

import { downloadCodexFileEventAttachment } from './attachmentEvents';

function fileEvent(overrides?: Partial<{
    ref: string;
    name: string;
    size: number;
    mimeType: string | null;
}>) {
    return {
        content: {
            data: {
                ev: {
                    t: 'file',
                    ref: overrides?.ref ?? 'attachment-ref',
                    name: overrides?.name ?? 'image.png',
                    size: overrides?.size ?? 3,
                    mimeType: overrides?.mimeType ?? 'image/png',
                },
            },
        },
    } as any;
}

describe('downloadCodexFileEventAttachment', () => {
    it('downloads and returns a pending attachment payload', async () => {
        const data = new Uint8Array([1, 2, 3]);
        const session = {
            downloadAndDecryptAttachment: vi.fn().mockResolvedValue(data),
        };

        await expect(downloadCodexFileEventAttachment(session, fileEvent())).resolves.toEqual({
            data,
            mimeType: 'image/png',
            name: 'image.png',
        });
        expect(session.downloadAndDecryptAttachment).toHaveBeenCalledWith('attachment-ref');
    });

    it('defaults missing MIME type to image/jpeg', async () => {
        const data = new Uint8Array([1, 2, 3]);
        const session = {
            downloadAndDecryptAttachment: vi.fn().mockResolvedValue(data),
        };

        await expect(downloadCodexFileEventAttachment(session, fileEvent({ mimeType: null }))).resolves.toEqual({
            data,
            mimeType: 'image/jpeg',
            name: 'image.png',
        });
    });

    it('returns null when download or decrypt fails', async () => {
        const session = {
            downloadAndDecryptAttachment: vi.fn().mockRejectedValue(new Error('download failed')),
        };

        await expect(downloadCodexFileEventAttachment(session, fileEvent())).resolves.toBeNull();
    });

    it('returns null when decryption returns null', async () => {
        const session = {
            downloadAndDecryptAttachment: vi.fn().mockResolvedValue(null),
        };

        await expect(downloadCodexFileEventAttachment(session, fileEvent())).resolves.toBeNull();
    });
});
```

- [ ] **Step 2: Run the attachment event tests and verify they fail**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/utils/attachmentEvents.test.ts
```

Expected: FAIL because `attachmentEvents.ts` does not exist.

- [ ] **Step 3: Add the attachment event helper**

Create `packages/happy-cli/src/codex/utils/attachmentEvents.ts`:

```ts
import type { ApiSessionClient } from '@/api/apiSession';
import type { FileEventMessage } from '@/api/types';
import type { PendingAttachment } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';

type CodexAttachmentDownloader = Pick<ApiSessionClient, 'downloadAndDecryptAttachment'>;

export async function downloadCodexFileEventAttachment(
    session: CodexAttachmentDownloader,
    fileEvent: FileEventMessage,
): Promise<PendingAttachment | null> {
    const ev = fileEvent.content.data.ev;
    try {
        const decrypted = await session.downloadAndDecryptAttachment(ev.ref);
        if (!decrypted) {
            logger.debug(`[Codex] Failed to decrypt attachment: ${ev.name}`);
            return null;
        }
        return {
            data: decrypted,
            mimeType: ev.mimeType ?? 'image/jpeg',
            name: ev.name,
        };
    } catch (error) {
        logger.debug(`[Codex] Failed to download attachment: ${ev.name}`, { error });
        return null;
    }
}
```

- [ ] **Step 4: Register Codex file-event handling in `runCodex.ts`**

In `packages/happy-cli/src/codex/runCodex.ts`, add imports:

```ts
import type { PendingAttachment } from '@/utils/MessageQueue2';
import { downloadCodexFileEventAttachment } from './utils/attachmentEvents';
import { prepareCodexImageInputItems } from './utils/imageInput';
```

After `const messageQueue = new MessageQueue2<EnhancedMode>(hashCodexEnhancedMode);`, register file events:

```ts
    session.onFileEvent((fileEvent) => {
        const ev = fileEvent.content.data.ev;
        logger.debug(`[Codex] File event received: ${ev.name} (${ev.size} bytes, ref: ${ev.ref})`);
        session.trackAttachmentDownload(downloadCodexFileEventAttachment(session, fileEvent));
    });
```

Change `session.onUserMessage((message) => {` to:

```ts
    session.onUserMessage(async (message) => {
        const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();
```

Pass attachments into `enqueueCodexUserText`:

```ts
        const enqueueResult = enqueueCodexUserText({
            text: message.content.text,
            mode: enhancedMode,
            queue: messageQueue,
            attachments: attachmentsForThisMessage,
        });
```

Update the `pending` and `message` loop types:

```ts
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = null;
```

```ts
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = pending;
```

- [ ] **Step 5: Convert queued attachments before `sendTurnAndWait`**

In the main Codex loop in `packages/happy-cli/src/codex/runCodex.ts`, before `buildCodexTurnPrompt`, add:

```ts
                const imageInputs = await prepareCodexImageInputItems(message.attachments, {
                    sessionId: session.sessionId,
                });
                const hasUserText = message.message.trim().length > 0;
                if ((message.attachments?.length ?? 0) > 0 && imageInputs.inputItems.length === 0 && !hasUserText) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'No supported images were available to send to Codex.',
                    });
                    continue;
                }
```

Keep the existing `buildCodexTurnPrompt` call, then pass image items into `sendTurnAndWait`:

```ts
                const result = await client.sendTurnAndWait(turnPrompt, {
                    model: message.mode.model,
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    effort: message.mode.effort,
                    extraInputItems: imageInputs.inputItems,
                });
```

Change user message display so image-only messages do not render an empty row:

```ts
            if (message.message.trim().length > 0) {
                messageBuffer.addMessage(message.message, 'user');
            }
```

- [ ] **Step 6: Run attachment event tests and CLI typecheck**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/utils/attachmentEvents.test.ts src/codex/codexClearCommand.test.ts
pnpm --dir packages/happy-cli typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit live Codex attachment plumbing**

Run:

```bash
git add packages/happy-cli/src/codex/utils/attachmentEvents.ts \
  packages/happy-cli/src/codex/utils/attachmentEvents.test.ts \
  packages/happy-cli/src/codex/runCodex.ts
git commit -m "feat(cli): deliver app images to codex"
```

### Task 6: Generalize Local Image Upload Envelopes

**Files:**
- Modify: `packages/happy-cli/src/api/apiSession.ts`
- Modify: `packages/happy-cli/src/api/apiSession.test.ts`

- [ ] **Step 1: Write failing Codex local image upload test**

Append this test to `packages/happy-cli/src/api/apiSession.test.ts` near the existing Claude transcript image upload test:

```ts
    it('uploads local Codex image files with codex item ids', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

        mockAxiosPost.mockImplementation(async (url: string, payload: any) => {
            if (url.endsWith('/attachments/request-upload')) {
                expect(payload).toMatchObject({
                    filename: 'codex-image-1.png',
                });
                return {
                    data: {
                        ref: 'sessions/test-session-id/attachments/codex-image.enc',
                        uploadUrl: 'https://server.test/v1/sessions/test-session-id/attachments/codex-image.enc',
                        method: 'PUT',
                    },
                };
            }

            return {
                data: {
                    messages: payload.messages.map((_message: unknown, index: number) => ({
                        id: `msg-${index + 1}`,
                        seq: index + 1,
                        localId: `local-${index + 1}`,
                        createdAt: 1,
                        updatedAt: 1,
                    })),
                },
            };
        });
        mockAxiosPut.mockResolvedValueOnce({ data: { ok: true } });

        const envelope = await client.uploadLocalImageAttachmentEnvelope({
            data: pngBytes,
            mimeType: 'image/png',
            name: 'codex-image-1.png',
        }, {
            codexItemId: 'codex-user-item-1',
        });

        expect(envelope).toMatchObject({
            role: 'user',
            codexItemId: 'codex-user-item-1',
            ev: {
                t: 'file',
                ref: 'sessions/test-session-id/attachments/codex-image.enc',
                name: 'codex-image-1.png',
                size: pngBytes.length,
                mimeType: 'image/png',
            },
        });

        const uploadBody = mockAxiosPut.mock.calls[0][1];
        const blobKey = await client.getBlobKey();
        expect(decryptBlob(new Uint8Array(uploadBody), blobKey)).toEqual(pngBytes);
    });
```

- [ ] **Step 2: Run the API session test and verify it fails**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/api/apiSession.test.ts
```

Expected: FAIL because `uploadLocalImageAttachmentEnvelope` is not public.

- [ ] **Step 3: Generalize the upload helper**

In `packages/happy-cli/src/api/apiSession.ts`, rename `LocalTranscriptImageAttachment` to:

```ts
type LocalImageAttachment = {
    data: Uint8Array;
    mimeType: string;
    name: string;
};
```

Change `extractLocalTranscriptImageAttachments` to return `LocalImageAttachment[]`.

Replace the private `uploadLocalTranscriptImageAttachment` method with this public method:

```ts
    async uploadLocalImageAttachmentEnvelope(
        attachment: LocalImageAttachment,
        opts: {
            claudeUuid?: string;
            codexItemId?: string;
        } = {},
    ): Promise<SessionEnvelope> {
        const blobKey = await this.getBlobKey();
        const encrypted = encryptBlob(attachment.data, blobKey);
        const upload = await this.requestAttachmentUpload(attachment.name, encrypted.length);
        await this.uploadEncryptedAttachmentBlob(upload, encrypted);

        return createEnvelope('user', {
            t: 'file',
            ref: upload.ref,
            name: attachment.name,
            size: attachment.data.length,
            mimeType: attachment.mimeType,
        }, opts);
    }
```

In `sendClaudeSessionMessageFromLocalTranscript`, replace the old private helper call with:

```ts
                const envelope = await this.uploadLocalImageAttachmentEnvelope(attachment, { claudeUuid });
```

- [ ] **Step 4: Run the API session test**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/api/apiSession.test.ts
```

Expected: PASS, including the existing Claude image upload test.

- [ ] **Step 5: Commit upload helper generalization**

Run:

```bash
git add packages/happy-cli/src/api/apiSession.ts \
  packages/happy-cli/src/api/apiSession.test.ts
git commit -m "feat(cli): upload local codex image history"
```

### Task 7: Add Ordered Codex Fork Image Backfill

**Files:**
- Modify: `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts`
- Modify: `packages/happy-cli/src/codex/__tests__/sessionProtocolMapper.test.ts`
- Create: `packages/happy-cli/src/codex/utils/threadImageBackfill.ts`
- Create: `packages/happy-cli/src/codex/utils/threadImageBackfill.test.ts`
- Modify: `packages/happy-cli/src/codex/runCodex.ts`

- [ ] **Step 1: Extract pure item mapping without behavior change**

In `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts`, extract the body of each `switch (item.type)` branch in `mapCodexThreadToSessionEnvelopes` into:

```ts
export function mapCodexThreadItemToSessionEnvelopes(
    turn: ThreadTurn,
    item: ThreadItem,
): SessionEnvelope[] {
    const startedAt = turnTimestampMs(turn);
    const completedAt = completedTimestampMs(turn);

    switch (item.type) {
        case 'userMessage': {
            const text = textFromInputItems(item.content);
            return text
                ? [createEnvelope('user', { t: 'text', text }, {
                    id: item.id,
                    time: startedAt,
                    codexItemId: item.id,
                })]
                : [];
        }
        case 'agentMessage': {
            const text = typeof item.text === 'string' ? item.text.trim() : '';
            return text.length > 0
                ? [createEnvelope('agent', { t: 'text', text }, {
                    id: item.id,
                    turn: turn.id,
                    time: completedAt,
                    codexItemId: item.id,
                })]
                : [];
        }
        case 'reasoning': {
            const text = reasoningText(item);
            return text
                ? [createEnvelope('agent', { t: 'text', text, thinking: true }, {
                    id: item.id,
                    turn: turn.id,
                    time: startedAt,
                    codexItemId: item.id,
                })]
                : [];
        }
        case 'commandExecution': {
            const envelopes: SessionEnvelope[] = [];
            const command = typeof item.command === 'string' ? item.command : '';
            emitHistoricalToolCall(
                envelopes,
                turn,
                item,
                'CodexBash',
                commandToTitle(command),
                { command, cwd: item.cwd },
                typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null,
            );
            return envelopes;
        }
        case 'fileChange': {
            const envelopes: SessionEnvelope[] = [];
            emitHistoricalToolCall(
                envelopes,
                turn,
                item,
                'CodexPatch',
                'Apply patch',
                { changes: item.changes, status: item.status },
                null,
            );
            return envelopes;
        }
        case 'mcpToolCall': {
            const envelopes: SessionEnvelope[] = [];
            const title = `${item.server}.${item.tool}`;
            const output = item.error !== undefined && item.error !== null
                ? String(item.error)
                : (item.result !== undefined && item.result !== null ? String(item.result) : null);
            emitHistoricalToolCall(
                envelopes,
                turn,
                item,
                'McpTool',
                title,
                {
                    server: item.server,
                    tool: item.tool,
                    arguments: item.arguments,
                },
                output,
            );
            return envelopes;
        }
        default:
            return [];
    }
}
```

Then simplify the original loop:

```ts
        for (const item of turn.items ?? []) {
            envelopes.push(...mapCodexThreadItemToSessionEnvelopes(turn, item));
        }
```

- [ ] **Step 2: Run mapper tests after extraction**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/__tests__/sessionProtocolMapper.test.ts
```

Expected: PASS with no assertion changes. The extracted helper must preserve the existing branch-specific narrowing from the original `switch (item.type)` implementation.

- [ ] **Step 3: Write failing thread image backfill tests**

Create `packages/happy-cli/src/codex/utils/threadImageBackfill.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@slopus/happy-wire';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

import { buildCodexThreadBackfillEnvelopes } from './threadImageBackfill';

const tempDirs: string[] = [];

async function makePngFile(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-codex-backfill-'));
    tempDirs.push(dir);
    const filePath = join(dir, name);
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    return filePath;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe('buildCodexThreadBackfillEnvelopes', () => {
    it('inserts uploaded local image file envelopes before the matching user text', async () => {
        const imagePath = await makePngFile('input.png');
        const uploadLocalImage = vi.fn(async (_attachment, opts) => createEnvelope('user', {
            t: 'file',
            ref: 'uploaded-ref',
            name: 'codex-image-1.png',
            size: 9,
            mimeType: 'image/png',
        }, opts));

        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: {
                turns: [{
                    id: 'turn-1',
                    startedAt: 100,
                    completedAt: 101,
                    status: 'completed',
                    items: [
                        {
                            id: 'user-1',
                            type: 'userMessage',
                            content: [
                                { type: 'text', text: 'inspect this' },
                                { type: 'localImage', path: imagePath },
                            ],
                        },
                        { id: 'agent-1', type: 'agentMessage', text: 'ok' },
                    ],
                }],
            },
            uploadLocalImage,
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'file',
            'text',
            'text',
            'turn-end',
        ]);
        expect(envelopes[1]).toMatchObject({
            role: 'user',
            codexItemId: 'user-1',
            ev: { t: 'file', ref: 'uploaded-ref' },
        });
        expect(envelopes[2]).toMatchObject({
            role: 'user',
            codexItemId: 'user-1',
            ev: { t: 'text', text: 'inspect this' },
        });
        expect(uploadLocalImage).toHaveBeenCalledWith(expect.objectContaining({
            mimeType: 'image/png',
            name: 'codex-image-1.png',
        }), { codexItemId: 'user-1' });
    });

    it('backfills image-only user messages without inventing empty text', async () => {
        const imagePath = await makePngFile('only-image.png');
        const uploadLocalImage = vi.fn(async (_attachment, opts) => createEnvelope('user', {
            t: 'file',
            ref: 'uploaded-ref',
            name: 'codex-image-1.png',
            size: 9,
            mimeType: 'image/png',
        }, opts));

        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: {
                turns: [{
                    id: 'turn-1',
                    startedAt: 100,
                    items: [{
                        id: 'user-image-only',
                        type: 'userMessage',
                        content: [{ type: 'localImage', path: imagePath }],
                    }],
                }],
            },
            uploadLocalImage,
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'file',
            'turn-end',
        ]);
    });

    it('skips missing local paths and URL images while preserving text', async () => {
        const uploadLocalImage = vi.fn();

        const envelopes = await buildCodexThreadBackfillEnvelopes({
            thread: {
                turns: [{
                    id: 'turn-1',
                    startedAt: 100,
                    items: [{
                        id: 'user-1',
                        type: 'userMessage',
                        content: [
                            { type: 'text', text: 'text survives' },
                            { type: 'localImage', path: '/path/that/does/not/exist.png' },
                            { type: 'image', url: 'https://example.test/image.png' },
                        ],
                    }],
                }],
            },
            uploadLocalImage,
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'text',
            'turn-end',
        ]);
        expect(uploadLocalImage).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 4: Run thread image backfill tests and verify they fail**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/utils/threadImageBackfill.test.ts
```

Expected: FAIL because `threadImageBackfill.ts` does not exist.

- [ ] **Step 5: Add ordered thread image backfill helper**

Create `packages/happy-cli/src/codex/utils/threadImageBackfill.ts`:

```ts
import { readFile } from 'node:fs/promises';

import type { SessionEnvelope } from '@slopus/happy-wire';
import { createEnvelope } from '@slopus/happy-wire';

import type { Thread, ThreadItem, ThreadTurn } from '../codexAppServerTypes';
import { detectSupportedImageType } from './imageInput';
import { mapCodexThreadItemToSessionEnvelopes } from './sessionProtocolMapper';
import { logger } from '@/ui/logger';

type LocalImageUpload = (
    attachment: { data: Uint8Array; mimeType: string; name: string },
    opts: { codexItemId: string },
) => Promise<SessionEnvelope>;

function turnTimestampMs(turn: ThreadTurn): number {
    const seconds = turn.startedAt ?? turn.completedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

function completedTimestampMs(turn: ThreadTurn): number {
    const seconds = turn.completedAt ?? turn.startedAt;
    return typeof seconds === 'number' && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
}

function turnStatus(turn: ThreadTurn): 'completed' | 'failed' | 'cancelled' {
    const status = typeof turn.status === 'string' ? turn.status : null;
    if (status === 'failed') return 'failed';
    if (status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted') {
        return 'cancelled';
    }
    return 'completed';
}

function localImagePaths(item: ThreadItem): string[] {
    if (item.type !== 'userMessage' || !Array.isArray(item.content)) {
        return [];
    }
    return item.content
        .filter((part): part is { type: 'localImage'; path: string } => (
            Boolean(part)
            && typeof part === 'object'
            && (part as { type?: unknown }).type === 'localImage'
            && typeof (part as { path?: unknown }).path === 'string'
            && (part as { path: string }).path.length > 0
        ))
        .map((part) => part.path);
}

async function localImagePathToAttachment(path: string, index: number): Promise<{ data: Uint8Array; mimeType: string; name: string } | null> {
    try {
        const data = new Uint8Array(await readFile(path));
        const detected = detectSupportedImageType(data);
        if (!detected) {
            logger.debug('[Codex image backfill] Skipping unsupported local image input');
            return null;
        }
        return {
            data,
            mimeType: detected.mimeType,
            name: `codex-image-${index}.${detected.extension}`,
        };
    } catch (error) {
        logger.debug('[Codex image backfill] Skipping unavailable local image input', { error });
        return null;
    }
}

export async function buildCodexThreadBackfillEnvelopes(opts: {
    thread: Pick<Thread, 'turns'>;
    uploadLocalImage: LocalImageUpload;
}): Promise<SessionEnvelope[]> {
    const envelopes: SessionEnvelope[] = [];

    for (const turn of opts.thread.turns ?? []) {
        envelopes.push(createEnvelope('agent', { t: 'turn-start' }, {
            id: `${turn.id}:start`,
            turn: turn.id,
            time: turnTimestampMs(turn),
        }));

        for (const item of turn.items ?? []) {
            const paths = localImagePaths(item);
            for (let index = 0; index < paths.length; index += 1) {
                const attachment = await localImagePathToAttachment(paths[index], index + 1);
                if (!attachment) continue;
                try {
                    envelopes.push(await opts.uploadLocalImage(attachment, { codexItemId: item.id }));
                } catch (error) {
                    logger.debug('[Codex image backfill] Failed to upload local image input', { error });
                }
            }
            envelopes.push(...mapCodexThreadItemToSessionEnvelopes(turn, item));
        }

        envelopes.push(createEnvelope('agent', { t: 'turn-end', status: turnStatus(turn) }, {
            id: `${turn.id}:end`,
            turn: turn.id,
            time: completedTimestampMs(turn),
        }));
    }

    return envelopes;
}
```

- [ ] **Step 6: Use ordered backfill in `runCodex.ts`**

In `packages/happy-cli/src/codex/runCodex.ts`, add:

```ts
import { buildCodexThreadBackfillEnvelopes } from './utils/threadImageBackfill';
```

In the `HAPPY_FORK_CODEX_THREAD_ID` block, replace:

```ts
                const envelopes = mapCodexThreadToSessionEnvelopes(thread);
```

with:

```ts
                const envelopes = await buildCodexThreadBackfillEnvelopes({
                    thread,
                    uploadLocalImage: (attachment, imageOpts) => (
                        session.uploadLocalImageAttachmentEnvelope(attachment, imageOpts)
                    ),
                });
```

Remove `mapCodexThreadToSessionEnvelopes` from the `runCodex.ts` import list if it is no longer used there.

- [ ] **Step 7: Run mapper and backfill tests**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit src/codex/__tests__/sessionProtocolMapper.test.ts src/codex/utils/threadImageBackfill.test.ts src/api/apiSession.test.ts
pnpm --dir packages/happy-cli typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit fork backfill changes**

Run:

```bash
git add packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts \
  packages/happy-cli/src/codex/__tests__/sessionProtocolMapper.test.ts \
  packages/happy-cli/src/codex/utils/threadImageBackfill.ts \
  packages/happy-cli/src/codex/utils/threadImageBackfill.test.ts \
  packages/happy-cli/src/codex/runCodex.ts
git commit -m "feat(cli): backfill codex image history"
```

### Task 8: Final Verification And Manual Smoke Test

**Files:**
- All changed files.

- [ ] **Step 1: Run targeted app checks**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/sync/attachmentSupport.test.ts
pnpm --dir packages/happy-app typecheck
```

Expected: PASS.

- [ ] **Step 2: Run targeted CLI unit checks**

Run:

```bash
pnpm --dir packages/happy-cli exec vitest run --project unit \
  src/codex/codexClearCommand.test.ts \
  src/codex/codexAppServerClient.test.ts \
  src/codex/utils/imageInput.test.ts \
  src/codex/utils/attachmentEvents.test.ts \
  src/codex/utils/threadImageBackfill.test.ts \
  src/codex/__tests__/sessionProtocolMapper.test.ts \
  src/api/apiSession.test.ts
pnpm --dir packages/happy-cli typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full CLI package tests**

Run:

```bash
pnpm --dir packages/happy-cli test
```

Expected: PASS. This command builds the CLI and runs the unit Vitest project.

- [ ] **Step 4: Run diff hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` prints nothing. `git status --short` shows only intended source and test changes if a final commit has not been created yet.

- [ ] **Step 5: Manual Codex smoke test**

Start the local server, CLI daemon, and web app in separate terminals:

```bash
pnpm --filter happy-server standalone:dev
```

```bash
pnpm --filter happy cli:install
HAPPY_HOME_DIR=~/.happy-dev HAPPY_SERVER_URL=http://localhost:3005 happy daemon stop
HAPPY_HOME_DIR=~/.happy-dev HAPPY_SERVER_URL=http://localhost:3005 happy daemon start
HAPPY_HOME_DIR=~/.happy-dev HAPPY_SERVER_URL=http://localhost:3005 happy auth
```

```bash
EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3005 pnpm --filter happy-app web
```

In the Happy web app, open or create a Codex session, attach a small PNG image with text, and send it.

Expected:
- the app shows the image bubble before the text bubble
- the Codex CLI log records a `file` event and a generated local image input count without logging bytes, base64, presigned URLs, or local cache paths
- `turn/start` input contains a `localImage` item
- Codex responds to the image instead of receiving text only

- [ ] **Step 6: Manual unsupported-agent smoke test**

Open a Gemini or OpenClaw session with the image upload feature enabled. Send an image-only message.

Expected:
- the app shows the unsupported image alert
- no empty user text message appears in the chat
- no server outbox text message is created for the image-only attempt

- [ ] **Step 7: Manual Codex fork smoke test**

From a Codex session that previously received a Happy image attachment, create a fork or duplicate session on the same machine.

Expected:
- the new Happy session displays historical image file events in the correct order before the matching user text
- if a provider `localImage.path` no longer exists, text history still appears and no fake image bubble is created

- [ ] **Step 8: Final commit**

If Task 8 revealed fixes, commit them:

```bash
git add packages/happy-app packages/happy-cli
git commit -m "test: verify codex image attachments"
```

If Task 8 did not require code changes, do not create an empty commit.

## Self-Review Checklist

- Spec coverage: app support gate, Codex CLI file-event drain, `localImage` app-server input, local cache, image-only messages, unsupported image-only rejection, encrypted server storage, and fork backfill are each covered by a task.
- Side-effect boundary: `sessionProtocolMapper.ts` remains pure; `threadImageBackfill.ts` is the only Codex provider-history helper that reads files and calls the upload callback.
- History ordering: backfilled file envelopes are inserted before the matching user text envelope and image-only provider messages can produce a file envelope without an empty text envelope.
- Privacy: generated cache file names and generated backfill upload names do not derive from original user names or local provider paths; logs do not include bytes, base64, presigned URLs, or local cache paths.
- Verification: targeted tests exist for app gate, queue attachment forwarding, app-server input shape, image byte detection/cache writes, file-event download, upload envelope metadata, mapper stability, and ordered image backfill.
