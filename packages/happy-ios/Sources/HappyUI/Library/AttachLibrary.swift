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

/// What changed in the library since the grid last committed it.
enum AttachLibraryChange: Equatable, Sendable {
    struct Move: Equatable, Sendable {
        var from: Int
        var to: Int
    }

    case none
    /// Anything at all, from one count to another (access changed, or more
    /// than one change came before the grid looked).
    case reload(from: Int, to: Int)
    /// PhotoKit's incremental details: removed by their old indexes,
    /// inserted and changed by their new ones.
    case update(removed: [Int], inserted: [Int], changed: [Int], moves: [Move])
}

/// The photo library as the "+" menu reads it: access, the newest photos
/// and videos, their thumbnails and their full bytes. PhotoKit's in the
/// app (`PhotoKitAttachLibrary`); tests and the harness hand in a fixture.
///
/// What it shows is what was last committed: a change waits, `onChange`
/// says one does, and the grid takes it with `commit()` inside its batch
/// of updates, so the grid and the library never disagree.
@MainActor
protocol AttachLibrary: AnyObject {
    var access: AttachLibraryAccess { get }
    /// Asks the person, when nobody has yet; answered on the main thread.
    func requestAccess(_ answer: @escaping @MainActor (AttachLibraryAccess) -> Void)
    /// Fetches the library newest first off the main thread, then calls
    /// `done`. The first fetch shows at once; a later one (access changed)
    /// waits to be committed, as every change to the library does.
    func load(_ done: @escaping @MainActor () -> Void)
    /// A change waits to be committed.
    var onChange: (@MainActor () -> Void)? { get set }
    /// Takes in what waits, and says what it changed.
    func commit() -> AttachLibraryChange
    var count: Int { get }
    func item(at index: Int) -> AttachLibraryItem?
    /// Whether a picture is still in what the library shows.
    func contains(_ id: String) -> Bool
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
    /// Reduce Motion: the menu slides instead of growing out of the "+".
    static var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }
}

/// The library through PhotoKit, newest first, photos and videos.
@MainActor
final class PhotoKitAttachLibrary: NSObject, AttachLibrary, PHPhotoLibraryChangeObserver {
    var onChange: (@MainActor () -> Void)?
    private(set) var access = AttachLibraryAccess(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    /// What the grid shows.
    private var fetch: PHFetchResult<PHAsset>?
    /// What waits to be committed, and what it changes.
    private var pending: (fetch: PHFetchResult<PHAsset>?, change: AttachLibraryChange)?
    private let images = PHCachingImageManager()
    private var registered = false
    /// What `prepare` asked PhotoKit to cache, at what size.
    private var cached: Range<Int> = 0..<0
    private var cachedSize: CGSize = .zero

    deinit {
        if registered { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    }

    func commit() -> AttachLibraryChange {
        guard let pending else { return .none }
        self.pending = nil
        fetch = pending.fetch
        // The cache's indexes were the old fetch's.
        images.stopCachingImagesForAllAssets()
        cached = 0..<0
        return pending.change
    }

    /// A new fetch waits; one already waiting makes it a wholesale change.
    private func wait(_ next: PHFetchResult<PHAsset>?, _ change: AttachLibraryChange) {
        if pending != nil {
            pending = (next, .reload(from: fetch?.count ?? 0, to: next?.count ?? 0))
        } else {
            pending = (next, change)
        }
        onChange?()
    }

    func contains(_ id: String) -> Bool {
        guard let fetch else { return false }
        let found = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard let asset = found.firstObject else { return false }
        return fetch.contains(asset)
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

    private var loadedOnce = false

    func load(_ done: @escaping @MainActor () -> Void) {
        access = AttachLibraryAccess(PHPhotoLibrary.authorizationStatus(for: .readWrite))
        guard access.reads else {
            show(nil)
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

    /// The first fetch shows; a later one waits for the grid.
    private func show(_ result: PHFetchResult<PHAsset>?) {
        guard loadedOnce else {
            loadedOnce = true
            fetch = result
            return
        }
        wait(result, .reload(from: fetch?.count ?? 0, to: result?.count ?? 0))
    }

    nonisolated func photoLibraryDidChange(_ change: PHChange) {
        nonisolated(unsafe) let change = change
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = AttachLibraryAccess(PHPhotoLibrary.authorizationStatus(for: .readWrite))
                if now != self.access {
                    self.load {}
                    return
                }
                // Against what waits, if anything does, else what shows.
                guard let base = self.pending?.fetch ?? self.fetch, let details = change.changeDetails(for: base) else { return }
                let after = details.fetchResultAfterChanges
                guard details.hasIncrementalChanges else {
                    return self.wait(after, .reload(from: base.count, to: after.count))
                }
                var moves: [AttachLibraryChange.Move] = []
                if details.hasMoves {
                    details.enumerateMoves { from, to in moves.append(.init(from: from, to: to)) }
                }
                self.wait(after, .update(
                    removed: details.removedIndexes.map { Array($0) } ?? [],
                    inserted: details.insertedIndexes.map { Array($0) } ?? [],
                    changed: details.changedIndexes.map { Array($0) } ?? [],
                    moves: moves
                ))
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
            // A cached thumbnail arrives at once, on main: shown in the same
            // frame. One made in the background is decoded there too, so
            // the main thread only hands it to its cell.
            if Thread.isMainThread {
                nonisolated(unsafe) let image = got
                MainActor.assumeIsolated { deliver(image) }
            } else {
                nonisolated(unsafe) let image = got.preparingForDisplay() ?? got
                DispatchQueue.main.async { MainActor.assumeIsolated { deliver(image) } }
            }
        }
        return Int(request)
    }

    func cancelThumbnail(_ token: Int) {
        images.cancelImageRequest(PHImageRequestID(token))
    }

    /// PhotoKit caches the new part of the window and lets go of what left it.
    func prepare(_ range: Range<Int>, pixels size: CGSize) {
        guard let fetch else { return }
        if size != cachedSize {
            images.stopCachingImagesForAllAssets()
            cached = 0..<0
            cachedSize = size
        }
        let range = range.clamped(to: 0..<fetch.count)
        guard range != cached else { return }
        var start = IndexSet(integersIn: range)
        start.subtract(IndexSet(integersIn: cached))
        var stop = IndexSet(integersIn: cached.clamped(to: 0..<fetch.count))
        stop.subtract(IndexSet(integersIn: range))
        if !start.isEmpty {
            images.startCachingImages(for: fetch.objects(at: start), targetSize: size, contentMode: .aspectFill, options: Self.thumbnailOptions)
        }
        if !stop.isEmpty {
            images.stopCachingImages(for: fetch.objects(at: stop), targetSize: size, contentMode: .aspectFill, options: Self.thumbnailOptions)
        }
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
