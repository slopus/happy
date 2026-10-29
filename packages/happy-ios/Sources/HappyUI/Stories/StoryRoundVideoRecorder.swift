#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import UIKit

/// Telegram's round video, as the design's repost editor records one: hold
/// the button to record and let go to finish, or tap it to lock and stop
/// with Stop. The front camera first, the back one a tap away; a minute at
/// most. The recording is a file on the device, with whether it should be
/// drawn mirrored (the front camera's), and lands on the frame as a circle
/// the person then drags and pinches like any overlay.
///
/// The simulator has no camera: there it records a drawn picture instead,
/// so the whole path (record, place, upload, play) runs the same.
@MainActor
final class StoryRoundVideoRecorder: UIView {
    struct Recording {
        var file: URL
        var durationMs: Int
        var mirrored: Bool
    }

    /// Recorded, or nil when it was abandoned or couldn't start.
    var onFinish: ((Recording?) -> Void)?

    private let dim = UIView()
    private let circle = UIView()
    private let preview = AVCaptureVideoPreviewLayer()
    private let progress = CAShapeLayer()
    private let flip = UIButton(type: .system)
    private let stop = UIButton(type: .system)
    private let time = UILabel()
    private let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "engineering.happy.round-video")
    private var front = true
    private var started: CFTimeInterval?
    private var link: CADisplayLink?
    private var finished = false
    private var delegate: Delegate?
    private(set) var locked = false
    /// The drawn stand-in for a camera, on a simulator.
    private var stand: StandInCamera?

    static let maxSeconds = Double(StoryCanvas.maxVideoDurationMs) / 1000

    override init(frame: CGRect) {
        super.init(frame: frame)
        dim.backgroundColor = UIColor(white: 0, alpha: 0.6)
        addSubview(dim)
        circle.clipsToBounds = true
        circle.backgroundColor = .black
        circle.accessibilityIdentifier = "story-round-recorder"
        preview.videoGravity = .resizeAspectFill
        preview.session = session
        circle.layer.addSublayer(preview)
        addSubview(circle)
        progress.fillColor = nil
        progress.strokeColor = UIColor.white.cgColor
        progress.lineWidth = 4
        progress.lineCap = .round
        progress.strokeEnd = 0
        layer.addSublayer(progress)
        flip.setImage(UIImage.icon(.ionicons("camera-reverse-outline"), size: 26).withRenderingMode(.alwaysTemplate), for: .normal)
        flip.tintColor = .white
        flip.accessibilityLabel = Strings.Stories.flipCamera
        flip.accessibilityIdentifier = "story-round-flip"
        flip.addAction(UIAction { [weak self] _ in self?.flipCamera() }, for: .touchUpInside)
        addSubview(flip)
        stop.setTitle(Strings.Stories.stopRecording, for: .normal)
        stop.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        stop.tintColor = .white
        stop.backgroundColor = UIColor(red: 1, green: 0.23, blue: 0.19, alpha: 1)
        stop.layer.cornerCurve = .continuous
        stop.accessibilityIdentifier = "story-round-stop"
        stop.isHidden = true
        stop.addAction(UIAction { [weak self] _ in self?.finish() }, for: .touchUpInside)
        addSubview(stop)
        time.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        time.textColor = .white
        time.textAlignment = .center
        time.accessibilityIdentifier = "story-round-time"
        addSubview(time)
        accessibilityViewIsModal = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // MARK: Recording

    /// Opens the camera and starts recording at once.
    func start() {
        guard AVCaptureDevice.default(for: .video) != nil else {
            #if targetEnvironment(simulator)
            startStandIn()
            #else
            finishWith(nil)
            #endif
            return
        }
        Task { [weak self] in
            let video = await AVCaptureDevice.requestAccess(for: .video)
            _ = await AVCaptureDevice.requestAccess(for: .audio)
            guard let self else { return }
            guard video else { return self.finishWith(nil) }
            self.configure()
            let session = session
            let output = output
            let file = Self.newFile("mov")
            let delegate = Delegate { [weak self] url, error in
                DispatchQueue.main.async { self?.recorded(url, error: error) }
            }
            self.delegate = delegate
            queue.async {
                session.startRunning()
                output.startRecording(to: file, recordingDelegate: delegate)
            }
            began()
        }
    }

    private func configure() {
        session.beginConfiguration()
        session.sessionPreset = .high
        if let camera = Self.camera(front: front), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) { session.addInput(input) }
        if let mic = AVCaptureDevice.default(for: .audio), let input = try? AVCaptureDeviceInput(device: mic), session.canAddInput(input) { session.addInput(input) }
        if session.canAddOutput(output) { session.addOutput(output) }
        output.maxRecordedDuration = CMTime(seconds: Self.maxSeconds, preferredTimescale: 600)
        session.commitConfiguration()
        preview.connection?.automaticallyAdjustsVideoMirroring = true
    }

    private static func camera(front: Bool) -> AVCaptureDevice? {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: front ? .front : .back)
    }

    private func flipCamera() {
        front.toggle()
        StoriesHaptics.play(.advance)
        if let stand { return stand.front = front }
        let session = session
        let front = front
        queue.async {
            session.beginConfiguration()
            for input in session.inputs {
                guard let input = input as? AVCaptureDeviceInput, input.device.hasMediaType(.video) else { continue }
                session.removeInput(input)
            }
            if let camera = Self.camera(front: front), let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) { session.addInput(input) }
            session.commitConfiguration()
        }
    }

    private func began() {
        started = CACurrentMediaTime()
        let link = CADisplayLink(target: RecorderTicker(self), selector: #selector(RecorderTicker.tick))
        link.add(to: .main, forMode: .common)
        self.link = link
        StoriesHaptics.play(.open)
    }

    fileprivate func tick() {
        guard let started else { return }
        let elapsed = CACurrentMediaTime() - started
        progress.strokeEnd = CGFloat(min(1, elapsed / Self.maxSeconds))
        time.text = String(format: "%d:%02d", Int(elapsed) / 60, Int(elapsed) % 60)
        stand?.draw(at: elapsed)
        if elapsed >= Self.maxSeconds { finish() }
    }

    /// The hold became a lock: recording goes on until Stop.
    func lock() {
        guard !locked, !finished else { return }
        locked = true
        stop.isHidden = false
        setNeedsLayout()
    }

    /// Ends the recording and hands it over.
    func finish() {
        guard !finished else { return }
        finished = true
        link?.invalidate(); link = nil
        if let stand {
            let elapsed = started.map { CACurrentMediaTime() - $0 } ?? 0
            Task { [weak self] in
                let file = await stand.write(seconds: max(1, min(Self.maxSeconds, elapsed)))
                self?.finishWith(file.map { Recording(file: $0, durationMs: Int(max(1, elapsed) * 1000), mirrored: stand.front) })
            }
            return
        }
        let output = output
        queue.async { if output.isRecording { output.stopRecording() } }
    }

    /// Closed without keeping anything.
    func cancel() {
        finished = true
        link?.invalidate(); link = nil
        let output = output
        let session = session
        queue.async {
            if output.isRecording { output.stopRecording() }
            session.stopRunning()
        }
        finishWith(nil)
    }

    private func recorded(_ url: URL, error: Error?) {
        let session = session
        queue.async { session.stopRunning() }
        finished = true
        link?.invalidate(); link = nil
        // A recording that hit its minute still finished well.
        let reached = (error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? (error == nil)
        guard reached else { return finishWith(nil) }
        let mirrored = front
        Task { [weak self] in
            let duration = (try? await AVURLAsset(url: url).load(.duration).seconds) ?? 0
            self?.finishWith(duration > 0 ? Recording(file: url, durationMs: max(1, Int(duration * 1000)), mirrored: mirrored) : nil)
        }
    }

    private func finishWith(_ recording: Recording?) {
        let finish = onFinish
        onFinish = nil
        finish?(recording)
    }

    static func newFile(_ ext: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("round-\(ClientID.make()).\(ext)")
    }

    // MARK: The stand-in

    private func startStandIn() {
        let stand = StandInCamera(front: front)
        self.stand = stand
        circle.layer.addSublayer(stand.layer)
        setNeedsLayout()
        began()
    }

    // MARK: Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        dim.frame = bounds
        let side = min(bounds.width * 0.72, 320)
        let frame = CGRect(x: (bounds.width - side) / 2, y: bounds.midY - side / 2 - 60, width: side, height: side)
        circle.frame = frame
        circle.layer.cornerRadius = side / 2
        preview.frame = circle.bounds
        stand?.layer.frame = circle.bounds
        progress.frame = bounds
        progress.path = UIBezierPath(arcCenter: CGPoint(x: frame.midX, y: frame.midY), radius: side / 2 + 6, startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: true).cgPath
        time.frame = CGRect(x: 0, y: frame.maxY + 18, width: bounds.width, height: 20)
        flip.frame = CGRect(x: frame.maxX - 22, y: frame.maxY - 22, width: 44, height: 44)
        stop.frame = CGRect(x: (bounds.width - 120) / 2, y: time.frame.maxY + 18, width: 120, height: 44)
        stop.layer.cornerRadius = 22
    }

    private final class Delegate: NSObject, AVCaptureFileOutputRecordingDelegate, @unchecked Sendable {
        let done: @Sendable (URL, Error?) -> Void
        init(_ done: @escaping @Sendable (URL, Error?) -> Void) { self.done = done }
        func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
            done(outputFileURL, error)
        }
    }
}

