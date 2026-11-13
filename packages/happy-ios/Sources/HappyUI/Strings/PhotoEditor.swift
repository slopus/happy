import Foundation

// The "+" menu's photo editor, as Telegram's says it (`PhotoEditor.*`,
// `Paint_*`, `Media.*`).
extension Strings {
    public enum PhotoEditor {
        public static let crop = "Crop"
        public static let draw = "Draw"
        public static let applied = "Edited"
        public static let cancel = "Cancel"
        public static let done = "Done"
        /// The crop's (`PhotoEditor.CropReset`, `CropAspectRatio*`).
        public static let reset = "Reset"
        public static let rotate = "Rotate"
        public static let mirror = "Mirror"
        public static let aspect = "Aspect Ratio"
        public static let original = "Original"
        public static let square = "Square"
        public static let discard = "Discard Changes"
        /// The drawing's (`Paint_*`).
        public static let undo = "Undo"
        public static let redo = "Redo"
        public static let clear = "Clear"
        public static let clearAll = "Clear All"
        public static let zoomOut = "Zoom Out"
        public static let size = "Size"
        public static let color = "Color"
        public static func tool(_ tool: String) -> String {
            switch tool {
            case "pen": return "Pen"
            case "arrow": return "Arrow"
            case "marker": return "Marker"
            case "neon": return "Neon"
            case "blur": return "Blur"
            default: return "Eraser"
            }
        }
        /// The colour sheet's (`Paint_Color*`).
        public static let colors = "Colors"
        public static let grid = "Grid"
        public static let spectrum = "Spectrum"
        public static let opacity = "OPACITY"
        public static let eyedropper = "Eyedropper"
        public static let close = "Close"
        /// The camera's shots, counted at its top right.
        public static func shots(_ count: Int) -> String { count == 1 ? "1 photo" : "\(count) photos" }
    }
}
