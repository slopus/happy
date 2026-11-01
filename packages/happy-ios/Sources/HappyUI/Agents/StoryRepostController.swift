#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import UIKit
import os

/// Reposts with a caption and an optional front-camera video, capped at 15 seconds.
@MainActor
final class StoryRepostController: UIViewController, AVCaptureFileOutputRecordingDelegate {
    #if DEBUG
    /// What a simulator, which has no camera, records: the harness's file.
    static var debugRecording: URL?
    #endif
    private let client: AgentClient
    private let storyId: String
    private let done: (Bool) -> Void
    /// Configured, started and stopped on `queue`, never on the main thread.
    private nonisolated(unsafe) let session = AVCaptureSession()
    private nonisolated(unsafe) let output = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "engineering.happy.story-repost")
    private let preview = AVCaptureVideoPreviewLayer()
    private let round = StoryPlayerView()
    private var looper: AVPlayerLooper?
    private let record = UIButton(type: .system), post = UIButton(type: .system), cancel = UIButton(type: .system)
    private let caption = UITextField()
    private(set) var recorded: URL?
    private nonisolated(unsafe) var owned: URL?
    private let closing = OSAllocatedUnfairLock(initialState: false)
    private(set) var recording = false {
        didSet {
            post.isEnabled = !recording
            record.setTitle(recording ? Strings.Stories.stop : Strings.Stories.record, for: .normal)
        }
    }

    init(client: AgentClient, storyId: String, done: @escaping (Bool) -> Void) {
        (self.client, self.storyId, self.done) = (client, storyId, done)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit { if let owned { try? FileManager.default.removeItem(at: owned) } }

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        (round.clipsToBounds, round.backgroundColor, round.playerLayer.videoGravity) = (true, .darkGray, .resizeAspectFill)
        (preview.session, preview.videoGravity) = (session, .resizeAspectFill)
        round.layer.addSublayer(preview)
        for (button, title, action) in [(record, Strings.Stories.record, #selector(recordTapped)), (post, Strings.Stories.post, #selector(postTapped)), (cancel, Strings.Stories.cancel, #selector(cancelTapped))] {
            button.tintColor = .white
            button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
            button.setTitle(title, for: .normal)
            button.addTarget(self, action: action, for: .touchUpInside)
        }
        (record.backgroundColor, record.layer.cornerRadius) = (.systemRed, StoryLayout.Metrics.bar / 2)
        (caption.textColor, caption.borderStyle, caption.layer.cornerRadius, caption.layer.borderWidth) = (.white, .none, StoryLayout.Metrics.bar / 2, 1)
        caption.layer.borderColor = UIColor.white.withAlphaComponent(0.5).cgColor
        caption.attributedPlaceholder = NSAttributedString(string: Strings.Stories.caption, attributes: [.foregroundColor: UIColor.white.withAlphaComponent(0.6)])
        (caption.leftView, caption.leftViewMode) = (UIView(frame: CGRect(x: 0, y: 0, width: 16, height: 1)), .always)
        [round, record, caption, post, cancel].forEach(view.addSubview)
        Task { await startCamera() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = StoryLayout.repost(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets))
        (cancel.frame, post.frame, round.frame, record.frame, caption.frame) = (layout.cancel, layout.post, layout.round, layout.record, layout.caption)
        (round.layer.cornerRadius, preview.frame) = (layout.round.width / 2, round.bounds)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        closing.withLock { $0 = true }
        nonisolated(unsafe) let session = session
        queue.async { session.stopRunning() }
    }

    private func startCamera() async {
        guard await AVCaptureDevice.requestAccess(for: .video) else { return }
        let sound = await AVCaptureDevice.requestAccess(for: .audio)
        let closing = closing
        guard !closing.withLock({ $0 }) else { return }
        nonisolated(unsafe) let (session, output) = (session, output)
        queue.async {
            guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
                  let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { return }
            session.beginConfiguration()
            session.sessionPreset = .medium
            session.addInput(input)
            if sound, let mic = AVCaptureDevice.default(for: .audio), let audio = try? AVCaptureDeviceInput(device: mic), session.canAddInput(audio) { session.addInput(audio) }
            if session.canAddOutput(output) { session.addOutput(output) }
            output.maxRecordedDuration = CMTime(seconds: 15, preferredTimescale: 600)
            session.commitConfiguration()
            guard !closing.withLock({ $0 }) else { return }
            session.startRunning()
        }
    }

    @objc func recordTapped() {
        if recording { return output.stopRecording() }
        discard()
        #if DEBUG
        if let file = Self.debugRecording { return finished(file) }
        #endif
        guard session.isRunning else { return }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
        output.startRecording(to: file, recordingDelegate: self)
        began(file)
    }

    func began(_ file: URL) { (owned, recording) = (file, true) }

    private func discard() {
        (looper, round.playerLayer.player, preview.isHidden, recorded) = (nil, nil, false, nil)
        if let owned { try? FileManager.default.removeItem(at: owned) }
        owned = nil
    }

    nonisolated func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo url: URL, from connections: [AVCaptureConnection], error: Error?) {
        // Reaching the length limit ends a recording that is still whole.
        let whole = error == nil || (error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool == true
        Task { @MainActor in self.finished(whole ? url : nil) }
    }

    /// Loops a completed recording; discards a failed one.
    private func finished(_ url: URL?) {
        recording = false
        guard let url else { return discard() }
        recorded = url
        let player = AVQueuePlayer()
        (looper, round.playerLayer.player, preview.isHidden) = (AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url)), player, true)
        player.play()
    }

    @objc func postTapped() {
        guard !recording else { return }
        post.isEnabled = false
        let (text, recorded, client, storyId) = (caption.text, recorded, client, storyId)
        Task { [weak self] in
            var ok = true
            do {
                let round: Data? = if let recorded { try await Self.mp4(recorded) } else { nil }
                try await client.repostStory(storyId, caption: text, round: round)
            } catch { ok = false }
            self?.discard()
            let done = self?.done
            self?.dismiss(animated: true) { done?(ok) }
        }
    }

    @objc private func cancelTapped() { dismiss(animated: true) }

    /// H.264 in an MP4, small enough to send.
    private nonisolated static func mp4(_ url: URL) async throws -> Data {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        defer { try? FileManager.default.removeItem(at: out) }
        guard let export = AVAssetExportSession(asset: AVURLAsset(url: url), presetName: AVAssetExportPreset640x480) else { throw CocoaError(.fileWriteUnknown) }
        try await export.export(to: out, as: .mp4)
        return try Data(contentsOf: out)
    }
}
#endif
