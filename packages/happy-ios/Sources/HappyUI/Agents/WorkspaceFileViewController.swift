#if canImport(UIKit)
import AVKit
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// The file a file link (`happy://agents/<id>/files/Foo.tsx#L42`) names,
/// read-only, over the conversation it was tapped in: its syntax-coloured
/// lines, scrolled to the linked line. The conversation reads the file
/// first (`AgentClient.linkedFile`), so this only shows it; nothing here
/// writes. Drawn as the session file screen draws a file
/// (`SessionFileViewController`), without its Diff and File toggle.
///
/// Follows the person's text size: the lines are measured at it off the
/// main thread, and a new size measures them again.
///
/// A picture or a recording (`FileViewer.mediaKind`) shows as itself under
/// the same header, as desktop's FilePreview shows one: the picture fitted
/// to the screen, pinched or double-tapped to zoom and tapped to open in
/// the viewer; the recording in the system's player, with its controls.
/// One that doesn't decode says it's binary.
final class WorkspaceFileViewController: UIViewController {
    private let session: Session
    private let file: HappyLink.File
    private let content: FileViewer.Content
    private let media: (kind: FileViewer.MediaKind, bytes: Data)?

    private let header = UIView()
    private let icon = FileIconView()
    private let pathLabel = StyledLabel(style: FileViewerTextStyles.path, color: Palette.textSecondary)
    private let headerBorder = UIView()
    private let lines = FileLinesView()
    private(set) var stateView: UIView?

    private var planTask: Task<Void, Never>?
    private var planned: (width: CGFloat, maxWidth: CGFloat, text: TextEnvironment?)?
    private var scrollsToLine = true
    private var colourTask: Task<Void, Never>?
    private var mediaTask: Task<Void, Never>?
    private(set) var picture: PicturePage?
    private(set) var playback: AVPlayerViewController?
    /// Where a recording is written for the player, removed with the screen.
    private let videoFolder = FileManager.default.temporaryDirectory.appendingPathComponent("WorkspaceFiles/\(UUID().uuidString)", isDirectory: true)

    convenience init(session: Session, file: HappyLink.File, content: FileViewer.Content) {
        self.init(session: session, file: file, content: content, media: nil)
    }

    convenience init(session: Session, file: HappyLink.File, media kind: FileViewer.MediaKind, bytes: Data) {
        self.init(session: session, file: file, content: FileViewer.Content(content: "", isBinary: false), media: (kind, bytes))
    }

    private init(session: Session, file: HappyLink.File, content: FileViewer.Content, media: (kind: FileViewer.MediaKind, bytes: Data)?) {
        self.session = session
        self.file = file
        self.content = content
        self.media = media
        super.init(nibName: nil, bundle: nil)
        title = Strings.FileViewerDetail.title
        followsTextSize()
        followColour()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        planTask?.cancel()
        colourTask?.cancel()
        mediaTask?.cancel()
        if media?.kind == .video { try? FileManager.default.removeItem(at: videoFolder) }
    }

    private var fileName: String { file.path.split(separator: "/").last.map(String.init) ?? file.path }

    override func loadView() {
        view = UIView()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        view.accessibilityIdentifier = "workspace-file"
        icon.fileName = fileName
        pathLabel.string = FileViewer.headerPath(file.path, line: file.lines?.lowerBound, column: nil)
        headerBorder.backgroundColor = UIColor(Palette.glassBorder)
        header.addSubview(icon)
        header.addSubview(pathLabel)
        header.addSubview(headerBorder)
        view.addSubview(lines)
        view.addSubview(header)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        minimalBackButton()
        navigationItem.largeTitleDisplayMode = .never
        registerForTraitChanges([UITraitHorizontalSizeClass.self] + UIView.textSizeTraits) { (self: Self, _) in
            self.view.setNeedsLayout()
        }
        if let media {
            lines.isHidden = true
            switch media.kind {
            case .image: showPicture(media.bytes)
            case .video: showVideo(media.bytes)
            }
        } else if content.isBinary {
            showBinary()
        }
    }

    private func showBinary() {
        let state = DetailMessageView(lead: nil, lines: [
            .init(text: Strings.FilesDetail.binaryFile, style: FileViewerTextStyles.stateTitle, color: Palette.textSecondary),
            .init(text: Strings.FilesDetail.cannotDisplayBinary, style: FileViewerTextStyles.body, color: Palette.textSecondary, spacingBefore: 8, centered: true),
            .init(text: fileName, style: FileViewerTextStyles.fileName, color: SecondaryPalette.fileName, spacingBefore: 8, centered: true),
        ], padding: 20)
        stateView = state
        header.isHidden = true
        lines.isHidden = true
        view.addSubview(state)
        view.setNeedsLayout()
    }

