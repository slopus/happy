#if canImport(UIKit)
import AVFoundation
import HappyLayout
import Photos
import UIKit
import UniformTypeIdentifiers

/// One photo or video picked from the library, a file from Files, or what
/// was pasted, read in full.
struct LibraryPick {
    enum Media {
        /// The photo's bytes as the library keeps them (HEIC, JPEG, PNG…).
        case image(Data, UTType)
        /// A copy of the video in the app's temporary directory, the
        /// caller's to move or remove.
        case video(URL)
        /// Any other file from Files, copied the same way and the caller's
        /// the same way.
        case file(URL, UTType)
    }

    var media: Media
    /// Upright, at most 512 pt on its longer side.
    var thumbnail: UIImage
    /// In pixels, upright.
    var pixelSize: CGSize
    /// A video's length in seconds.
    var duration: TimeInterval?
    /// The library's `PHAsset.localIdentifier`.
    var assetIdentifier: String
}

/// The photo library as a sheet, after Telegram's attachment gallery: the
/// camera roll newest first in a grid of our own, picked in order with
/// numbered circles, and one button that hands the picks back. Their count
/// after Cancel shows only the picks until Back. No camera. Limited
/// access is shown and managed as Telegram does; refused access offers
/// Settings.
///
///     LibraryPicker.present(from: self, options: .init(limit: 10, action: "Add")) { picks in … }
///
/// `onPick` gets the picks in the order they were picked, read in full,
/// and is not called when the sheet is cancelled or swiped away; the
/// sheet's `onCancel` is.
@MainActor
enum LibraryPicker {
    struct Options {
        /// At most this many can be picked.
        var limit: Int = 10
        /// Videos are shown as well as photos.
        var videos: Bool = true
        /// The button's word: "Add 2", "Send 2".
        var action: String = "Add"
    }

    @discardableResult
    static func present(from host: UIViewController, options: Options = Options(), onPick: @escaping ([LibraryPick]) -> Void) -> LibraryPickerViewController {
        let picker = LibraryPickerViewController(options: options, onPick: onPick)
        host.present(picker, animated: true)
        return picker
    }

    // MARK: Reading

    /// The asset in full: a photo's bytes, or a video copied out (a slow
    /// motion or edited one exported to MP4), with its thumbnail.
    static func read(_ asset: PHAsset) async -> LibraryPick? {
        nonisolated(unsafe) let asset = asset
        let thumbnail = await image(asset, side: 512) ?? UIImage()
        let pixels = CGSize(width: asset.pixelWidth, height: asset.pixelHeight)
        switch asset.mediaType {
        case .image:
            guard let (data, type) = await imageData(asset) else { return nil }
            return LibraryPick(media: .image(data, type), thumbnail: thumbnail, pixelSize: pixels, duration: nil, assetIdentifier: asset.localIdentifier)
        case .video:
            guard let file = await videoFile(asset) else { return nil }
            return LibraryPick(media: .video(file), thumbnail: thumbnail, pixelSize: pixels, duration: asset.duration, assetIdentifier: asset.localIdentifier)
        default:
            return nil
        }
    }

