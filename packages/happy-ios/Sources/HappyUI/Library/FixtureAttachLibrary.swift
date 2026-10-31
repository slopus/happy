#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
// A stand-in photo library for the "+" menu: in Debug, and in builds that
// ask for fixtures. Never in the shipped app.
import AVFoundation
import UIKit
import UniformTypeIdentifiers

/// A library of drawn pictures with a chosen access, so the "+" menu can be
/// tested and filmed the same way every time: every fourth picture is a
/// video, its thumbnails are drawn off the main thread, and a pick reads
/// as a PNG (or, for a video, a short movie) as PhotoKit's would.
@MainActor
final class FixtureAttachLibrary: AttachLibrary {
    var onChange: (@MainActor () -> Void)?
    private(set) var access: AttachLibraryAccess
    /// What asking answers, when access isn't settled yet.
    var grant: AttachLibraryAccess
    private var items: [AttachLibraryItem] = []
    private let total: Int
    private var next = 0
    private var requests: Set<Int> = []
    /// Thumbnails drawn in the background, by index and pixel width.
    private var drawn: [String: UIImage] = [:]
    private(set) var limitedManaged = 0
    private static let queue = DispatchQueue(label: "engineering.happy.fixture-library", qos: .userInitiated)

    init(access: AttachLibraryAccess, grant: AttachLibraryAccess = .authorized, count: Int = 60) {
        self.access = access
        self.grant = grant
        total = count
    }

    /// From the launch arguments the harness and UI tests pass:
    /// `-attachLibrary authorized|limited|denied|notDetermined`.
    static func fromArguments(_ arguments: [String]) -> FixtureAttachLibrary? {
        guard let index = arguments.firstIndex(of: "-attachLibrary"), arguments.indices.contains(index + 1) else { return nil }
        switch arguments[index + 1] {
        case "authorized": return FixtureAttachLibrary(access: .authorized)
        case "limited": return FixtureAttachLibrary(access: .limited, count: 7)
        case "denied": return FixtureAttachLibrary(access: .denied)
        case "notDetermined": return FixtureAttachLibrary(access: .notDetermined)
        default: return nil
        }
    }

