#if canImport(UIKit)
import HappyCore
import QuartzCore
import UIKit

/// One account's link as its headers show it (`LinkStateDebounce`): told
/// what the link is as often as that changes, it says what to show only
/// when a header should change. Each account kind keeps one, so home's
/// title and its chats' subtitles change together: the agent's `Session`
/// and the legacy account's `LegacyLink`.
@MainActor
final class LinkIndicator {
    private var debounce: LinkStateDebounce
    private let clock: () -> TimeInterval
    private var wake: DispatchWorkItem?
    private var watchers: [UUID: (LinkState) -> Void] = [:]

    /// What headers show now.
    var shown: LinkState { debounce.shown }
    /// What the link is, as last told.
    var wanted: LinkState { debounce.wanted }

    init(wanted: LinkState, clock: @escaping () -> TimeInterval = CACurrentMediaTime) {
        self.clock = clock
        debounce = LinkStateDebounce(wanted: wanted, now: clock())
        schedule(debounce.settle(now: clock()))
    }

    /// The link is now `state`.
    func want(_ state: LinkState) {
        let before = debounce.shown
        let due = debounce.want(state, now: clock())
        schedule(due)
        if debounce.shown != before { tell() }
    }

    /// Calls `watch` with what headers show, now and on every change.
    func watch(_ watch: @escaping (LinkState) -> Void) -> Watch {
        let id = UUID()
        watchers[id] = watch
        watch(debounce.shown)
        return Watch { [weak self] in self?.watchers.removeValue(forKey: id) }
    }

    private func schedule(_ due: TimeInterval?) {
        wake?.cancel()
        wake = nil
        guard let due else { return }
        let item = DispatchWorkItem { [weak self] in self?.settle() }
        wake = item
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, due - clock()), execute: item)
    }

    private func settle() {
        let before = debounce.shown
        schedule(debounce.settle(now: clock()))
        if debounce.shown != before { tell() }
    }

    private func tell() {
        let shown = debounce.shown
        for watch in watchers.values { watch(shown) }
    }
}
#endif