    /// The asset drawn to fit `side` points square at `scale`.
    static func image(_ asset: PHAsset, side: CGFloat, scale: CGFloat = 3) async -> UIImage? {
        nonisolated(unsafe) let asset = asset
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = true
        let size = CGSize(width: side * scale, height: side * scale)
        return await withCheckedContinuation { continuation in
            let once = Once()
            PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFit, options: options) { @Sendable image, info in
                // Only the final image answers; a degraded one may come first.
                guard (info?[PHImageResultIsDegradedKey] as? Bool) != true, once.claim() else { return }
                nonisolated(unsafe) let image = image
                continuation.resume(returning: image)
            }
        }
    }

    private static func imageData(_ asset: PHAsset) async -> (Data, UTType)? {
        nonisolated(unsafe) let asset = asset
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.version = .current
        options.isNetworkAccessAllowed = true
        return await withCheckedContinuation { continuation in
            let once = Once()
            PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { @Sendable data, uti, _, _ in
                guard once.claim() else { return }
                guard let data else { return continuation.resume(returning: nil) }
                continuation.resume(returning: (data, uti.flatMap(UTType.init) ?? .jpeg))
            }
        }
    }

    /// Removes the files a read left behind, for picks nobody will take.
    static func discard(_ picks: [LibraryPick]) {
        for pick in picks {
            switch pick.media {
            case .video(let file), .file(let file, _): remove(file)
            case .image: break
            }
        }
    }

    /// A file under `files`, and the folder `document` kept it in.
    nonisolated private static func remove(_ file: URL) {
        try? FileManager.default.removeItem(at: file)
        let folder = file.deletingLastPathComponent()
        if folder.deletingLastPathComponent().standardizedFileURL == files.standardizedFileURL {
            try? FileManager.default.removeItem(at: folder)
        }
    }

    /// A picture's bytes as a pick, measured and drawn small for its thumbnail.
    nonisolated static func picture(_ data: Data, type: UTType) -> LibraryPick? {
        guard let image = UIImage(data: data) else { return nil }
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let side: CGFloat = 512 * 3
        let fit = min(1, side / max(1, max(pixels.width, pixels.height)))
        let small = CGSize(width: max(1, (pixels.width * fit).rounded()), height: max(1, (pixels.height * fit).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let thumbnail = UIGraphicsImageRenderer(size: small, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: small)) }
        return LibraryPick(media: .image(data, type), thumbnail: thumbnail, pixelSize: pixels, duration: nil, assetIdentifier: "")
    }

    /// A file from Files (already this app's copy) as a pick: a picture by
    /// its bytes, a recording when recordings are wanted, else as a file,
    /// moved under `files` so it is the caller's. A picture nothing can draw
    /// (an SVG) is a file. Nothing is left behind when it can't be kept.
    nonisolated static func document(_ url: URL, videos: Bool) -> LibraryPick? {
        let type = UTType(filenameExtension: url.pathExtension) ?? .data
        if type.conforms(to: .image), let data = try? Data(contentsOf: url), let pick = picture(data, type: type) {
            try? FileManager.default.removeItem(at: url)
            return pick
        }
        try? FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        let target = files.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        let kept = target.appendingPathComponent(url.lastPathComponent)
        guard (try? FileManager.default.moveItem(at: url, to: kept)) != nil else {
            try? FileManager.default.removeItem(at: url)
            try? FileManager.default.removeItem(at: target)
            return nil
        }
        if videos, type.conforms(to: .movie) {
            return LibraryPick(media: .video(kept), thumbnail: UIImage(), pixelSize: .zero, duration: nil, assetIdentifier: "")
        }
        return LibraryPick(media: .file(kept, type), thumbnail: UIImage(), pixelSize: .zero, duration: nil, assetIdentifier: "")
    }

    nonisolated static var files: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("LibraryPicks", isDirectory: true)
    }

    private static func videoFile(_ asset: PHAsset) async -> URL? {
        nonisolated(unsafe) let asset = asset
        let options = PHVideoRequestOptions()
        options.version = .current
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true
        nonisolated(unsafe) let given: AVAsset? = await withCheckedContinuation { continuation in
            let once = Once()
            PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { @Sendable video, _, _ in
                guard once.claim() else { return }
                nonisolated(unsafe) let video = video
                continuation.resume(returning: video)
            }
        }
        guard let given else { return nil }
        try? FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        if let url = (given as? AVURLAsset)?.url {
            let ext = url.pathExtension.isEmpty ? "mov" : url.pathExtension.lowercased()
            let target = files.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
            return (try? FileManager.default.copyItem(at: url, to: target)) != nil ? target : nil
        }
        // A composition (slow motion, an edit): exported as it plays.
        guard let export = AVAssetExportSession(asset: given, presetName: AVAssetExportPresetHighestQuality) else { return nil }
        let target = files.appendingPathComponent(UUID().uuidString).appendingPathExtension("mp4")
        do {
            try await export.export(to: target, as: .mp4)
            return target
        } catch {
            return nil
        }
    }
}

