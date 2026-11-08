import Foundation
import HappyCore

extension Strings {
    /// Settings › Appearance › Shimmer in Low Power Mode (`LowPowerShimmer`).
    /// Not in happy-app's catalogs: every language's are in
    /// `TranslationCatalog.nativeSources` (`lowPowerShimmerSources`).
    enum LowPowerShimmer {
        static var title: String { localized("native.lowPowerShimmer.title", "Shimmer in Low Power Mode") }
        static var description: String {
            localized("native.lowPowerShimmer.description", "Running work keeps its shimmer while Low Power Mode is on. Uses more battery.")
        }
    }
}
