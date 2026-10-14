#if canImport(UIKit)
import UIKit

/// Keeps the chat's composer out of sight until its opening draft is read
/// and measured (`ChatComposerView.isRestored`), so its first frame is its
/// last: a restored draft doesn't open as one line and jump to three.
///
/// Only the composer is hidden (alpha 0), never the list or the bars above
/// it. A hidden view takes no touches, so `catcher`, in the dock over the
/// composer, takes them meanwhile: a tap there focuses the composer, which
/// shows it at once, and never sends, wherever it lands. The composer
/// gives up waiting by itself after `ChatComposerRestore.timeout`.
///
/// It shows when the composer reports the restore for its current
/// generation (a report for the chat before a retarget is not this one),
/// or when the chat finds it restored right after reading its height, in
/// that layout pass. Either way at once, unanimated, and the catcher goes.
@MainActor
final class ChatComposerReveal {
    private let composer: any ChatComposerView
    /// Over the hidden composer, in the dock; gone once it shows.
    let catcher = UIControl()
    private(set) var isRevealed = false

    init(composer: any ChatComposerView) {
        self.composer = composer
        catcher.backgroundColor = .clear
        catcher.isAccessibilityElement = false
        catcher.addAction(UIAction { [weak self] _ in self?.caught() }, for: .touchUpInside)
        if composer.isRestored {
            reveal()
        } else {
            composer.alpha = 0
        }
    }

    /// The composer reported its restore (`composerDidRestore`).
    func restored(generation: Int) {
        guard generation == composer.restoreGeneration, composer.isRestored else { return }
        reveal()
    }

    /// Right after the chat read the composer's height: a restore made
    /// while answering shows in the frame being laid out.
    func heightRead() {
        if composer.isRestored { reveal() }
    }

    /// The catcher covers the composer's frame (in the dock), no more.
    func layout(composerFrame: CGRect) {
        guard !isRevealed else { return }
        catcher.frame = composerFrame
    }

    /// A tap on the hidden composer: it is focused, which shows it.
    private func caught() {
        composer.focus()
        heightRead()
    }

    private func reveal() {
        guard !isRevealed else { return }
        isRevealed = true
        UIView.performWithoutAnimation {
            composer.alpha = 1
            catcher.isHidden = true
            catcher.removeFromSuperview()
        }
    }
}
#endif