/// The sheet itself; made by `LibraryPicker.present`.
@MainActor
final class LibraryPickerViewController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegate, PHPhotoLibraryChangeObserver, UICollectionViewDataSourcePrefetching {
    private let options: LibraryPicker.Options
    private let onPick: ([LibraryPick]) -> Void
    /// Gone with nothing given: cancelled or swiped away.
    var onCancel: (() -> Void)?
    private var delivered = false
    private let titleLabel = UILabel()
    private let cancelButton = UIButton(type: .system)
    private let gridLayout = LibraryGridCollectionLayout()
    private lazy var grid = UICollectionView(frame: .zero, collectionViewLayout: gridLayout)
    private let note = UIView()
    private let noteText = UILabel()
    private let noteButton = UIButton(type: .custom)
    private let blocked = UIStackView()
    private let blockedText = UILabel()
    private let blockedButton = UIButton(configuration: .filled())
    private let addButton = UIButton(configuration: .prominentGlass())
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let images = PHCachingImageManager()
    private let haptic = UISelectionFeedbackGenerator()
    private var assets: PHFetchResult<PHAsset>?
    private var status: PHAuthorizationStatus = .notDetermined
    /// Picked, in order, by local identifier.
    private(set) var picked: [String] = []
    private var reading = false
    private var readTask: Task<Void, Never>?
    private var registered = false
    private let selectedButton = LibrarySelectedButton()
    private var selectedShown = false
    /// While set the grid shows only these: the picks as they were when the
    /// count was tapped, so one unpicked there stays, unnumbered.
    private var showingPicks: [PHAsset]?

    init(options: LibraryPicker.Options, onPick: @escaping ([LibraryPick]) -> Void) {
        self.options = options
        self.onPick = onPick
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
            sheet.prefersScrollingExpandsWhenScrolledToEdge = true
            sheet.prefersEdgeAttachedInCompactHeight = true
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        if registered { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || presentingViewController == nil {
            readTask?.cancel()
            if !delivered { onCancel?() }
            onCancel = nil
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.libraryGround)
        view.accessibilityIdentifier = "library-picker"
        titleLabel.text = Strings.Library.recents
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = UIColor(Palette.text)
        titleLabel.accessibilityTraits = .header
        cancelButton.setTitle(Strings.Library.cancel, for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 17)
        cancelButton.accessibilityIdentifier = "library-cancel"
        cancelButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            if showingPicks != nil, !reading {
                showPicks(false)
                return
            }
            readTask?.cancel()
            dismiss(animated: true)
        }, for: .touchUpInside)
        selectedButton.accessibilityIdentifier = "library-selected"
        selectedButton.isHidden = true
        selectedButton.alpha = 0
        selectedButton.transform = CGAffineTransform(scaleX: 0.01, y: 0.01)
        selectedButton.addAction(UIAction { [weak self] _ in self?.showPicks(true) }, for: .touchUpInside)

        grid.backgroundColor = .clear
        grid.dataSource = self
        grid.delegate = self
        grid.prefetchDataSource = self
        grid.alwaysBounceVertical = true
        grid.accessibilityIdentifier = "library-grid"
        grid.register(LibraryCell.self, forCellWithReuseIdentifier: LibraryCell.id)

