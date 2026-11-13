# Camera

One camera engine serves every screen that shows the camera: the QR
scanner, the attach menu's live tile and the full-screen camera it opens.
It is modelled on Telegram-iOS's camera (`submodules/Camera`,
`submodules/TelegramUI/Components/CameraScreen`, the legacy
`TGCameraController` in `LegacyComponents`), ported into this app's
structure, and aims at the system camera's features where AVFoundation
allows them.

This file grows with the work. It lands in three steps:

1. the shared engine, with the QR scanner on it (done);
2. the attach tile and the full-screen photo camera (done);
3. video and the rest of the system camera's features.

Until step 3 the camera takes photos only: the system picker it replaced
also recorded video, and that comes back with step 3.

## Architecture

```
screen (QRScannerViewController, AttachCameraTile, CameraViewController)
  │  run(config) / stop() / setZoom / focus / setExposureBias /
  │  setScanArea / capturePhoto                       main thread
  ▼
CameraEngine (protocol, @MainActor)
  ├── DeviceCamera        the device: preview layer, rotation, readiness,
  │     │                 photos in flight, state
  │     └── CaptureCore   the session, on its own serial queue
  └── FixtureCamera       a stand-in for the simulator and hosted tests
```

- **`CameraEngine`** (`Sources/HappyUI/Camera/CameraEngine.swift`) is what
  screens see. Every call returns at once on the main thread. What changes
  comes back as one `CameraState` value through `observe`: availability
  (ready, refused, restricted, no camera), running, previewing (the first
  picture is on screen), an interruption and why, the lenses and the zoom,
  the sensor's picture size, the preview's and the photo's rotation, the
  camera in use, flash (has one, would fire now), whether a photo can be
  taken now, the exposure slider, the device's warmth.
- **`preview`** is the engine's one picture, a `CameraPreviewView`. A
  screen adds it and sets its frame. It is one view so it can be handed on:
  the attach tile lends it to the full camera without the session
  stopping, and takes it back.
- **`DeviceCamera`** is the main-thread half: the
  `AVCaptureVideoPreviewLayer`, its `AVCaptureDevice.RotationCoordinator`
  (one per device, made again on a flip), the layer's `isPreviewing` (the
  first frame's time), the photo output's readiness coordinator, the photos
  in flight, the thermal state, and authorization: a run that may ask asks
  once; the tile's run never asks; with no camera at all (the simulator)
  nothing is asked. It stops the session when the last screen holding it
  lets it go.
- **`CaptureCore`** owns the `AVCaptureSession` and touches it only on its
  serial queue (`engineering.happy.camera`): configuring, starting,
  stopping, choosing the device, zoom, focus and exposure, frame rate,
  photo requests. A reconfiguration is one
  `beginConfiguration`/`commitConfiguration`, so a running session swaps
  mode or camera without stopping. Only the metadata delegate runs on the
  main queue, and its work is a few strings.
- **`FixtureCamera`** (Debug and fixture builds) records every call, shows
  a drawn picture, hands back that picture as a photo, and reports
  whatever a test tells it to. `-camera fake` (or `-attachCamera fake`)
  gives the app one for screenshots.

### Choosing the camera

The back camera is the first of the triple, dual-wide, dual and wide
cameras the device has; the front one is its wide camera. A virtual camera
with an ultra wide switches to it for a subject held close (macro), as the
Camera app does. Its zoom 1 is the ultra wide, so the engine starts at the
first switch-over factor, the wide camera, which is the Camera app's 1×.
`CameraLenses` (HappyCore) turns the device's switch-over factors and
full-resolution crops into the system camera's buttons (0.5, 1, 2, 5 on an
iPhone 15 Pro Max) and back.

### Rotation

The preview's `videoRotationAngle` follows the coordinator's
`videoRotationAngleForHorizonLevelPreview`, which follows both the device
and the window's interface, an iPad's split and Stage Manager windows
included. A photo takes the coordinator's
`videoRotationAngleForHorizonLevelCapture`, which follows how the device is
held whatever the screen's lock; the full camera, upright on a phone,
turns its buttons by the same angle (`CameraScreenLayout.iconRotation`).

### QR mode

