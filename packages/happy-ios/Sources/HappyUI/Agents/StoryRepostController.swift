#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import UIKit
import os

/// One composer for gallery media and reposts; layers use normalized centers.
@MainActor
final class StoryRepostController: UIViewController, AVCaptureFileOutputRecordingDelegate, UITextViewDelegate {
    enum Source { case repost(Story), gallery(URL, String) }
    #if DEBUG
    /// What a simulator, which has no camera, records: the harness's file.
    static var debugRecording: URL?
    #endif
    private let client: AgentClient
    private let source: Source
    private let library: MediaLibrary?
    private let done: (Bool) -> Void
    /// Configured, started and stopped on `queue`, never on the main thread.
    private nonisolated(unsafe) let session = AVCaptureSession()
    private nonisolated(unsafe) let output = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "engineering.happy.story-repost")
    private let preview = AVCaptureVideoPreviewLayer()
    private let round = StoryPlayerView()
    private let base = StoryPlayerView(), picture = UIImageView()
    private var basePlayer: AVPlayer?, stream: MediaStream?
    private var looper: AVPlayerLooper?
    private let record = UIButton(type: .system), post = UIButton(type: .system), cancel = UIButton(type: .system), text = UIButton(type: .system), camera = UIButton(type: .system), remove = UIButton(type: .system)
    private let caption = UITextView()
    private let comment = UITextView(), placeholder = UILabel()
    private let material = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private var textPosition = CGPoint(x: 0.5, y: 0.5), roundPosition = CGPoint(x: 0.2, y: 0.2)
    private var cameraAdded = false, cameraStarted = false, cameraStarting = false, resetting = false, posting = false
    private var keyboard: CGFloat = 0
    private var loading: Task<Void, Never>?, timer: Task<Void, Never>?
    private(set) var recorded: URL?
    private nonisolated(unsafe) var owned: URL?
    private let closing = OSAllocatedUnfairLock(initialState: false)
    private(set) var recording = false {
        didSet { controls() }
    }

    init(client: AgentClient, source: Source, library: MediaLibrary?, done: @escaping (Bool) -> Void) {
        (self.client, self.source, self.library, self.done) = (client, source, library, done)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        timer?.cancel(); loading?.cancel()
        if let owned { try? FileManager.default.removeItem(at: owned) }
        if case .gallery(let file, _) = source { try? FileManager.default.removeItem(at: file) }
    }

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        (round.clipsToBounds, round.backgroundColor, round.playerLayer.videoGravity) = (true, .darkGray, .resizeAspectFill)
        (preview.session, preview.videoGravity) = (session, .resizeAspectFill)
        round.layer.addSublayer(preview)
        (round.isAccessibilityElement, round.accessibilityIdentifier, round.accessibilityLabel, remove.accessibilityLabel) = (true, "storyRound", "Camera preview", "Remove camera")
        for (button, title, symbol, action) in [(record, Strings.Stories.record, "record.circle", #selector(recordTapped)), (post, Strings.Stories.post, "arrow.up", #selector(postTapped)), (cancel, Strings.Stories.cancel, "xmark", #selector(cancelTapped)), (text, Strings.Stories.text, "textformat", #selector(textTapped)), (camera, Strings.Stories.camera, "camera", #selector(cameraTapped)), (remove, "", "xmark.circle.fill", #selector(removeTapped))] {
            button.configuration = .glass()
            button.accessibilityLabel = title; button.configuration?.image = UIImage(systemName: symbol)
            button.configuration?.imagePadding = 6; button.configuration?.cornerStyle = .capsule
            button.configuration?.baseForegroundColor = .white
            button.addTarget(self, action: action, for: .touchUpInside)
        }
        remove.accessibilityLabel = "Remove camera"
        post.configuration = .filled(); post.configuration?.image = UIImage(systemName: "arrow.up"); post.configuration?.cornerStyle = .capsule
        text.configuration?.title = "T"; text.configuration?.image = nil; text.configuration?.baseForegroundColor = .label; camera.configuration?.image = UIImage(systemName: "video")
        (comment.delegate, comment.font, comment.textColor, comment.keyboardAppearance, comment.returnKeyType) = (self, .systemFont(ofSize: 16), .white, .dark, .done)
        (comment.backgroundColor, comment.textContainerInset, comment.accessibilityIdentifier) = (.clear, UIEdgeInsets(top: 11, left: 8, bottom: 11, right: 8), "storyCaption")
        (placeholder.text, placeholder.font, placeholder.textColor, placeholder.isUserInteractionEnabled) = (Strings.Stories.caption, comment.font, .lightGray, false)
        (material.clipsToBounds, material.layer.cornerRadius) = (true, 22)
        (caption.textColor, caption.font, caption.textAlignment, caption.delegate, caption.returnKeyType) = (.white, .systemFont(ofSize: 24, weight: .semibold), .center, self, .done)
        (caption.backgroundColor, caption.layer.cornerRadius, caption.keyboardAppearance) = (UIColor.black.withAlphaComponent(0.35), 8, .dark)
        caption.textContainerInset = UIEdgeInsets(top: 6, left: 10, bottom: 6, right: 10); caption.textContainer.lineFragmentPadding = 0
        caption.isScrollEnabled = false
        caption.isEditable = false; caption.isSelectable = false
        caption.isHidden = true; caption.accessibilityLabel = Strings.Stories.text
        caption.accessibilityIdentifier = "storyTextLayer"
        (picture.contentMode, picture.clipsToBounds, base.playerLayer.videoGravity) = (.scaleAspectFill, true, .resizeAspectFill)
        for layer in [caption, round] { layer.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))) }
        caption.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(textTapped)))
        round.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(roundTapped)))
        [picture, base, round, caption, material, comment, placeholder, record, text, camera, post, cancel, remove].forEach(view.addSubview)
        controls()
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        for name in [UIApplication.didEnterBackgroundNotification, AVCaptureSession.wasInterruptedNotification] { NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: name, object: nil) }
        loading = Task { [weak self] in await self?.loadBase() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let measured = caption.attributedText.boundingRect(with: CGSize(width: StoryLayout.textWidth(in: view.bounds.size) - 20, height: .greatestFiniteMagnitude), options: .usesLineFragmentOrigin, context: nil).size
        let initial = StoryLayout.composer(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), text: textPosition, round: roundPosition, keyboard: keyboard, measuredText: measured)
        let layout = StoryLayout.composer(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), text: textPosition, round: roundPosition, keyboard: keyboard, measuredText: measured, captionHeight: comment.sizeThatFits(CGSize(width: initial.caption.width, height: .greatestFiniteMagnitude)).height)
        (picture.frame, base.frame, cancel.frame, post.frame, round.frame, record.frame, caption.frame, text.frame, camera.frame, remove.frame) = (layout.media, layout.media, layout.cancel, layout.post, layout.round, layout.record, layout.text, layout.addText, layout.camera, layout.remove)
        (comment.frame, material.frame, placeholder.frame) = (layout.caption, layout.caption, layout.placeholder)
        (round.layer.cornerRadius, preview.frame) = (round.bounds.width / 2, round.bounds)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        closing.withLock { $0 = true }
        basePlayer?.pause(); round.playerLayer.player?.pause(); loading?.cancel(); timer?.cancel()
        nonisolated(unsafe) let session = session
        queue.async { session.stopRunning() }
    }

    private func startCamera() async {
        guard await AVCaptureDevice.requestAccess(for: .video) else { cameraStarting = false; return }
        let sound = await AVCaptureDevice.requestAccess(for: .audio)
        let closing = closing
        guard !closing.withLock({ $0 }) else { cameraStarting = false; return }
        nonisolated(unsafe) let (session, output) = (session, output)
        queue.async { [weak self] in
            guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
                  let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { Task { @MainActor in self?.cameraStarting = false }; return }
            session.beginConfiguration()
            session.sessionPreset = .medium
            session.addInput(input)
            if sound, let mic = AVCaptureDevice.default(for: .audio), let audio = try? AVCaptureDeviceInput(device: mic), session.canAddInput(audio) { session.addInput(audio) }
            if session.canAddOutput(output) { session.addOutput(output) }
            output.maxRecordedDuration = CMTime(seconds: 15, preferredTimescale: 600)
            session.commitConfiguration()
            Task { @MainActor in self?.cameraStarted = true; self?.cameraStarting = false }
            guard !closing.withLock({ $0 }) else { return }
            session.startRunning()
        }
    }

    @objc func recordTapped() {
        guard !resetting, !posting else { return }
        if recording {
            #if DEBUG
            if let file = Self.debugRecording { timer?.cancel(); return finished(file) }
            #endif
            nonisolated(unsafe) let output = output
            queue.async { if output.isRecording { output.stopRecording() } }; return
        }
        discard()
        resetting = false
        view.endEditing(true)
        basePlayer?.seek(to: .zero); basePlayer?.play()
        #if DEBUG
        if let file = Self.debugRecording {
            finished(file); recorded = nil
            recording = true
            timer = Task { [weak self] in guard (try? await Task.sleep(for: .seconds(15))) != nil else { return }; self?.recordTapped() }
            return
        }
        #endif
        guard cameraStarted else { return }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
        began(file)
        nonisolated(unsafe) let (session, output) = (session, output)
        let closing = closing
        queue.async { [self] in
            guard !closing.withLock({ $0 }), session.isRunning else { Task { @MainActor in finished(nil) }; return }
            output.startRecording(to: file, recordingDelegate: self)
        }
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
        Task { @MainActor in self.finished(whole && !self.resetting ? url : nil); self.resetting = false }
    }

    /// Loops a completed recording; discards a failed one.
    private func finished(_ url: URL?) {
        recording = false
        guard let url else { return discard() }
        recorded = url
        let player = AVQueuePlayer()
        (looper, round.playerLayer.player, preview.isHidden) = (AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url)), player, true)
        player.play()
        controls()
    }

    @objc func postTapped() {
        guard !recording, !posting else { return }
        posting = true; controls(); view.endEditing(true)
        let written = (caption.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let comment = comment.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let layers = Story.Layers(text: written.isEmpty ? nil : .init(text: String(written.prefix(200)), x: textPosition.x, y: textPosition.y), round: recorded == nil ? nil : .init(x: roundPosition.x, y: roundPosition.y))
        let (recorded, client, source) = (recorded, client, source)
        Task { [weak self] in
            var ok = true
            do {
                let round: Data? = if let recorded { try await Self.mp4(recorded) } else { nil }
                switch source {
                case .repost(let story): try await client.repostStory(story.id, caption: comment.isEmpty ? nil : comment, round: round, layers: layers)
                case .gallery(let file, let mime): try await Self.upload(client, file: file, mime: mime, caption: comment.isEmpty ? nil : comment, layers: layers, round: round)
                }
            } catch { ok = false }
            self?.discard()
            let done = self?.done
            self?.dismiss(animated: true) { done?(ok) }
        }
    }

    @objc private func cancelTapped() { dismiss(animated: true) }

    /// H.264 in an MP4, small enough to send.
    nonisolated static func mp4(_ url: URL, preset: String = AVAssetExportPreset640x480, limit: Int = 16 << 20) async throws -> Data {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        defer { try? FileManager.default.removeItem(at: out) }
        guard let export = AVAssetExportSession(asset: AVURLAsset(url: url), presetName: preset) else { throw CocoaError(.fileWriteUnknown) }
        try await export.export(to: out, as: .mp4)
        guard let track = try await AVURLAsset(url: out).loadTracks(withMediaType: .video).first,
              try await track.load(.formatDescriptions).contains(where: { CMFormatDescriptionGetMediaSubType($0) == kCMVideoCodecType_H264 }) else { throw CocoaError(.fileReadCorruptFile) }
        guard try out.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0 <= limit else { throw CocoaError(.fileReadTooLarge) }
        return try Data(contentsOf: out)
    }

    private nonisolated static func upload(_ client: AgentClient, file: URL, mime: String, caption: String?, layers: Story.Layers, round: Data?) async throws {
        try await client.postStory(media: Data(contentsOf: file), mimeType: mime, caption: caption, layers: layers, round: round)
    }
    private func controls() {
        [cancel, text, camera, remove].forEach { $0.isEnabled = !posting }
        (caption.isUserInteractionEnabled, comment.isUserInteractionEnabled) = (!posting, !posting)
        [post, cancel, text, camera, caption, remove, material, comment, placeholder].forEach { $0.isHidden = recording }
        placeholder.isHidden = recording || !comment.text.isEmpty
        caption.isHidden = recording || (caption.text?.isEmpty != false && !caption.isFirstResponder)
        (round.isHidden, remove.isHidden, record.isHidden, post.isEnabled) = (!cameraAdded, recording || !cameraAdded, !recording, !recording && !posting)
        record.configuration = .filled(); record.configuration?.image = UIImage(systemName: "stop.fill"); record.configuration?.baseBackgroundColor = .systemRed; record.configuration?.cornerStyle = .capsule
        record.accessibilityLabel = Strings.Stories.stop
        round.accessibilityLabel = recorded == nil ? "Camera preview" : Strings.Stories.again
    }
    @objc private func textTapped() { caption.isHidden = false; caption.isEditable = true; caption.isSelectable = true; caption.becomeFirstResponder() }
    @objc private func cameraTapped() {
        if cameraAdded { removeTapped(); return }
        cameraAdded = true; controls()
        closing.withLock { $0 = false }
        #if DEBUG
        if let file = Self.debugRecording { finished(file); recorded = nil; controls(); return }
        #endif
        if cameraStarted {
            nonisolated(unsafe) let session = session
            let closing = closing
            queue.async { if !session.inputs.isEmpty, !closing.withLock({ $0 }) { session.startRunning() } }
            return
        }
        guard !cameraStarting else { return }; cameraStarting = true
        Task { await startCamera() }
    }
    @objc private func roundTapped() { if !recording { recordTapped() } }
    @objc private func removeTapped() {
        discard(); cameraAdded = false; controls(); closing.withLock { $0 = true }
        nonisolated(unsafe) let session = session
        queue.async { session.stopRunning() }
    }
    @objc private func dragged(_ gesture: UIPanGestureRecognizer) {
        guard !recording, let layer = gesture.view else { return }
        let delta = gesture.translation(in: view)
        let position = StoryLayout.normalized(CGPoint(x: layer.center.x + delta.x, y: layer.center.y + delta.y), in: view.bounds.size)
        if layer === caption { textPosition = position } else { roundPosition = position }
        gesture.setTranslation(.zero, in: view); view.setNeedsLayout(); view.layoutIfNeeded()
    }
    @objc private func interrupted() {
        basePlayer?.pause(); timer?.cancel(); resetting = recording; recording = false; recorded = nil
        #if DEBUG
        if Self.debugRecording != nil { resetting = false }
        #endif
        (looper, round.playerLayer.player, preview.isHidden) = (nil, nil, false)
        nonisolated(unsafe) let output = output
        queue.async { if output.isRecording { output.stopRecording() } }
    }
    func textViewDidChange(_ field: UITextView) { placeholder.isHidden = !comment.text.isEmpty; view.setNeedsLayout() }
    func textViewDidEndEditing(_ field: UITextView) { if field === caption { field.isEditable = false; field.isSelectable = false }; controls() }
    func textView(_ field: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        if text == "\n" { field.resignFirstResponder(); return false }
        return (field.text as NSString).replacingCharacters(in: range, with: text).utf16.count <= 200
    }
    @objc private func keyboardChanged(_ note: Notification) {
        guard let rect = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        keyboard = max(0, view.bounds.maxY - view.convert(rect, from: nil).minY); view.setNeedsLayout()
    }
    private func loadBase() async {
        switch source {
        case .gallery(let file, let mime):
            if mime == "video/mp4" { basePlayer = AVPlayer(url: file) } else { picture.image = await Self.picture(file: file) }
        case .repost(let story):
            if story.isVideo, let library {
                let stream = MediaStream(downloads: library.downloads, id: "story/\(story.id)", source: client.storySource(story), name: "story.mp4", mimeType: story.media.mimeType)
                self.stream = stream; basePlayer = AVPlayer(playerItem: AVPlayerItem(asset: stream.asset()))
            } else if let data = try? await client.storyMedia(story.id).body, !Task.isCancelled { picture.image = await Self.picture(data: data) }
        }
        base.playerLayer.player = basePlayer
    }
    private nonisolated static func picture(file: URL) async -> UIImage? { guard let data = try? Data(contentsOf: file) else { return nil }; return Images.decode(data, maxPixels: 1920) }
    private nonisolated static func picture(data: Data) async -> UIImage? { Images.decode(data, maxPixels: 1920) }
}
#endif