        noteText.text = Strings.Library.limited
        noteText.font = .systemFont(ofSize: 15)
        noteText.textColor = UIColor(Palette.libraryNoteText)
        noteText.numberOfLines = 0
        var manage = AttributedString(Strings.Library.manage.uppercased())
        manage.font = .systemFont(ofSize: 15, weight: .semibold)
        noteButton.setAttributedTitle(NSAttributedString(manage), for: .normal)
        noteButton.setTitleColor(UIColor(Palette.libraryNoteButtonText), for: .normal)
        noteButton.backgroundColor = UIColor(Palette.libraryNoteButton)
        noteButton.layer.cornerRadius = LibraryPickerLayout.Metrics.noteButtonHeight / 2
        noteButton.accessibilityIdentifier = "library-manage"
        noteButton.showsMenuAsPrimaryAction = true
        noteButton.menu = UIMenu(children: [
            UIAction(title: Strings.Library.selectMore, image: UIImage(systemName: "photo.badge.plus")) { [weak self] _ in
                guard let self else { return }
                PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: self)
            },
            UIAction(title: Strings.Library.changeSettings, image: UIImage(systemName: "gear")) { _ in Self.openSettings() },
        ])
        note.addSubview(noteText)
        note.addSubview(noteButton)
        note.isHidden = true
        grid.addSubview(note)

        blockedText.font = .systemFont(ofSize: 15)
        blockedText.textColor = UIColor(Palette.libraryNoteText)
        blockedText.numberOfLines = 0
        blockedText.textAlignment = .center
        blockedButton.configuration?.title = Strings.Library.openSettings
        blockedButton.configuration?.cornerStyle = .capsule
        blockedButton.accessibilityIdentifier = "library-settings"
        blockedButton.addAction(UIAction { _ in Self.openSettings() }, for: .touchUpInside)
        blocked.axis = .vertical
        blocked.alignment = .center
        blocked.spacing = 16
        blocked.addArrangedSubview(blockedText)
        blocked.addArrangedSubview(blockedButton)
        blocked.isHidden = true

        addButton.configuration?.cornerStyle = .capsule
        addButton.tintColor = UIColor(Palette.libraryCheckFill)
        addButton.configuration?.baseForegroundColor = UIColor(Palette.libraryCheckText)
        addButton.accessibilityIdentifier = "library-add"
        addButton.addAction(UIAction { [weak self] _ in self?.finish() }, for: .touchUpInside)
        addButton.isHidden = true
        spinner.color = .white
        spinner.hidesWhenStopped = true
        addButton.addSubview(spinner)

        for subview in [grid, titleLabel, cancelButton, selectedButton, blocked, addButton] as [UIView] { view.addSubview(subview) }
        authorize()
    }

    // MARK: Access

    private func authorize() {
        status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { @Sendable status in
                DispatchQueue.main.async { [weak self] in
                    self?.status = status
                    self?.load()
                }
            }
            return
        }
        load()
    }

    private func load() {
        let allowed = status == .authorized || status == .limited
        note.isHidden = status != .limited || showingPicks != nil
        blocked.isHidden = allowed || status == .notDetermined
        blockedText.text = Strings.Library.denied
        blockedButton.isHidden = false
        guard allowed else {
            view.setNeedsLayout()
            return
        }
        if !registered {
            registered = true
            PHPhotoLibrary.shared().register(self)
        }
        let videos = options.videos
        Task {
            let fetched = await Task.detached(priority: .userInitiated) { () -> SendableFetch in
                let options = PHFetchOptions()
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                options.predicate = videos
                    ? NSPredicate(format: "mediaType == %d || mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
                    : NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
                return SendableFetch(result: PHAsset.fetchAssets(with: options))
            }.value
            show(fetched.result)
        }
    }

    private func show(_ result: PHFetchResult<PHAsset>) {
        dispatchPrecondition(condition: .onQueue(.main))
        assets = result
        // Only the picks are looked up: faulting the whole library would
        // stall the main thread on a large one.
        if !picked.isEmpty {
            let still = PHAsset.fetchAssets(withLocalIdentifiers: picked, options: nil)
            let live = Set((0..<still.count).map { still.object(at: $0) }.filter { result.contains($0) }.map(\.localIdentifier))
            let before = picked
            picked.removeAll { !live.contains($0) }
            if let shown = showingPicks {
                showingPicks = shown.filter { result.contains($0) }
                if picked.isEmpty { showPicks(false) }
            }
            if picked != before { updateButton() }
        }
        // An empty library says so where the refusal would be.
        if result.count == 0 {
            blockedText.text = Strings.Library.empty
            blockedButton.isHidden = true
            blocked.isHidden = false
        } else if status == .authorized || status == .limited {
            blocked.isHidden = true
        }
        images.stopCachingImagesForAllAssets()
        cachedRange = 0..<0
        grid.reloadData()
        view.setNeedsLayout()
    }

    nonisolated func photoLibraryDidChange(_ change: PHChange) {
        nonisolated(unsafe) let change = change
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            if status != self.status {
                self.status = status
                self.load()
                return
            }
            guard let assets, let details = change.changeDetails(for: assets) else { return }
            show(details.fetchResultAfterChanges)
        }
    }

    private static func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    // MARK: Layout

    private func layout() -> LibraryPickerLayout {
        LibraryPickerLayout(.init(
            width: view.bounds.width, height: view.bounds.height, safeBottom: view.safeAreaInsets.bottom,
            wide: traitCollection.verticalSizeClass == .compact, pixel: view.hairline, count: showingPicks?.count ?? assets?.count ?? 0,
            note: note.isHidden ? nil : noteText.measurable,
            noteButton: note.isHidden ? nil : noteButton.titleLabel?.intrinsicContentSize,
            title: titleLabel.intrinsicContentSize, cancel: cancelButton.intrinsicContentSize, picking: !picked.isEmpty,
            selected: picked.isEmpty ? nil : selectedButton.numberSize
        ))
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = layout()
        titleLabel.setLayoutFrame(layout.title)
        cancelButton.setLayoutFrame(layout.cancel)
        place(selectedButton: layout)
        grid.frame = layout.grid
        gridLayout.layout = layout
        let inset = UIEdgeInsets(top: 0, left: 0, bottom: layout.bottomInset, right: 0)
        if grid.contentInset != inset {
            grid.contentInset = inset
            grid.verticalScrollIndicatorInsets = inset
        }
        if let frame = layout.note {
            note.frame = frame
            noteText.setLayoutFrame(layout.noteText ?? .zero)
            noteButton.setLayoutFrame(layout.noteButton ?? .zero)
        }
        addButton.frame = layout.button
        spinner.frame = addButton.bounds
        let size = blocked.systemLayoutSizeFitting(CGSize(width: layout.blockedWidth, height: .greatestFiniteMagnitude), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        blocked.frame = layout.blocked(height: size.height)
        updateCaching(layout)
    }

    /// Indices into `assets` cached at `cachedSize`; both reset when either changes.
    private var cachedRange: Range<Int> = 0..<0
    private var cachedSize: CGSize = .zero

    /// Thumbnails a screen ahead and behind are made before they show.
    private func updateCaching(_ layout: LibraryPickerLayout) {
        // The picks alone are few, and asked for as they show.
        guard let assets, showingPicks == nil, view.window != nil else { return }
        let size = thumbnailSize(layout)
        if size != cachedSize {
            images.stopCachingImagesForAllAssets()
            cachedRange = 0..<0
            cachedSize = size
        }
        let bounds = grid.bounds
        let range = layout.visible(minY: bounds.minY - bounds.height, maxY: bounds.maxY + bounds.height, count: assets.count)
        guard range != cachedRange else { return }
        let old = Set(cachedRange)
        let new = Set(range)
        let start = new.subtracting(old).map { assets.object(at: $0) }
        let stop = old.subtracting(new).filter { $0 < assets.count }.map { assets.object(at: $0) }
        let options = LibraryCell.thumbnailOptions
        images.startCachingImages(for: start, targetSize: size, contentMode: .aspectFill, options: options)
        images.stopCachingImages(for: stop, targetSize: size, contentMode: .aspectFill, options: options)
        cachedRange = range
    }

    private func thumbnailSize(_ layout: LibraryPickerLayout) -> CGSize {
        let scale = view.window?.screen.scale ?? 3
        return CGSize(width: layout.cell.width * scale, height: layout.cell.height * scale)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard let layout = gridLayout.layout else { return }
        updateCaching(layout)
    }

    // MARK: Grid

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { showingPicks?.count ?? assets?.count ?? 0 }

    /// The grid's `index`th: of the picks while only they show, else of the library.
    private func asset(at index: Int) -> PHAsset? {
        if let showingPicks { return showingPicks.indices.contains(index) ? showingPicks[index] : nil }
        guard let assets, index < assets.count else { return nil }
        return assets.object(at: index)
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: LibraryCell.id, for: indexPath) as! LibraryCell
        guard let layout = gridLayout.layout, let asset = asset(at: indexPath.item) else { return cell }
        cell.show(asset, index: indexPath.item, images: images, size: thumbnailSize(layout))
        cell.number = number(asset.localIdentifier)
        cell.dimmed = cell.number == nil && picked.count >= options.limit
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {}

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: false)
        guard !reading, let asset = asset(at: indexPath.item) else { return }
        toggle(asset.localIdentifier)
    }

    /// The grid shows only the picks, in the order picked, or everything
    /// again; meanwhile Cancel is Back and the count hides, as Telegram's
    /// selected media.
    private func showPicks(_ on: Bool) {
        guard (showingPicks != nil) != on, !reading else { return }
        if on {
            guard !picked.isEmpty else { return }
            let found = PHAsset.fetchAssets(withLocalIdentifiers: picked, options: nil)
            let byID = Dictionary((0..<found.count).map { (found.object(at: $0).localIdentifier, found.object(at: $0)) }, uniquingKeysWith: { a, _ in a })
            showingPicks = picked.compactMap { byID[$0] }
        } else {
            showingPicks = nil
        }
        titleLabel.text = on ? Strings.Library.selected(picked.count) : Strings.Library.recents
        cancelButton.setTitle(on ? Strings.Library.back : Strings.Library.cancel, for: .normal)
        updateSelected()
        UIView.transition(with: grid, duration: 0.25, options: [.transitionCrossDissolve, .allowUserInteraction]) {
            self.note.isHidden = on || self.status != .limited
            // The cells start under the note, so the grid learns first.
            self.gridLayout.layout = self.layout()
            self.grid.reloadData()
            self.grid.contentOffset = CGPoint(x: 0, y: -self.grid.adjustedContentInset.top)
        }
        view.setNeedsLayout()
    }

    private func place(selectedButton layout: LibraryPickerLayout) {
        guard let frame = layout.selected else { return }
        // Its scale animates, so its frame is never set.
        selectedButton.bounds = CGRect(origin: .zero, size: frame.size)
        selectedButton.center = CGPoint(x: frame.midX, y: frame.midY)
    }

    /// The count shows while something is picked and the grid shows
    /// everything, scaling in and out over 0.25 s as Telegram's.
    private func updateSelected() {
        // Shrinking out, it keeps the last count it had.
        if !picked.isEmpty {
            selectedButton.count = picked.count
            place(selectedButton: layout())
        }
        if showingPicks != nil {
            titleLabel.text = Strings.Library.selected(picked.count)
            view.setNeedsLayout()
        }
        let shown = !picked.isEmpty && showingPicks == nil
        guard shown != selectedShown else { return }
        selectedShown = shown
        if shown { selectedButton.isHidden = false }
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState]) {
            self.selectedButton.alpha = shown ? 1 : 0
            self.selectedButton.transform = shown ? .identity : CGAffineTransform(scaleX: 0.01, y: 0.01)
        } completion: { finished in
            if finished, !self.selectedShown { self.selectedButton.isHidden = true }
        }
    }

    private func number(_ id: String) -> Int? {
        picked.firstIndex(of: id).map { $0 + 1 }
    }

    /// Picks or unpicks; the numbers after it close up.
    func toggle(_ id: String) {
        if let index = picked.firstIndex(of: id) {
            picked.remove(at: index)
        } else {
            guard picked.count < options.limit else { return }
            picked.append(id)
        }
        haptic.selectionChanged()
        let limitReached = picked.count >= options.limit
        for cell in grid.visibleCells.compactMap({ $0 as? LibraryCell }) {
            guard let cellID = cell.assetID else { continue }
            let next = number(cellID)
            cell.setNumber(next, animated: cellID == id)
            cell.dimmed = next == nil && limitReached
        }
        if picked.isEmpty { showPicks(false) }
        updateButton()
    }

    private func updateButton() {
        let picking = !picked.isEmpty
        var title = AttributedString(Strings.Library.add(picked.count, action: options.action))
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        title.foregroundColor = UIColor(Palette.libraryCheckText)
        addButton.configuration?.attributedTitle = title
        updateSelected()
        guard picking == addButton.isHidden || (picking && addButton.frame.minY > view.bounds.height) else { return }
        if picking { addButton.isHidden = false }
        UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        } completion: { _ in
            if self.picked.isEmpty { self.addButton.isHidden = true }
        }
    }

    // MARK: Done

    private func finish() {
        guard !reading, assets != nil, !picked.isEmpty else { return }
        reading = true
        // Swiping away mid-read would lose the picks silently; Cancel still works.
        isModalInPresentation = true
        let found = PHAsset.fetchAssets(withLocalIdentifiers: picked, options: nil)
        let byID = Dictionary((0..<found.count).map { (found.object(at: $0).localIdentifier, found.object(at: $0)) }, uniquingKeysWith: { a, _ in a })
        let chosen = picked.compactMap { byID[$0] }
        addButton.configuration?.attributedTitle = AttributedString("")
        spinner.startAnimating()
        readTask = Task { [weak self] in
            var picks: [LibraryPick] = []
            for asset in chosen {
                if let pick = await LibraryPicker.read(asset) { picks.append(pick) }
                if Task.isCancelled { break }
            }
            // Cancelled, or gone: `onPick` is never called after Cancel.
            guard let self, !Task.isCancelled, presentingViewController != nil, !isBeingDismissed else {
                LibraryPicker.discard(picks)
                return
            }
            spinner.stopAnimating()
            reading = false
            readTask = nil
            isModalInPresentation = false
            guard !picks.isEmpty else {
                updateButton()
                let alert = UIAlertController(title: Strings.Library.couldntRead, message: nil, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: Strings.Library.done, style: .default))
                present(alert, animated: true)
                return
            }
            let onPick = onPick
            delivered = true
            dismiss(animated: true) { onPick(picks) }
        }
    }
}

