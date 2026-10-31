#if canImport(UIKit)
import Photos
import UIKit

/// What the app may see of the photo library.
enum AttachLibraryAccess: Equatable, Sendable {
    case notDetermined
    case authorized
    /// Only the photos the person chose (`PHAuthorizationStatus.limited`).
    case limited
    /// Refused, or not the person's to give (restricted).
    case denied

    var reads: Bool { self == .authorized || self == .limited }

    init(_ status: PHAuthorizationStatus) {
        switch status {
        case .authorized: self = .authorized
        case .limited: self = .limited
        case .notDetermined: self = .notDetermined
        default: self = .denied
        }
    }
}

/// One picture of the "+" menu's grid.
struct AttachLibraryItem: Equatable {
    var id: String
    /// A video's length; nil for a photo.
    var duration: TimeInterval?
}

/// The photo library as the "+" menu reads it: access, the newest photos
/// and videos, their thumbnails and their full bytes. PhotoKit's in the
/// app (`PhotoKitAttachLibrary`); tests and the harness hand in a fixture.
@MainActor
protocol AttachLibrary: AnyObject {
    var access: AttachLibraryAccess { get }
    /// Asks the person, when nobody has yet; answered on the main thread.
    func requestAccess(_ answer: @escaping @MainActor (AttachLibraryAccess) -> Void)
    /// Fetches the library newest first off the main thread, then calls
    /// `done`; `onChange` hears every later change (to the library, or to
    /// what the person lets the app see).
    func load(_ done: @escaping @MainActor () -> Void)
    var onChange: (@MainActor () -> Void)? { get set }
    var count: Int { get }
    func item(at index: Int) -> AttachLibraryItem?
    /// The thumbnail filling `size` pixels, as soon as one is ready (a
    /// rougher one may come first). Cancel with the returned token.
    func thumbnail(at index: Int, pixels size: CGSize, _ deliver: @escaping @MainActor (UIImage) -> Void) -> Int?
    func cancelThumbnail(_ token: Int)
    /// Thumbnails worth making before they show.
    func prepare(_ range: Range<Int>, pixels size: CGSize)
    /// The picks in full, in the order given; off the main thread.
    func read(_ ids: [String]) async -> [LibraryPick]
    /// The system's sheet for choosing what a limited library shows.
    func manageLimited(from host: UIViewController)
}

/// Where the "+" menu gets its library and whether there is a camera.
/// The app's are PhotoKit and the device's; tests and the harness swap
/// them before the menu opens.
@MainActor
enum AttachMenuEnvironment {
    static var library: () -> AttachLibrary = {
        #if DEBUG || HAPPY_FIXTURES
        // UI tests and screenshots: `-attachLibrary denied` and the like.
        if let fixture = FixtureAttachLibrary.fromArguments(ProcessInfo.processInfo.arguments) { return fixture }
        #endif
        return PhotoKitAttachLibrary()
    }
    static var camera: () -> Bool = { UIImagePickerController.isSourceTypeAvailable(.camera) }
}

/// The library through PhotoKit, newest first, photos and videos.
@MainActor
final class PhotoKitAttachLibrary: NSObject, AttachLibrary, PHPhotoLibraryChangeObserver {
    var onChange: (@MainActor () -> Void)?
    private(set) var access = AttachLibraryAccess(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    private var fetch: PHFetchResult<PHAsset>?
    private let images = PHCachingImageManager()
    private var registered = false
    /// What `prepare` asked PhotoKit to cache, at what size.
    private var cached: Range<Int> = 0..<0
    private var cachedSize: CGSize = .zero

    deinit {
        if registered { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    }

    func requestAccess(_ answer: @escaping @MainActor (AttachLibraryAccess) -> Void) {
        guard access == .notDetermined else { return answer(access) }
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { @Sendable status in
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    self?.access = AttachLibraryAccess(status)
                    answer(AttachLibraryAccess(status))
                }
            }
        }
    }

