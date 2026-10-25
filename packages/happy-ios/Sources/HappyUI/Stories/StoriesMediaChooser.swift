#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Where a story's media comes from (happy-agent `API.md` "Making a story
/// by hand"): photos and videos on the device, the camera, media already in
/// the person's conversations, or a draft to go back to. Device media is
/// readied here for its upload: a HEIC photo becomes a JPEG, and each is
/// measured and given a background from its edges.
@MainActor
final class StoriesMediaChooser: NSObject, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIAdaptivePresentationControllerDelegate {
    struct Picked {
        var frame: StoryDraft.Frame
        var local: StoryLocalMedia?
    }

    enum Choice {
        case picked([Picked])
        case draft(Story)
    }

    /// The harness's photo library: what Photos hands back instead of the
    /// system picker, which a test can't fill.
    static var library: (() async -> [Picked])?

    private let session: StoriesSession
    private weak var host: UIViewController?
    private let limit: Int
    private let drafts: Bool
    private let done: (Choice) -> Void
    /// Kept while the system pickers are up; they don't keep their delegate.
    private static var live: Set<StoriesMediaChooser> = []

    init(session: StoriesSession, host: UIViewController, limit: Int, drafts: Bool, done: @escaping (Choice) -> Void) {
        self.session = session
        self.host = host
        self.limit = limit
        self.drafts = drafts
        self.done = done
    }