/// A fetch handed from the queue that made it to the main actor, which
/// alone reads it from there.
private struct SendableFetch: @unchecked Sendable {
    let result: PHFetchResult<PHAsset>
}

/// True for the first caller only: PhotoKit may answer a request more than
/// once, a continuation only once.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.withLock {
            defer { claimed = true }
            return !claimed
        }
    }
}

/// The grid's frames, straight from `LibraryPickerLayout`.
final class LibraryGridCollectionLayout: UICollectionViewLayout {
    var layout: LibraryPickerLayout? {
        didSet { if layout != oldValue { invalidateLayout() } }
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: layout?.bar.width ?? 0, height: layout?.contentHeight ?? 0)
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard let layout, let count = collectionView?.numberOfItems(inSection: 0) else { return nil }
        return layout.visible(minY: rect.minY, maxY: rect.maxY, count: count).map { attributes(layout, $0) }
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard let layout else { return nil }
        return attributes(layout, indexPath.item)
    }

    private func attributes(_ layout: LibraryPickerLayout, _ index: Int) -> UICollectionViewLayoutAttributes {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
        attributes.frame = layout.frame(at: index)
        return attributes
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool { false }
}

/// One picture of the grid: the thumbnail filling the square, the number
/// circle at its top right and a video's length at its bottom right.
final class LibraryCell: UICollectionViewCell {
    static let id = "library-cell"
    private let picture = UIImageView()
    private let check = LibraryCheckView()
    private let duration = UILabel()
    private var request: PHImageRequestID?
    private weak var images: PHCachingImageManager?
    private(set) var assetID: String?
    private var isVideo = false
    private var length = ""
    var number: Int? {
        get { check.number }
        set { setNumber(newValue, animated: false) }
    }
    /// Nothing more can be picked: an unpicked picture fades.
    var dimmed = false { didSet { picture.alpha = dimmed ? 0.5 : 1 } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = UIColor(Palette.libraryPlaceholder)
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        contentView.addSubview(picture)
        duration.font = .systemFont(ofSize: 11, weight: .semibold)
        duration.textColor = .white
        duration.layer.shadowColor = UIColor.black.cgColor
        duration.layer.shadowOpacity = 0.4
        duration.layer.shadowRadius = 2
        duration.layer.shadowOffset = .zero
        contentView.addSubview(duration)
        contentView.addSubview(check)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ asset: PHAsset, index: Int, images: PHCachingImageManager, size: CGSize) {
        if let request { self.images?.cancelImageRequest(request) }
        self.images = images
        assetID = asset.localIdentifier
        accessibilityIdentifier = "library-cell:\(index)"
        isVideo = asset.mediaType == .video
        length = isVideo ? LibraryPickerLayout.duration(seconds: asset.duration) : ""
        duration.text = length
        duration.isHidden = !isVideo
        picture.image = nil
        let id = asset.localIdentifier
        request = images.requestImage(for: asset, targetSize: size, contentMode: .aspectFill, options: Self.thumbnailOptions) { @Sendable [weak self] image, _ in
            // A failed full-size fetch (offline iCloud) keeps the degraded one.
            guard let got = image else { return }
            nonisolated(unsafe) let image = got
            let apply = { @MainActor in
                guard let self, self.assetID == id else { return }
                self.picture.image = image
            }
            // A cached thumbnail arrives at once, on main: shown in the same frame.
            if Thread.isMainThread { MainActor.assumeIsolated(apply) } else { DispatchQueue.main.async(execute: apply) }
        }
        setNeedsLayout()
    }

