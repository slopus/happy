#if canImport(UIKit)
import Foundation

/// Measures rows off the main thread and remembers what it measured.
///
/// A row is measured once per (id, width, input): streaming re-measures
/// only the message that grew, and scrolling never measures at all, because
/// every row in the list was measured before it was inserted. The cache
/// keeps only the rows of the latest call, so it is as big as the window.
actor ChatRowMeasurer {
    private struct Entry {
        var width: CGFloat
        var input: ChatRowInput
        var plan: ChatRowPlan
    }

    private var cache: [String: Entry] = [:]
    private var footerCache: (controlledByUser: Bool, width: CGFloat, plan: ChatRowPlan)?

    func plans(_ inputs: [ChatRowInput], width: CGFloat) -> [ChatRowPlan] {
        var next: [String: Entry] = [:]
        next.reserveCapacity(inputs.count)
        let plans = inputs.map { input in
            if let cached = cache[input.id] ?? next[input.id], cached.width == width, cached.input == input {
                next[input.id] = cached
                return cached.plan
            }
            let plan = ChatRowRenderer.plan(input, width: width)
            next[input.id] = Entry(width: width, input: input, plan: plan)
            return plan
        }
        cache = next
        return plans
    }

    /// The ChatFooter past the newest message.
    func footer(controlledByUser: Bool, width: CGFloat) -> ChatRowPlan {
        if let cached = footerCache, cached.controlledByUser == controlledByUser, cached.width == width { return cached.plan }
        let plan = ChatRowRenderer.footer(controlledByUser: controlledByUser, width: width)
        footerCache = (controlledByUser, width, plan)
        return plan
    }
}
#endif