    /// Asks where from, under `anchor`.
    func start(from anchor: UIView) {
        guard let host else { return }
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: Strings.Stories.photos, style: .default) { _ in self.photos() })
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            sheet.addAction(UIAlertAction(title: Strings.Stories.camera, style: .default) { _ in self.camera() })
        }
        if session.stemCells != nil {
            sheet.addAction(UIAlertAction(title: Strings.Stories.fromConversations, style: .default) { _ in self.conversations() })
        }
        if drafts {
            sheet.addAction(UIAlertAction(title: Strings.Stories.drafts, style: .default) { _ in self.draftList() })
        }
        sheet.addAction(UIAlertAction(title: Strings.Stories.cancel, style: .cancel))
        sheet.popoverPresentationController?.sourceView = anchor
        sheet.popoverPresentationController?.sourceRect = anchor.bounds
        sheet.view.accessibilityIdentifier = "story-sources"
        host.present(sheet, animated: true)
    }

    private func finish(_ choice: Choice) {
        Self.live.remove(self)
        done(choice)
    }

    // MARK: Photos

    private func photos() {
        if let library = Self.library {
            Self.live.insert(self)
            Task { finish(.picked(Array(await library().prefix(limit)))) }
            return
        }
        var configuration = PHPickerConfiguration()
        configuration.selectionLimit = limit
        configuration.filter = .any(of: [.images, .videos])
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        show(picker)
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        // Read one at a time on the main actor, which the picker calls on.
        nonisolated(unsafe) let providers = results.map(\.itemProvider)
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            if providers.isEmpty {
                Self.live.remove(self)
                return
            }
            Task {
                var picked: [Picked] = []
                for provider in providers {
                    if let one = await Self.read(provider) { picked.append(one) }
                }
                if picked.isEmpty { self.refuse() }
                self.finish(.picked(picked))
            }
        }
    }

    /// Swiped away: nothing was picked.
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        Self.live.remove(self)
    }

    /// Presents a picker this chooser waits on, kept until it answers or goes.
    private func show(_ picker: UIViewController) {
        Self.live.insert(self)
        host?.present(picker, animated: true)
        picker.presentationController?.delegate = self
    }

    private func refuse(attempt: Int = 0) {
        Self.live.remove(self)
        guard let host else { return }
        // A picker on its way out would drop the alert.
        if host.presentedViewController != nil, attempt < 20 {
            Self.live.insert(self)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.refuse(attempt: attempt + 1) }
            return
        }
        let alert = UIAlertController(title: Strings.Stories.couldntOpen, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Stories.done, style: .default))
        host.present(alert, animated: true)
    }

    private static func read(_ given: NSItemProvider) async -> Picked? {
        // Handed to the provider's own queue to copy from, and used by nothing else.
        nonisolated(unsafe) let provider = given
        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            guard let file = await copy(provider, type: .movie) else { return nil }
            return await video(file)
        }
        guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), let file = await copy(provider, type: .image) else { return nil }
        defer { try? FileManager.default.removeItem(at: file) }
        guard let data = try? Data(contentsOf: file) else { return nil }
        return await image(data, type: UTType(filenameExtension: file.pathExtension))
    }

    /// The provider's file, copied out before the provider takes it back.
    /// The provider calls back on a queue of its own, never the main actor.
    private nonisolated static func copy(_ provider: NSItemProvider, type: UTType) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { @Sendable url, _ in
                guard let url else { return continuation.resume(returning: nil) }
                let target = uploads.appendingPathComponent(ClientID.make()).appendingPathExtension(url.pathExtension.lowercased())
                try? FileManager.default.createDirectory(at: uploads, withIntermediateDirectories: true)
                continuation.resume(returning: (try? FileManager.default.copyItem(at: url, to: target)) != nil ? target : nil)
            }
        }
    }

    nonisolated static var uploads: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("StoriesUploads", isDirectory: true)
    }

    /// A photo readied for its upload: kept as it is when the daemon reads
    /// it, otherwise (HEIC, or anything else) drawn upright into a JPEG.
    static func image(_ data: Data, type: UTType?) async -> Picked? {
        let ready = await Task.detached(priority: .userInitiated) { () -> (URL, String, CGSize, UIImage, [String])? in
            guard let image = UIImage(data: data) else { return nil }
            let kept: [UTType] = [.png, .jpeg, .gif, .webP]
            // A picture over the daemon's 32 MiB is drawn smaller instead.
            let keeps = (type.map { type in kept.contains { type.conforms(to: $0) } } ?? false) && data.count <= Self.maxImageBytes
            let size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
            var bytes = data
            var ext = type?.preferredFilenameExtension ?? "jpg"
            var pixels = size
            if !keeps {
                let longest = max(size.width, size.height)
                let fit = min(1, 4096 / max(1, longest))
                pixels = CGSize(width: (size.width * fit).rounded(), height: (size.height * fit).rounded())
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                let upright = UIGraphicsImageRenderer(size: pixels, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: pixels)) }
                guard let jpeg = upright.jpegData(compressionQuality: 0.9), jpeg.count <= Self.maxImageBytes else { return nil }
                bytes = jpeg
                ext = "jpg"
            }
            let preview = StemCellsImages.decode(bytes, maxPixels: 2048) ?? image
            let id = ClientID.make()
            try? FileManager.default.createDirectory(at: uploads, withIntermediateDirectories: true)
            let file = uploads.appendingPathComponent(id).appendingPathExtension(ext)
            guard (try? bytes.write(to: file)) != nil else { return nil }
            return (file, "\(id).\(ext)", pixels, preview, edges(preview))
        }.value
        guard let (file, name, pixels, preview, background) = ready else { return nil }
        let frame = StoryDraft.Frame(kind: .image, width: Int(pixels.width), height: Int(pixels.height), media: .local(file: file, name: name), background: background)
        return Picked(frame: frame, local: .image(preview))
    }

    nonisolated static let maxImageBytes = 32 * 1024 * 1024
    nonisolated static let maxVideoBytes = 256 * 1024 * 1024

    /// A recording as it is, measured, with its first frame to show. The
    /// file is the editor's from here, or removed when it can't be used.
    static func video(_ file: URL) async -> Picked? {
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        let asset = AVURLAsset(url: file)
        guard size > 0, size <= maxVideoBytes, let track = try? await asset.loadTracks(withMediaType: .video).first,
              let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform) else {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
        let turned = natural.applying(transform)
        let duration = (try? await asset.load(.duration)).map { Int($0.seconds * 1000) }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1280, height: 1280)
        let poster = (try? await generator.image(at: .zero)).map { UIImage(cgImage: $0.image) }
        let name = "\(ClientID.make()).\(file.pathExtension.isEmpty ? "mov" : file.pathExtension)"
        let frame = StoryDraft.Frame(kind: .video, width: Int(abs(turned.width)), height: Int(abs(turned.height)), durationMs: duration, media: .local(file: file, name: name), background: ["#000000", "#000000"])
        return Picked(frame: frame, local: .video(file, poster: poster))
    }

    /// Two colours from the picture's top and bottom edges, as the daemon
    /// picks them when a client leaves the background out.
    nonisolated static func edges(_ image: UIImage) -> [String] {
        guard let cgImage = image.cgImage else { return ["#000000", "#000000"] }
        var pixels = [UInt8](repeating: 0, count: 4 * 16)
        guard let context = CGContext(data: &pixels, width: 1, height: 16, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return ["#000000", "#000000"] }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 1, height: 16))
        // The first row in memory is the picture's top.
        func hex(_ row: Int) -> String { String(format: "#%02X%02X%02X", pixels[row * 4], pixels[row * 4 + 1], pixels[row * 4 + 2]) }
        return [hex(0), hex(15)]
    }

    // MARK: Camera

    private func camera() {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        picker.videoMaximumDuration = 60
        picker.delegate = self
        show(picker)
    }

    nonisolated func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        let image = info[.originalImage] as? UIImage
        let movie = info[.mediaURL] as? URL
        let data = image?.jpegData(compressionQuality: 0.92)
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            Task {
                var picked: Picked?
                if let movie {
                    let target = Self.uploads.appendingPathComponent(ClientID.make()).appendingPathExtension(movie.pathExtension)
                    try? FileManager.default.createDirectory(at: Self.uploads, withIntermediateDirectories: true)
                    if (try? FileManager.default.copyItem(at: movie, to: target)) != nil { picked = await Self.video(target) }
                } else if let data {
                    picked = await Self.image(data, type: .jpeg)
                }
                guard let picked else { return self.refuse() }
                self.finish(.picked([picked]))
            }
        }
    }

    nonisolated func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            Self.live.remove(self)
        }
    }

    // MARK: Conversations and drafts

    private func conversations() {
        guard let host else { return }
        let list = StoriesConversationMediaViewController(session: session) { [weak self] picked in
            self?.finish(.picked([picked]))
        }
        list.onCancel = { [weak self] in if let self { Self.live.remove(self) } }
        show(UINavigationController(rootViewController: list))
    }

    private func draftList() {
        guard let host else { return }
        let list = StoriesDraftsViewController(session: session) { [weak self] story in
            self?.finish(.draft(story))
        }
        list.onCancel = { [weak self] in if let self { Self.live.remove(self) } }
        show(UINavigationController(rootViewController: list))
    }
}