    /// The grid's thumbnail requests, the same for caching and showing so
    /// the cache is hit.
    nonisolated(unsafe) static let thumbnailOptions: PHImageRequestOptions = {
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        return options
    }()

    func setNumber(_ number: Int?, animated: Bool) {
        check.set(number, animated: animated)
        accessibilityLabel = isVideo ? Strings.Library.video(length, index: number) : Strings.Library.photo(number)
        accessibilityValue = number.map(String.init)
        if number != nil { accessibilityTraits.insert(.selected) } else { accessibilityTraits.remove(.selected) }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        if let request { images?.cancelImageRequest(request) }
        request = nil
        assetID = nil
        picture.image = nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        picture.frame = contentView.bounds
        check.frame = LibraryPickerLayout.check(in: bounds.size)
        duration.frame = LibraryPickerLayout.duration(duration.intrinsicContentSize, in: bounds.size)
    }
}

/// Telegram's count of the picks after Cancel (`SelectedButtonNode`): a
/// blue pill with a check and the number, a little easier to hit than it looks.
final class LibrarySelectedButton: UIControl {
    private let check = CAShapeLayer()
    private let number = UILabel()

    var count = 0 {
        didSet {
            guard count != oldValue else { return }
            number.text = String(count)
            accessibilityLabel = Strings.Library.selected(count)
            setNeedsLayout()
        }
    }

