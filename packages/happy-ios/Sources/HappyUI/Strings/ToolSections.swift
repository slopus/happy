import Foundation
import HappyCore

extension Strings {
    /// Settings › Appearance › Group tool calls (`ToolSections`). Not in
    /// happy-app's catalogs: every language's are in
    /// `TranslationCatalog.nativeSources` (`toolSectionsSources`).
    enum ToolSections {
        static var title: String { localized("native.toolSections.title", "Group tool calls") }
        static var description: String {
            localized("native.toolSections.description", "In an agent's chat, each run of tool calls is one line: the latest call while it works, then a summary. Off, every call is a row of its own.")
        }
    }
}