/// The person's conversations, then one's images and videos
/// (`GET /v0/stories/media`), to put in a story by identity.
final class StoriesConversationMediaViewController: UITableViewController {
    var onCancel: (() -> Void)?
    private let session: StoriesSession
    private let done: (StoriesMediaChooser.Picked) -> Void
    private var rows: [StemCellsRow] = []

    init(session: StoriesSession, done: @escaping (StoriesMediaChooser.Picked) -> Void) {
        self.session = session
        self.done = done
        super.init(style: .insetGrouped)
        title = Strings.Stories.fromConversations
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in
            self?.onCancel?()
            self?.dismiss(animated: true)
        })
        var seen = Set<String>()
        rows = (session.stemCells?.snapshot.rows ?? []).filter { row in
            guard let agentId = row.agentId, row.kind == .session || row.kind == .space else { return false }
            return seen.insert(agentId).inserted
        }
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        tableView.accessibilityIdentifier = "story-conversations"
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = rows[indexPath.row].label
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        cell.accessibilityIdentifier = "story-conversation:\(rows[indexPath.row].agentId ?? "")"
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        guard let agentId = rows[indexPath.row].agentId else { return }
        let grid = StoriesConversationGridViewController(session: session, agentId: agentId) { [weak self] picked in
            self?.dismiss(animated: true)
            self?.done(picked)
        }
        grid.title = rows[indexPath.row].label
        navigationController?.pushViewController(grid, animated: true)
    }
}

/// One conversation's media in a grid, newest first.
final class StoriesConversationGridViewController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegate {
    private let session: StoriesSession
    private let agentId: String
    private let done: (StoriesMediaChooser.Picked) -> Void
    private let grid = StickerPickerCollectionLayout()
    private lazy var collection = UICollectionView(frame: .zero, collectionViewLayout: grid)
    private let empty = UILabel()
    private var items: [StoryMediaItem] = []
    private var picking = false

