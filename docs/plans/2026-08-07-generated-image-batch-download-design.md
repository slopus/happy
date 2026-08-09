# Generated Image Batch Download Design

Date: 2026-08-07

## Context

Happy now groups generated image batches into one responsive gallery and renders results incrementally. A single batch can contain dozens of original images (for example, 56 outputs from seven sources, four styles, and two variants). The gallery needs one batch action that saves every successful output as an individual original file without recompression.

The existing image viewer already downloads or shares one resolved image. The batch feature should build on the same decrypted image sources while avoiding dozens of native share sheets, duplicate filenames, and broad Android photo-library permissions.

## Product Behavior

- Show one batch download action only for the `generated-grid` presentation when at least two images belong to the group.
- While generation or attachment resolution is incomplete, show `Preparing n/total` and keep the action disabled.
- When all successful outputs are ready, show `Download all n images`.
- A single press starts a sequential batch and changes the action to `Downloading n/total`.
- Preserve each image's original bytes and extension. Do not resize, recompress, or convert images.
- Prefix filenames with a stable, zero-padded ordinal and sanitize the original name so duplicate source names cannot overwrite one another.
- Continue after an individual failure. At completion, report saved and failed counts.
- Retain failed items in memory for a `Retry failed` action without downloading successful items again.
- Disable repeated presses while a batch is active.

If generation ends with fewer successful outputs than originally requested, the completed gallery downloads the successful images that actually exist.

## Platform Strategy

### Web

Resolve each decrypted URI and trigger a separate browser download for each original file. Downloads run sequentially to bound memory use and expose progress. Browsers may ask the user once to allow multiple automatic downloads; the UI cannot reliably suppress or detect that browser-level prompt.

### Android

Use Expo FileSystem's Storage Access Framework. The user selects a destination directory once, then Happy writes every original image into that directory. This preserves the current Android policy that blocks broad media-library read permissions and avoids reopening `READ_MEDIA_IMAGES` or legacy external-storage permissions.

Canceling the directory picker cancels the batch without counting every image as failed.

### iOS

Stage each resolved source as a local file and add it to Photos with write-only access. Add `expo-media-library` and configure only `NSPhotoLibraryAddUsageDescription`; do not request photo-library read access. The permission prompt appears once and the batch then saves images sequentially.

Adding the native module requires a new iOS application build before this feature can be delivered there. An OTA containing the feature must not target an older runtime that lacks the module.

Runtime isolation is explicit: development/preview move from runtime 21 to 22 and production moves from 22 to 23. `app.config.js`, OTA publishing, and rollback all consume one shared runtime mapping, so existing binaries remain on their compatible OTA lanes. No OTA may be published for this feature until a new native build containing `expo-media-library` is installed.

The platform APIs and permission boundaries follow the Expo SDK 55 documentation:

- https://docs.expo.dev/versions/v55.0.0/sdk/filesystem-legacy/
- https://docs.expo.dev/versions/v55.0.0/sdk/media-library-next/

## Architecture

Introduce a platform-specific batch-download adapter with one shared contract:

```ts
type ImageBatchDownloadItem = {
    id: string;
    uri: string;
    filename: string;
};

type ImageBatchDownloadResult = {
    succeeded: string[];
    failed: Array<{ id: string; error: Error }>;
    cancelled: boolean;
};
```

The shared coordinator owns ordering, unique filename generation, sequential processing, progress callbacks, cancellation, and partial-failure aggregation. Platform files own only the final write mechanism:

- `imageBatchDownload.web.ts`: browser anchors and resolved blob/data/HTTP sources.
- `imageBatchDownload.android.ts`: one SAF directory grant and individual file writes.
- `imageBatchDownload.ios.ts`: local staging and write-only Photos insertion.

`AttachmentGalleryView` continues collecting resolved decrypted URIs from thumbnails. The generated grid derives its readiness from the current image descriptors, pending count, and resolved URI map. Resolution must update React state for the button because the current viewer-only URI map intentionally uses a ref and does not re-render.

The existing single-image download stays unchanged. Shared filename and source-staging helpers may be extracted where doing so removes duplication without changing viewer behavior.

## UI States

The generated-grid header contains progress on the left and the batch action on the right.

- Generating: spinner, `Generating n/total`; action `Preparing n/total`, disabled.
- Resolving: generation complete but some decrypted URIs are not ready; action `Preparing n/total`, disabled.
- Ready: action `Download all n images`, enabled.
- Downloading: action spinner and `Downloading n/total`, disabled.
- Partial failure: non-blocking summary with `Saved x images; y failed` and `Retry failed`.
- Permission denied or directory canceled: clear platform-specific guidance; no false success message.
- Complete: confirmation with the number saved and the destination (`Downloads folder` on Android, `Photos` on iOS, browser downloads on Web).

Accessibility labels include the current state and counts. The action remains compact enough for the mobile two-column gallery and must not introduce horizontal overflow.

## Verification

Follow test-driven development:

1. Shared unit tests cover stable ordering, sanitization, duplicate names, progress, cancellation, partial failure, and retry-only-failed behavior.
2. Platform adapter tests mock browser downloads, Android SAF, and iOS write-only media insertion.
3. Component tests cover disabled/ready/busy states, progress text, duplicate-press prevention, success, and retry.
4. Existing gallery and single-image download tests remain green.
5. Web E2E drives the deterministic 56-image demo, downloads all 56 files, verifies unique expected filenames, confirms progress disappears, and asserts no layout overflow.
6. Typecheck, focused tests, the full Happy App test suite, and repository diff checks pass before handoff.

Native simulator or real-device validation is a separate step because it requires a rebuilt binary and explicit runtime approval.