@MainActor
private final class RecorderTicker: NSObject {
    weak var recorder: StoryRoundVideoRecorder?
    init(_ recorder: StoryRoundVideoRecorder) { self.recorder = recorder }
    @objc func tick(_ link: CADisplayLink) {
        guard let recorder else { return link.invalidate() }
        recorder.tick()
    }
}

/// A camera for a device without one: a moving picture drawn here, live in
/// the circle and written out as the recording.
@MainActor
private final class StandInCamera {
    let layer = CALayer()
    var front: Bool

    init(front: Bool) {
        self.front = front
        layer.contentsGravity = .resizeAspectFill
    }

    func draw(at seconds: Double) {
        layer.contents = Self.picture(at: seconds, front: front, side: 360).cgImage
    }

    static func picture(at seconds: Double, front: Bool, side: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { context in
            let hue = CGFloat(seconds.truncatingRemainder(dividingBy: 6) / 6)
            let colors = [UIColor(hue: hue, saturation: 0.55, brightness: 0.85, alpha: 1), UIColor(hue: (hue + 0.3).truncatingRemainder(dividingBy: 1), saturation: 0.6, brightness: 0.45, alpha: 1)]
            let gradient = CGGradient(colorsSpace: nil, colors: colors.map(\.cgColor) as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: side, y: side), options: [])
            let face = NSAttributedString(string: front ? "🙂" : "🌳", attributes: [.font: UIFont.systemFont(ofSize: side * 0.42)])
            let size = face.size()
            let bob = CGFloat(sin(seconds * 3)) * side * 0.03
            face.draw(at: CGPoint(x: (side - size.width) / 2, y: (side - size.height) / 2 + bob))
        }
    }

    /// The pictures of `seconds`, written as an H.264 file at 15 a second.
    func write(seconds: Double) async -> URL? {
        let url = StoryRoundVideoRecorder.newFile("mp4")
        let front = front
        let side = 360
        let frames = max(1, Int(seconds * 15))
        let pictures = (0..<frames).map { Self.picture(at: Double($0) / 15, front: front, side: CGFloat(side)).cgImage }
        return await Task.detached(priority: .userInitiated) { () -> URL? in
            guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return nil }
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: side, AVVideoHeightKey: side])
            let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: side, kCVPixelBufferHeightKey as String: side])
            writer.add(input)
            guard writer.startWriting() else { return nil }
            writer.startSession(atSourceTime: .zero)
            for (index, picture) in pictures.enumerated() {
                guard let picture, let pool = adaptor.pixelBufferPool else { continue }
                var buffer: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
                guard let buffer else { continue }
                CVPixelBufferLockBaseAddress(buffer, [])
                if let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: side, height: side, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                    context.draw(picture, in: CGRect(x: 0, y: 0, width: side, height: side))
                }
                CVPixelBufferUnlockBaseAddress(buffer, [])
                while !input.isReadyForMoreMediaData { try? await Task.sleep(for: .milliseconds(5)) }
                adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: 15))
            }
            input.markAsFinished()
            await writer.finishWriting()
            return writer.status == .completed ? url : nil
        }.value
    }
}
#endif