    func load(_ done: @escaping @MainActor () -> Void) {
        access = AttachLibraryAccess(PHPhotoLibrary.authorizationStatus(for: .readWrite))
        guard access.reads else {
            fetch = nil
            return done()
        }
        if !registered {
            registered = true
            PHPhotoLibrary.shared().register(self)
        }
        Task {
            let fetched = await Task.detached(priority: .userInitiated) { () -> FetchBox in
                let options = PHFetchOptions()
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                options.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
                return FetchBox(result: PHAsset.fetchAssets(with: options))
            }.value
            show(fetched.result)
            done()
        }
    }

    private func show(_ result: PHFetchResult<PHAsset>) {
        fetch = result
        images.stopCachingImagesForAllAssets()
        cached = 0..<0
    }

    nonisolated func photoLibraryDidChange(_ change: PHChange) {
        nonisolated(unsafe) let change = change
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = AttachLibraryAccess(PHPhotoLibrary.authorizationStatus(for: .readWrite))
                if now != self.access {
                    self.load { [weak self] in self?.onChange?() }
                    return
                }
                guard let fetch = self.fetch, let details = change.changeDetails(for: fetch) else { return }
                self.show(details.fetchResultAfterChanges)
                self.onChange?()
            }
        }
    }

    var count: Int { fetch?.count ?? 0 }

    private func asset(_ index: Int) -> PHAsset? {
        guard let fetch, index >= 0, index < fetch.count else { return nil }
        return fetch.object(at: index)
    }

    func item(at index: Int) -> AttachLibraryItem? {
        guard let asset = asset(index) else { return nil }
        return AttachLibraryItem(id: asset.localIdentifier, duration: asset.mediaType == .video ? asset.duration : nil)
    }

    /// The grid's requests, the same for caching and showing so the cache is hit.
    nonisolated(unsafe) private static let thumbnailOptions: PHImageRequestOptions = {
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        return options
    }()

    func thumbnail(at index: Int, pixels size: CGSize, _ deliver: @escaping @MainActor (UIImage) -> Void) -> Int? {
        guard let asset = asset(index) else { return nil }
        let request = images.requestImage(for: asset, targetSize: size, contentMode: .aspectFill, options: Self.thumbnailOptions) { @Sendable image, _ in
            // A failed full-size fetch (offline iCloud) keeps the degraded one.
            guard let got = image else { return }
            nonisolated(unsafe) let image = got
            // A cached thumbnail arrives at once, on main: shown in the same frame.
            if Thread.isMainThread {
                MainActor.assumeIsolated { deliver(image) }
            } else {
                DispatchQueue.main.async { MainActor.assumeIsolated { deliver(image) } }
            }
        }
        return Int(request)
    }

    func cancelThumbnail(_ token: Int) {
        images.cancelImageRequest(PHImageRequestID(token))
    }

    func prepare(_ range: Range<Int>, pixels size: CGSize) {
        guard let fetch else { return }
        if size != cachedSize {
            images.stopCachingImagesForAllAssets()
            cached = 0..<0
            cachedSize = size
        }
        let range = range.clamped(to: 0..<fetch.count)
        guard range != cached else { return }
        let old = Set(cached)
        let new = Set(range)
        let start = new.subtracting(old).map { fetch.object(at: $0) }
        let stop = old.subtracting(new).filter { $0 < fetch.count }.map { fetch.object(at: $0) }
        images.startCachingImages(for: start, targetSize: size, contentMode: .aspectFill, options: Self.thumbnailOptions)
        images.stopCachingImages(for: stop, targetSize: size, contentMode: .aspectFill, options: Self.thumbnailOptions)
        cached = range
    }

    func read(_ ids: [String]) async -> [LibraryPick] {
        let found = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        let byID = Dictionary((0..<found.count).map { (found.object(at: $0).localIdentifier, found.object(at: $0)) }, uniquingKeysWith: { a, _ in a })
        var picks: [LibraryPick] = []
        for id in ids {
            guard let asset = byID[id], let pick = await LibraryPicker.read(asset) else { continue }
            picks.append(pick)
        }
        return picks
    }

    func manageLimited(from host: UIViewController) {
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: host)
    }
}

/// A fetch handed from the queue that made it to the main actor, which
/// alone reads it from there.
private struct FetchBox: @unchecked Sendable {
    let result: PHFetchResult<PHAsset>
}
#endif
