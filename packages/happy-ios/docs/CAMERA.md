# Camera

One camera engine serves every screen that shows the camera: the QR
scanner, the attach menu's live tile and the full-screen camera it opens.
It is modelled on Telegram-iOS's camera (`submodules/Camera`,
`submodules/TelegramUI/Components/CameraScreen`), ported into this app's
structure, and aims at the system camera's features where AVFoundation
allows them.

This file grows with the work. It lands in three steps:

1. the shared engine, with the QR scanner on it (done);
2. the attach tile and the full-screen photo camera;
3. video and the rest of the system camera's features.

## Architecture

```
screen (QRScannerViewController, …)     main thread
  │  run(config) / stop() / setZoom / focus / setScanArea
  ▼
CameraEngine (protocol, @MainActor)
  ├── DeviceCamera        the device: preview layer, rotation, state
  │     └── CaptureCore   the session, on its own serial queue
  └── FixtureCamera       a stand-in for the simulator and hosted tests
```

- **`CameraEngine`** (`Sources/HappyUI/Camera/CameraEngine.swift`) is what
  screens see. Every call returns at once on the main thread. What changes
  comes back as one `CameraState` value through `observe`: availability
  (ready, refused, restricted, no camera), running, previewing (the first
  picture is on screen), an interruption and why, the lenses and the zoom,
  the sensor's picture size, the preview's rotation, the device's warmth.
- **`preview`** is the engine's one picture, a `CameraPreviewView`. A
  screen adds it and sets its frame. It is one view so it can be handed on:
  the attach tile gives it to the full camera without the session stopping
  (step 2).
- **`DeviceCamera`** is the main-thread half: the
  `AVCaptureVideoPreviewLayer`, its `AVCaptureDevice.RotationCoordinator`
  (one per device, made again on a flip), the layer's `isPreviewing` (the
  first frame's time), the thermal state, and authorization: a run that
  may ask asks once; the tile's run never asks; with no camera at all (the
  simulator) nothing is asked.
- **`CaptureCore`** owns the `AVCaptureSession` and touches it only on its
  serial queue (`engineering.happy.camera`): configuring, starting,
  stopping, choosing the device, zoom, focus and exposure, frame rate. A
  reconfiguration is one `beginConfiguration`/`commitConfiguration`, so a
  running session swaps mode or camera without stopping. Only the metadata
  delegate runs on the main queue, and its work is a few strings.
- **`FixtureCamera`** (Debug and fixture builds) records every call, shows
  a drawn picture and reports whatever a test tells it to.

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
included.

### QR mode

`AVCaptureMetadataOutput` for `.qr`, at the `.high` preset. The rect of
interest is the viewfinder carried through the picture the preview shows
(`QRScannerLayout.scanArea`: aspect fill, the rotation, the sensor's size),
on every layout and turn. A camera that can't switch to an ultra wide
(a wide camera alone, as on an iPad Pro M4) zooms in until a 30 mm code
filling the viewfinder sits at its minimum focus distance
(`QRScannerLayout.focusZoom`, after Apple's AVCamBarcode), at most 3×.

### Interruptions, warmth, failures

- `AVCaptureSession.wasInterruptedNotification` comes back as
  `CameraState.interruption`: another app using the camera, iPad
  multitasking, system pressure, a call, the background. The scanner says
  why in place of its hint.
- Multitasking camera access is on wherever the iPad supports it.
- The thermal state caps the frame rate (`CameraThermal`: 30 at serious, 24
  at critical) before the system stops the camera itself.
- A runtime error (media services reset) starts the session again if it
  was meant to run.

## Measurements

Written to the log, subsystem `engineering.happy`, category `camera`:

- `first frame N ms (qr)`: from `run` to the preview's first picture.
- `started in N ms`, `configured … in N ms`: the session queue's work.
- `qr-open: longest frame N ms, L late of F`: the main thread's frames
  for a second from the scanner's appearance (`CameraPerf.watch`).

## Telegram's files and ours

| Telegram-iOS | Here |
| --- | --- |
| `Camera/Sources/Camera.swift` (`CameraProtocol`, `Camera.Configuration`) | `CameraEngine`, `CameraConfiguration` |
| `Camera/CameraLegacy/Sources/LegacyCamera.swift` (`CameraContext` on its queue) | `DeviceCamera` + `CaptureCore` |
| `Camera/CameraLegacy/Sources/CameraDevice.swift` (device choice, focus, zoom, torch) | `CaptureCore` (`camera(_:)`, `focus`, `zoom`) |
| `Camera/CameraLegacy/Sources/CameraOutput.swift` (metadata) | `CaptureCore.metadataOutput` |
| `Camera/CameraLegacy/Sources/CameraPreviewView.swift` (`isPreviewing`) | `CameraPreviewView`, `DeviceCamera.previewing` |

## Checking on a device

The simulator has no camera. On a device, open the scanner (Start, or
Settings › Connect) and read the `camera` and `scan` log lines in Console.
