import Foundation
import HappyCore

// The tool views' copy that happy-app writes out. What they read with
// `t('key')` is `ChatWords`'s, in the language the rows were planned in.

extension Strings {
    public enum Tools {
        /// CommandView.tsx (not in en.ts)
        public static let commandNoOutput = "[Command completed with no output]"
    }
}