    init(session: StoriesSession, agentId: String, done: @escaping (StoriesMediaChooser.Picked) -> Void) {
        self.session = session
        self.agentId = agentId
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        collection.backgroundColor = .clear
        collection.dataSource = self
        collection.delegate = self
        collection.register(StoriesMediaCell.self, forCellWithReuseIdentifier: "media")
        collection.accessibilityIdentifier = "story-conversation-media"
        view.addSubview(collection)
        empty.text = Strings.Stories.noMedia
        empty.textColor = .secondaryLabel
        empty.textAlignment = .center
        empty.isHidden = true
        view.addSubview(empty)
        let client = session.client
        let agentId = agentId
        Task { [weak self] in
            let page = try? await client.storyMedia(agentId: agentId, limit: 100)
            guard let self else { return }
            items = page?.items ?? []
            grid.sections = [StickerPickerLayout.Section(kind: .stickers, count: items.count, header: false)]
            empty.isHidden = !items.isEmpty
            collection.reloadData()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        collection.frame = view.bounds
        empty.frame = CGRect(x: 16, y: view.safeAreaInsets.top + 40, width: view.bounds.width - 32, height: 24)
    }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { items.count }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "media", for: indexPath) as! StoriesMediaCell
        let item = items[indexPath.item]
        cell.show(item, images: session.images, path: DirectAgentClient.path(item.asset))
        cell.accessibilityIdentifier = "story-media:\(indexPath.item)"
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        // One pick: a second tap while the first loads is nothing.
        guard !picking else { return }
        picking = true
        collectionView.isUserInteractionEnabled = false
        let item = items[indexPath.item]
        let images = session.images
        Task { [weak self] in
            let picture = item.kind == .image ? await images.picture(DirectAgentClient.path(item.asset), thumbhash: item.thumbhash, pixels: 2048) : nil
            // The editor draws the item from here: the story doesn't hold it yet.
            let local: StoryLocalMedia = picture.map(StoryLocalMedia.image) ?? .asset(item.asset, poster: StemCellsImages.placeholder(item.thumbhash))
            // The background from the picture's edges, as for a device photo.
            let background = picture.map { StoriesMediaChooser.edges($0) }
            let frame = StoryDraft.Frame(kind: item.kind == .video ? .video : .image, width: item.width, height: item.height, media: .asset(item.asset), background: background)
            self?.done(StoriesMediaChooser.Picked(frame: frame, local: local))
        }
    }
}

/// A conversation's picture, or a recording's placeholder with a play mark.
final class StoriesMediaCell: UICollectionViewCell {
    private let image = UIImageView()
    private let play = UILabel()
    private var loading: Task<Void, Never>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        image.contentMode = .scaleAspectFill
        image.clipsToBounds = true
        image.layer.cornerRadius = 6
        image.backgroundColor = .tertiarySystemFill
        contentView.addSubview(image)
        play.text = "▶︎"
        play.textColor = .white
        play.textAlignment = .center
        contentView.addSubview(play)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ item: StoryMediaItem, images: StemCellsImages, path: String) {
        loading?.cancel()
        image.image = StemCellsImages.placeholder(item.thumbhash)
        play.isHidden = item.kind != .video
        accessibilityLabel = item.name
        guard item.kind == .image else { return }
        let pixels = Int(max(bounds.width, 80) * 3)
        loading = Task { [weak self] in
            let picture = await images.picture(path, thumbhash: item.thumbhash, pixels: pixels)
            guard let self, !Task.isCancelled, let picture else { return }
            image.image = picture
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        image.frame = contentView.bounds
        play.frame = contentView.bounds
    }
}

/// The person's drafts (`GET /v0/stories?status=draft`), to edit one.
final class StoriesDraftsViewController: UITableViewController {
    var onCancel: (() -> Void)?
    private let session: StoriesSession
    private let done: (Story) -> Void
    private var drafts: [Story] = []

    init(session: StoriesSession, done: @escaping (Story) -> Void) {
        self.session = session
        self.done = done
        super.init(style: .insetGrouped)
        title = Strings.Stories.drafts
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in
            self?.onCancel?()
            self?.dismiss(animated: true)
        })
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "draft")
        tableView.accessibilityIdentifier = "story-drafts"
        let store = session.store
        Task { [weak self] in
            let drafts = (try? await store.drafts()) ?? []
            guard let self else { return }
            self.drafts = drafts
            tableView.reloadData()
        }
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { drafts.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "draft", for: indexPath)
        let draft = drafts[indexPath.row]
        var content = cell.defaultContentConfiguration()
        content.text = draft.caption ?? Strings.Stories.draft
        content.secondaryText = Strings.Stories.ago(Int64(Date().timeIntervalSince1970 * 1000) - draft.updatedAt)
        cell.contentConfiguration = content
        cell.accessibilityIdentifier = "story-draft:\(draft.id)"
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        let draft = drafts[indexPath.row]
        dismiss(animated: true) { [done] in done(draft) }
    }
}
#endif
