#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import AVFoundation
import ReplayKit
import UIKit

/// A device run's film of its own screen (ReplayKit's in-app capture), for
/// showing a change on a real phone, where nothing outside the app can
/// record it. `HAPPY_SCREEN_FILM=<name>` starts it at launch and
/// `HAPPY_SCREEN_FILM_SECONDS` (60 by default) ends it; it lands in
/// Documents/film/<name>.mp4. iOS asks once to allow the recording.
@MainActor
public enum ScreenFilm {
    private static var writer: FilmWriter?

    public static func startIfAsked() {
        let environment = ProcessInfo.processInfo.environment
        guard let name = environment["HAPPY_SCREEN_FILM"], !name.isEmpty, writer == nil else { return }
        let seconds = environment["HAPPY_SCREEN_FILM_SECONDS"].flatMap(Double.init) ?? 60
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("film", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("\(name).mp4")
        try? FileManager.default.removeItem(at: url)
        let writer = FilmWriter(url: url)
        self.writer = writer
        let recorder = RPScreenRecorder.shared()
        recorder.isMicrophoneEnabled = false
        recorder.startCapture(handler: { sample, type, error in
            guard error == nil, type == .video else { return }
            writer.append(sample)
        }, completionHandler: { error in
            if let error { print("ScreenFilm: \(error)") }
        })
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            stop()
        }
    }

    static func stop() {
        guard let writer else { return }
        self.writer = nil
        RPScreenRecorder.shared().stopCapture { _ in
            writer.finish()
        }
    }
}

/// Writes the captured frames, on ReplayKit's queue.
private final class FilmWriter: @unchecked Sendable {
    private let url: URL
    private let lock = NSLock()
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var finished = false

    init(url: URL) {
        self.url = url
    }

    func append(_ sample: CMSampleBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard !finished, CMSampleBufferDataIsReady(sample) else { return }
        if writer == nil {
            guard let format = CMSampleBufferGetFormatDescription(sample),
                  let made = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return }
            let size = CMVideoFormatDescriptionGetDimensions(format)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: Int(size.width),
                AVVideoHeightKey: Int(size.height),
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000],
            ])
            input.expectsMediaDataInRealTime = true
            made.add(input)
            made.startWriting()
            made.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sample))
            writer = made
            self.input = input
        }
        if input?.isReadyForMoreMediaData == true { input?.append(sample) }
    }

    func finish() {
        lock.lock()
        finished = true
        let writer = writer
        input?.markAsFinished()
        lock.unlock()
        writer?.finishWriting { print("ScreenFilm: saved") }
    }
}
#endif