    var numberSize: CGSize { number.intrinsicContentSize }

    override init(frame: CGRect) {
        super.init(frame: frame)
        typealias M = LibraryPickerLayout.Metrics
        backgroundColor = UIColor(Palette.libraryCheckFill)
        layer.cornerRadius = M.selectedHeight / 2
        let box = M.selectedCheck
        let path = UIBezierPath()
        path.move(to: CGPoint(x: box.minX + 1.5, y: box.minY + 5.5))
        path.addLine(to: CGPoint(x: box.minX + 5, y: box.minY + 9))
        path.addLine(to: CGPoint(x: box.maxX - 1.5, y: box.minY + 1.5))
        check.path = path.cgPath
        check.fillColor = nil
        check.lineWidth = 2
        check.lineCap = .round
        check.lineJoin = .round
        layer.addSublayer(check)
        let font = UIFont.monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        number.font = font.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: 15) } ?? font
        number.textColor = UIColor(Palette.libraryCheckText)
        number.text = "0"
        addSubview(number)
        isAccessibilityElement = true
        accessibilityTraits = .button
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.setNeedsLayout() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        check.strokeColor = UIColor(Palette.libraryCheckText).resolvedColor(with: traitCollection).cgColor
        let size = number.intrinsicContentSize
        number.frame = CGRect(x: LibraryPickerLayout.Metrics.selectedNumberX, y: floor((bounds.height - size.height) / 2), width: size.width, height: size.height)
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -8, dy: -12).contains(point)
    }
}

