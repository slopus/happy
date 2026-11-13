# Photo editor artwork

Artwork from Telegram-iOS, adapted with Steve Korshakov's personal
permission recorded on 2026-10-31 (see `packages/happy-ios/AGENTS.md`).
Source revision: `24638bc69bd083981b178dd1e7f921eebbf7fc46`.

`PhotoEditor.xcassets/PhotoEditor*.imageset` contains the original files from
`submodules/TelegramUI/Images.xcassets/Media Editor`: Crop, Pencil, Rotate,
Mirror, Undo, Redo, Eyedropper, Close, Done, RoundSpectrum and the ToolPen, ToolArrow,
ToolMarker, ToolNeon, ToolBlur and ToolEraser shells, tips and shadows.
The tool bodies are displayed at half of Telegram's 40 × 176 source size,
as `DrawingUI/Sources/ToolsComponent.swift` does in its resting tool row.

The crop wheel and needle are from
`submodules/LegacyComponents/Resources/LegacyComponentsResources.bundle/PhotoEditorRotation{Wheel,Needle}@2x.png`.
The original binary artwork is unchanged. Image-set names are prefixed
to avoid collisions with other app artwork. UIKit composition, tool
state, geometry and rendering are implemented in Happy's own structure.
Back is from `TelegramUI/Images.xcassets/Navigation/Back.imageset`;
AspectRatio is from `LegacyComponents/LegacyImages.xcassets/Editor/AspectRatio.imageset`.