    /// The picture decoded off the main thread, at the long edge the
    /// conversation's viewer zooms into, then fitted in a page of its own.
    private func showPicture(_ bytes: Data) {
        let picture = Picture(key: file.path, thumbhash: nil, label: fileName)
        mediaTask = Task { [weak self] in
            let image = await Task.detached(priority: .userInitiated) { Images.decode(bytes, maxPixels: 4096) }.value
            guard let self, !Task.isCancelled else { return }
            guard let image else { return showBinary() }
            let source = FileImageSource(image: image)
            let page = PicturePage(source: source, picture: picture)
            page.isCurrent = true
            page.onTap = { [weak self] in
                self?.present(PictureViewController(source: source, pictures: [picture], index: 0), animated: true)
            }
            view.insertSubview(page, belowSubview: header)
            self.picture = page
            view.setNeedsLayout()
        }
    }

    /// The recording written where the player reads it, under its own
    /// name (its extension tells AVFoundation what it is), off the main
    /// thread.
    private func showVideo(_ bytes: Data) {
        let folder = videoFolder
        let url = folder.appendingPathComponent(fileName.isEmpty ? "video.mp4" : fileName)
        mediaTask = Task { [weak self] in
            let written = await Task.detached(priority: .userInitiated) {
                do {
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    try bytes.write(to: url)
                    return true
                } catch {
                    return false
                }
            }.value
            guard let self, !Task.isCancelled else { return }
            guard written else { return showBinary() }
            let playback = AVPlayerViewController()
            playback.player = AVPlayer(url: url)
            playback.view.backgroundColor = .clear
            playback.view.accessibilityIdentifier = "workspace-file-video"
            playback.view.accessibilityLabel = fileName
            playback.entersFullScreenWhenPlaybackBegins = false
            addChild(playback)
            view.insertSubview(playback.view, belowSubview: header)
            playback.didMove(toParent: self)
            self.playback = playback
            view.setNeedsLayout()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top
        stateView?.setLayoutFrame(CGRect(x: 0, y: top, width: view.bounds.width, height: max(0, view.bounds.height - top)))
        let layout = FileViewerLayout(.init(size: view.bounds.size, top: top, path: pathLabel.measurable, toggle: nil))
        header.frame = layout.header
        func local(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: -layout.header.minX, dy: -layout.header.minY) }
        icon.setLayoutFrame(local(layout.icon))
        pathLabel.setLayoutFrame(local(layout.path))
        headerBorder.setLayoutFrame(local(layout.headerBorder))
        lines.frame = layout.content
        picture?.safeArea = LayoutInsets(bottom: view.safeAreaInsets.bottom)
        picture?.frame = layout.content
        playback?.view.frame = layout.content
        updateBody()
    }

    /// layout.maxWidth: 800 off a phone, unlimited on one.
    private var maxWidth: CGFloat {
        traitCollection.horizontalSizeClass == .regular ? LegacyChatScreenLayout.Metrics.regularMaxContentWidth : .greatestFiniteMagnitude
    }

    /// The lines at this width and text size, planned off the main thread.
    private func updateBody(force: Bool = false) {
        guard stateView == nil, media == nil else { return }
        let width = lines.bounds.width
        guard width > 0 else { return }
        let maxWidth = maxWidth
        let text = lines.traitCollection.textEnvironment
        if content.content.isEmpty {
            lines.copyText = nil
            lines.show(message: Strings.FilesDetail.fileEmpty, maxWidth: maxWidth)
            return
        }
        if !force, let plan = lines.plan, plan.width == width, plan.maxWidth == maxWidth, plan.text == text { return }
        if !force, let planned, planned.width == width, planned.maxWidth == maxWidth, planned.text == text { return }
        planTask?.cancel()
        planned = (width, maxWidth, text)
        let source = FileLinesPlan.Source.code(content.content, language: FileViewer.language(file.path))
        let syntax = session.syntax
        planTask = Task { [weak self] in
            let plan = await Task.detached(priority: .userInitiated) {
                FileLinesPlan(source: source, width: width, maxWidth: maxWidth, syntax: syntax, text: text)
            }.value
            guard let self, !Task.isCancelled, !syntax.isClosed else { return }
            self.planned = nil
            self.show(plan)
        }
    }

    private func show(_ plan: FileLinesPlan) {
        lines.copyText = content.content
        lines.show(plan)
        guard scrollsToLine, let line = file.lines?.lowerBound else { return }
        scrollsToLine = false
        lines.layoutIfNeeded()
        let maxOffset = max(0, lines.contentSize.height - lines.bounds.height)
        lines.contentOffset = CGPoint(x: 0, y: min(maxOffset, FileViewer.scrollOffset(line: line)))
    }

    /// Colour that comes in after a plain plan draws it again.
    private func followColour() {
        let signals = session.syntax.completions()
        colourTask = Task { [weak self] in
            for await _ in signals {
                guard let self else { return }
                if self.lines.plan?.syntaxPending == true { self.updateBody(force: true) }
            }
        }
    }
}

/// A file's picture, already decoded, as the viewer's pages read one.
private final class FileImageSource: ChatMediaSource {
    private let shown: UIImage

    init(image: UIImage) { shown = image }

    func cachedImage(_ key: String, pixels: Int) -> UIImage? { shown }
    func image(_ key: String, pixels: Int) async -> UIImage? { shown }
}
#endif