/// Telegram's number circle over a picture: a white ring with a soft
/// shadow, filled blue with the pick's number once picked.
final class LibraryCheckView: UIView {
    private(set) var number: Int?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func set(_ number: Int?, animated: Bool) {
        let filled = (number != nil) != (self.number != nil)
        guard number != self.number else { return }
        self.number = number
        setNeedsDisplay()
        guard animated, filled, number != nil else { return }
        transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
        UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.transform = .identity
        }
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let traits = traitCollection
        let scale = window?.screen.scale ?? 3
        let border: CGFloat = 1.5
        let inset = 2 - 1 / scale
        let ring = bounds.insetBy(dx: border / 2 + inset, dy: border / 2 + inset)
        context.saveGState()
        context.setShadow(offset: .zero, blur: 2.5, color: UIColor(Palette.libraryCheckShadow).resolvedColor(with: traits).cgColor)
        context.setStrokeColor(UIColor(Palette.libraryCheckBorder).resolvedColor(with: traits).cgColor)
        context.setLineWidth(border)
        context.strokeEllipse(in: ring)
        context.restoreGState()
        guard let number else { return }
        let fill = bounds.insetBy(dx: border + inset, dy: border + inset)
        context.setFillColor(UIColor(Palette.libraryCheckFill).resolvedColor(with: traits).cgColor)
        context.fillEllipse(in: fill)
        let size = LibraryPickerLayout.numberSize(number)
        let font = UIFont.systemFont(ofSize: size, weight: .medium)
        let rounded = font.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: size) } ?? font
        let text = NSAttributedString(string: String(number), attributes: [.font: rounded, .foregroundColor: UIColor(Palette.libraryCheckText).resolvedColor(with: traits)])
        let measured = text.size()
        text.draw(at: CGPoint(x: (bounds.width - measured.width) / 2, y: (bounds.height - measured.height) / 2))
    }
}
#endif
