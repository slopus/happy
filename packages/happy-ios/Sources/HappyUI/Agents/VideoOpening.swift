#if canImport(UIKit)
import AVKit
import UIKit

/// Telegram's tap on a video's play button: it plays at once from what is
/// on this phone and what streams in (`MediaStream`), never after the whole
/// file. Until its first playable range is here the tile's play glyph turns
/// into a small spinner (`DownloadRings.setStarting`); then the system's
/// player comes up playing. A second tap while it spins gives up, and the
/// file reads on behind.
@MainActor
final class VideoOpening {
    static let shared = VideoOpening()

    private struct Starting {
        let boardKey: String?
        let player: AVPlayer
        weak var presenter: UIViewController?
        let failed: (() -> Void)?
        var observation: NSKeyValueObservation?
    }

    private var starting: Starting?
    /// The player last brought up, for tests.
    private(set) weak var presented: AVPlayerViewController?

    /// Whether a video is starting, and which.
    var isStarting: Bool { starting != nil }
    var startingKey: String? { starting?.boardKey }

    /// Plays what `player` makes from `presenter` once it can, the tiles of
    /// `boardKey` spinning till then; false when there is nothing to play.
    /// A tap on the one already starting stops it instead.
    @discardableResult
    func open(boardKey: String?, from presenter: UIViewController, failed: (() -> Void)? = nil, player make: () -> AVPlayer?) -> Bool {
        if let current = starting, current.boardKey != nil, current.boardKey == boardKey {
            cancel()
            return true
        }
        guard let player = make() else { return false }
        cancel()
        guard let item = player.currentItem, item.status != .readyToPlay else {
            present(player, from: presenter)
            return true
        }
        starting = Starting(boardKey: boardKey, player: player, presenter: presenter, failed: failed)
        if let boardKey { DownloadRings.shared.setStarting(boardKey, true) }
        let id = ObjectIdentifier(player)
        starting?.observation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            let status = item.status
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.changed(status, of: id) }
            }
        }
        return true
    }

    /// Lets go of a video still starting.
    func cancel() {
        guard let current = starting else { return }
        starting = nil
        current.observation?.invalidate()
        current.player.pause()
        current.player.replaceCurrentItem(with: nil)
        if let key = current.boardKey { DownloadRings.shared.setStarting(key, false) }
    }

    private func changed(_ status: AVPlayerItem.Status, of id: ObjectIdentifier) {
        guard let current = starting, ObjectIdentifier(current.player) == id, status != .unknown else { return }
        starting = nil
        current.observation?.invalidate()
        if let key = current.boardKey { DownloadRings.shared.setStarting(key, false) }
        guard status == .readyToPlay else {
            current.failed?()
            return
        }
        // Gone from the screen meanwhile: it isn't brought up over another.
        guard let presenter = current.presenter, presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else { return }
        present(current.player, from: presenter)
    }

    private func present(_ player: AVPlayer, from presenter: UIViewController) {
        let playback = AVPlayerViewController()
        playback.player = player
        presented = playback
        presenter.present(playback, animated: true) { player.play() }
    }
}
#endif