    func requestAccess(_ answer: @escaping @MainActor (AttachLibraryAccess) -> Void) {
        guard access == .notDetermined else { return answer(access) }
        // The system's prompt takes a moment to be answered.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            access = grant
            answer(grant)
        }
    }

    func load(_ done: @escaping @MainActor () -> Void) {
        let size = access == .limited ? min(total, 7) : total
        items = access.reads ? (0..<size).map { index in
            AttachLibraryItem(id: "fixture-\(index)", duration: index % 4 == 1 ? TimeInterval(7 + index * 13) : nil)
        } : []
        Task { @MainActor in done() }
    }

    var count: Int { items.count }

    func item(at index: Int) -> AttachLibraryItem? {
        items.indices.contains(index) ? items[index] : nil
    }

    func thumbnail(at index: Int, pixels size: CGSize, _ deliver: @escaping @MainActor (UIImage) -> Void) -> Int? {
        guard items.indices.contains(index) else { return nil }
        let key = "\(index)@\(Int(size.width))"
        if let image = drawn[key] {
            deliver(image)
            return nil
        }
        next += 1
        let token = next
        requests.insert(token)
        Self.queue.async {
            let image = Self.picture(index, pixels: size)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { [weak self] in
                    guard let self else { return }
                    drawn[key] = image
                    guard requests.remove(token) != nil else { return }
                    deliver(image)
                }
            }
        }
        return token
    }

    func cancelThumbnail(_ token: Int) { requests.remove(token) }

    func prepare(_ range: Range<Int>, pixels size: CGSize) {}

    func read(_ ids: [String]) async -> [LibraryPick] {
        let wanted = ids.compactMap { id in items.first { $0.id == id } }
        return await Task.detached(priority: .userInitiated) {
            var picks: [LibraryPick] = []
            for item in wanted {
                if let pick = await Self.pick(item) { picks.append(pick) }
            }
            return picks
        }.value
    }

    /// A photo as a PNG; a video as a short real movie, so it plays and
    /// shows its first frame as PhotoKit's would.
    private nonisolated static func pick(_ item: AttachLibraryItem) async -> LibraryPick? {
        guard let index = Int(item.id.dropFirst("fixture-".count)) else { return nil }
        let image = picture(index, pixels: CGSize(width: 600, height: 600))
        if let duration = item.duration {
            try? FileManager.default.createDirectory(at: LibraryPicker.files, withIntermediateDirectories: true)
            let file = LibraryPicker.files.appendingPathComponent(UUID().uuidString).appendingPathExtension("mov")
            guard await movie(index, to: file) else { return nil }
            return LibraryPick(media: .video(file), thumbnail: image, pixelSize: CGSize(width: 600, height: 600), duration: duration, assetIdentifier: item.id)
        }
        guard let data = image.pngData() else { return nil }
        return LibraryPick(media: .image(data, .png), thumbnail: image, pixelSize: CGSize(width: 600, height: 600), duration: nil, assetIdentifier: item.id)
    }

    /// Two seconds of picture `index` with a light crossing it, as H.264.
    nonisolated static func movie(_ index: Int, to url: URL) async -> Bool {
        let side = 480, frames = 24, rate: Int32 = 12
        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mov) else { return false }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: side, AVVideoHeightKey: side,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: side, kCVPixelBufferHeightKey as String: side,
        ])
        writer.add(input)
        guard writer.startWriting() else { return false }
        writer.startSession(atSourceTime: .zero)
        guard let still = picture(index, pixels: CGSize(width: side, height: side)).cgImage else { return false }
        for frame in 0..<frames {
            while !input.isReadyForMoreMediaData { try? await Task.sleep(for: .milliseconds(5)) }
            var made: CVPixelBuffer?
            guard let pool = adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made) == kCVReturnSuccess, let buffer = made else { return false }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: side, height: side, bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                let bounds = CGRect(x: 0, y: 0, width: side, height: side)
                context.draw(still, in: bounds)
                let x = CGFloat(frame) / CGFloat(frames - 1) * CGFloat(side - 120)
                context.setFillColor(UIColor(white: 1, alpha: 0.6).cgColor)
                context.fillEllipse(in: CGRect(x: x, y: CGFloat(side) * 0.1, width: 120, height: 120))
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            guard adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: rate)) else { return false }
        }
        input.markAsFinished()
        await writer.finishWriting()
        return writer.status == .completed
    }

    func manageLimited(from host: UIViewController) { limitedManaged += 1 }

    /// Picture `index`: a soft two-colour gradient with a shape on it, the
    /// same every time.
    nonisolated static func picture(_ index: Int, pixels size: CGSize) -> UIImage {
        let side = max(1, min(size.width, size.height))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let hues: [CGFloat] = [0.58, 0.08, 0.33, 0.9, 0.13, 0.5, 0.75, 0.0, 0.42]
        let hue = hues[index % hues.count]
        let top = UIColor(hue: hue, saturation: 0.45, brightness: 0.95, alpha: 1)
        let bottom = UIColor(hue: (hue + 0.08).truncatingRemainder(dividingBy: 1), saturation: 0.7, brightness: 0.7, alpha: 1)
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { context in
            let cg = context.cgContext
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [top.cgColor, bottom.cgColor] as CFArray, locations: [0, 1])!
            cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: side, y: side), options: [])
            UIColor(white: 1, alpha: 0.35).setFill()
            let shape = CGRect(x: side * 0.25, y: side * 0.3, width: side * 0.5, height: side * 0.5)
            switch index % 3 {
            case 0: cg.fillEllipse(in: shape)
            case 1: cg.fill(shape.insetBy(dx: side * 0.05, dy: side * 0.05))
            default:
                cg.move(to: CGPoint(x: shape.midX, y: shape.minY))
                cg.addLine(to: CGPoint(x: shape.maxX, y: shape.maxY))
                cg.addLine(to: CGPoint(x: shape.minX, y: shape.maxY))
                cg.closePath()
                cg.fillPath()
            }
        }
    }
}
#endif
