#if canImport(UIKit)
import HappyCore
import Lottie
import UIKit

/// A `tgs` sticker played by Lottie, as Telegram plays its animated
/// stickers: looping, on the Core Animation engine, so the frames are
/// rendered by the render server rather than drawn on the main thread.
/// The Lottie JSON (`?as=lottie`, kept on disk by `StoriesMedia`) is read
/// and decoded off the main thread; until it arrives the view is empty.
/// It plays only while asked to, which its owner ties to being on screen.
@MainActor
final class StoryStickerLottiePlayer: StoryStickerAnimating {
    let view: UIView
    private let animationView: LottieAnimationView
    private var loading: Task<Void, Never>?
    private var playing = false

    /// Whether frames are moving now: asked to play, loaded and on screen.
    var isAnimating: Bool { animationView.isAnimationPlaying }
    /// Whether the animation has arrived.
    var isLoaded: Bool { animationView.animation != nil }

    init(sticker: Sticker, media: StoriesMedia) {
        animationView = Self.makeView()
        view = animationView
        loading = Task { [weak self] in
            guard let data = await media.stickerFile(sticker) else { return }
            let animation = await Task.detached(priority: .userInitiated) { Self.decode(data) }.value
            guard let self, !Task.isCancelled, let animation else { return }
            self.show(animation)
        }
    }

    /// For a file already in hand (tests, previews).
    init(data: Data) {
        animationView = Self.makeView()
        view = animationView
        if let animation = Self.decode(data) { show(animation) }
    }

    deinit { loading?.cancel() }

    private static func makeView() -> LottieAnimationView {
        let view = LottieAnimationView(configuration: LottieConfiguration(renderingEngine: .coreAnimation))
        view.contentMode = .scaleAspectFit
        view.loopMode = .loop
        view.backgroundBehavior = .pauseAndRestore
        return view
    }

    func setPlaying(_ playing: Bool) {
        self.playing = playing
        apply()
    }

    private func show(_ animation: LottieAnimation) {
        animationView.animation = animation
        apply()
    }

    private func apply() {
        // What it was asked, whether or not frames can move yet.
        view.accessibilityValue = playing ? "playing" : "paused"
        guard animationView.animation != nil else { return }
        if playing {
            if !animationView.isAnimationPlaying { animationView.play() }
        } else {
            // Also drops a play Lottie queued for when it reaches a window.
            animationView.pause()
        }
    }

    nonisolated static func decode(_ data: Data) -> LottieAnimation? {
        try? LottieAnimation.from(data: data)
    }
}
#endif