`AVCaptureMetadataOutput` for `.qr`, at the `.high` preset. The rect of
interest is the viewfinder carried through the picture the preview shows
(`QRScannerLayout.scanArea`: aspect fill, the rotation, the sensor's size),
on every layout and turn. A camera that can't switch to an ultra wide
(a wide camera alone, as on an iPad Pro M4) zooms in until a 30 mm code
filling the viewfinder sits at its minimum focus distance
(`QRScannerLayout.focusZoom`, after Apple's AVCamBarcode), at most 3×.

### Photo mode

The `.photo` preset (the sensor's full 4:3) and an `AVCapturePhotoOutput`
set up as the system camera runs its own (`CaptureCore.preparePhoto`):

- **Zero shutter lag**: the photo is the moment the shutter was pressed,
  from frames already in hand.
- **Responsive capture and fast capture prioritization**: another shot can
  start while one is still processing, and a quick run of them trades
  quality for speed, as the system camera does.
- **Quality**: the output allows up to `.quality`; each shot asks for
  `.balanced`, as Telegram's does: the system's middle ground between
  speed and processing. `.quality`'s extra processing time buys detail
  the composer's 3072-pixel JPEG would throw away.
- **Size**: the smallest size that fills the composer's 3072 on its long
  edge (`CameraPhotoSize`): 12 MP, not 48.
- **Format**: HEIF where the camera writes it, as the Camera app does by
  default, else JPEG. The composer converts it to its JPEG either way.
- **Deferred start** (iOS 26): the photo output starts after the first
  preview frame, so it costs the preview nothing. It is on by default.
- **Readiness**: `AVCapturePhotoOutputReadinessCoordinator` tells the
  shutter at once whether a photo can be taken, while the request itself
  goes to the session queue (AVCam's arrangement).
- **Not used**:
  - Deferred photo processing: a deferred photo is only finished inside
    the Photos library, which never sees these photos.
  - Live Photos: a Live Photo is a still and a movie paired by an
    identifier, and the composer sends files one by one, with nothing on
    the other end to pair them back. Sending the movie alongside would
    show up as a second attachment, so Live Photos are off.
- The ultra wide's distortion is corrected, as in the Camera app.

**Front camera.** Its photos are mirrored as its preview is, so what was
seen is what is sent: Telegram's choice, and the Camera app's with
"Mirror Front Camera" on. It is one line to change
(`CaptureCore.preparePhoto`). Its flash is the screen: the system's own where the photo output
offers a front flash, else Telegram's white screen at full brightness, the
photo 0.1 s after, both let go 0.5 s later over 0.25 s. On auto, that
screen lights when the scene is darker than a dim room (EV 4.5 at ISO 100,
from the exposure the camera chose; `CameraExposure.isDark`).

**Shapes.** 4:3 is the sensor's picture. 16:9 and square are cut from its
middle when the composer reads the photo (`CameraCrop`,
`ComposerImageNormalizer`), read at the size that leaves the cut 3072
long. A square is therefore 3024 across, not 3072 shrunk to 2304.

### The full camera

`CameraViewController`, laid out by `CameraScreenLayout` and moving as
Telegram's camera does:

- **From the tile**: the picture grows out of the tile on a spring (0.4 s)
  while black comes up behind it and the buttons fade in; closing shrinks
  it back into the tile, still running. Without a tile it slides up and
  down.
- **Shutter**: Telegram's ring of 68 around a 60 disc; a press shrinks the
  disc to 0.8 over 0.3 s. The picture blinks in from black over 0.25 s as
  the exposure begins. The volume buttons and Camera Control take the
  photo too (`AVCaptureEventInteraction`).
- **Lenses**: Telegram's 37-point discs on a capsule, the lens in use in
  yellow showing the zoom as it stands ("1.4×"), the others at 0.7. A tap
  ramps the zoom (rate 16); a pinch sets it directly.
- **Focus and exposure**: a tap focuses and exposes there (Telegram's
  square: in from twice its size over 0.15 s, blinking for a second,
  dimmed to half, gone after); a long press locks both, with "AE/AF LOCK";
  a vertical drag while the square shows moves the exposure, two stops
  either way, the sun following the finger. A new tap resets it.
- **Flip**: at most once a second, the picture flips over (0.4 s) under a
  dark blur that lifts once the other camera's pictures come.
- **Buttons**: flash (auto, on, off; yellow when an auto flash would fire),
  timer (off, 3 s, 10 s, counted down over the picture; a press while it
  counts stops it), shape (4:3, 16:9, 1:1), grid (thirds). Flash, shape and
  grid are kept while the app runs.
- **Review**: the photo whole with Retake and Use Photo, as the system
  picker had. The camera stops while it shows. The attach menu's camera
  has no review; see below.
- **Phone and iPad**: the phone's screen stays upright and its buttons turn
  to read upright; an iPad turns with its window and keeps the controls in
  a column at the trailing edge.

The photo goes to the composer's `ComposerImagePicker.add(photo:)`,
converted as any picture is and kept in the account's staging folder until
sent. Nothing is written to a temporary file on the way.

### The attach menu's tile

`AttachCameraTile` runs the engine in photo mode on the back camera
(without asking for access) as soon as it is in a window, the app is in
front and it is scrolled into view, and stops it when any of that ends. A
tap opens the full camera over the menu on the same engine
(`AttachSheetViewController.openCamera`): the session keeps running,
nothing is reconfigured. As in Telegram the camera then keeps shooting:
each photo lands at the head of the menu's grid already picked and
numbered (`AttachEditingLibrary.add(shot:)`), the first one opens in the
viewer over the camera with the caption, the editor and send, and back
returns to the camera. The shots gather in a strip over the shutter (the
counter beside it opens and closes it; a thumbnail opens the viewer there).
Closing the camera gives the tile its picture back and leaves the menu with
the shots picked.

### Interruptions, warmth, failures

- `AVCaptureSession.wasInterruptedNotification` comes back as
  `CameraState.interruption`: another app using the camera, iPad
  multitasking, system pressure, a call, the background. The scanner and
  the full camera say why over the picture.
- Multitasking camera access is on wherever the iPad supports it.
- The thermal state caps the frame rate (`CameraThermal`: 30 at serious, 24
  at critical) before the system stops the camera itself.
- A runtime error (media services reset) starts the session again if it
  was meant to run.
- Refused, restricted, no camera: the full camera says so, with Settings
  for a refusal, and its shutter is off.

## Measurements

Written to the log, subsystem `engineering.happy`, category `camera`:

- `first frame N ms (photo)` / `(qr)`: from `run` to the preview's first
  picture. The tile's run logs it; the full camera opened from the tile
  logs none, because its picture never stopped.
- `started in N ms`, `configured … in N ms`: the session queue's work.
- `photo: shutter N ms`: from the press to the exposure beginning (the
  shutter's lag); `photo: file in N ms, K KB`: to the photo's bytes.
- The main thread's frames for a while after each event (`CameraPerf.watch`),
  as `<event>: longest frame N ms, L late of F`, for `qr-open`,
  `camera-open`, `lens-switch`, `flip`, `aspect`, `photo-capture`.

## Telegram's files and ours

| Telegram-iOS | Here |
| --- | --- |
| `Camera/Sources/Camera.swift` (`CameraProtocol`, `Camera.Configuration`) | `CameraEngine`, `CameraConfiguration` |
| `Camera/CameraLegacy/Sources/LegacyCamera.swift` (`CameraContext` on its queue) | `DeviceCamera` + `CaptureCore` |
| `Camera/CameraLegacy/Sources/CameraDevice.swift` (device choice, focus, zoom, torch) | `CaptureCore` (`camera(_:)`, `focus`, `zoom`) |
| `Camera/CameraLegacy/Sources/CameraOutput.swift` (metadata, photo settings) | `CaptureCore.metadataOutput`, `photoSettings`, `PhotoCapture` |
| `Camera/CameraLegacy/Sources/CameraPreviewView.swift` (`isPreviewing`) | `CameraPreviewView`, `DeviceCamera.previewing` |
| `CameraScreen/Sources/CameraScreen.swift` (flip, shutter blink, front flash) | `CameraViewController` |
| `CameraScreen/Sources/CaptureControlsComponent.swift` (shutter) | `CameraShutterButton` |
| `CameraScreen/Sources/ZoomComponent.swift` (lens buttons) | `CameraZoomBar` |
| `LegacyComponents/Sources/TGCameraFocusCrosshairsControl.m` (focus, exposure) | `CameraFocusView`, `CameraScreenLayout.exposure` |
| `LegacyComponents/Sources/PGCameraCaptureSession.m` (exposure bias) | `CameraExposure.bias` (±2 EV, the system camera's, not Telegram's ±6.8) |

## Checking on a device

The simulator has no camera. On a device, read the `camera` and `scan`
log lines in Console.app (filter: subsystem `engineering.happy`).

- QR: open the scanner (Start, or Settings › Connect).
- Photos: open a chat, tap "+", watch the tile come alive, tap it, take a
  photo with each lens and on the front camera, with flash, timer, shapes
  and grid; use one and send it.
