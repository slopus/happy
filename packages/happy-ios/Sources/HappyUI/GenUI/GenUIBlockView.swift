#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// Where a document's pictures come from: the files stored beside it.
protocol GenUIFiles: Sendable {
    /// The picture at `path`, relative to the document, decoded for display
    /// at no more than `pixels` on its longer side; nil when it can't be read.
    func image(_ path: String, pixels: Int) async -> UIImage?
}

extension GenUIFiles {
    /// Whether `path` can name one of the document's own files: never a URL,
    /// never out of its folder.
    static func isOwn(_ path: String) -> Bool {
        !path.isEmpty && URL(string: path)?.scheme == nil && !path.hasPrefix("/") && !path.split(separator: "/").contains("..")
    }
}

/// A document's files in a folder on this phone, such as the bundled fixtures.
struct GenUIFolderFiles: GenUIFiles {
    let folder: URL

    func image(_ path: String, pixels: Int) async -> UIImage? {
        guard Self.isOwn(path) else { return nil }
        let url = folder.appendingPathComponent(path)
        return await Task.detached(priority: .userInitiated) {
            (try? Data(contentsOf: url)).flatMap { Images.decode($0, maxPixels: pixels) }
        }.value
    }
}

/// What one shown document's taps do: report an action or an image viewer
/// to the host, and keep each single-choice group's answer. The answer is
/// this view's own; nothing is stored.
@MainActor
final class GenUIInteraction {
    var onAction: ((_ key: String, _ action: GenUIAction) -> Void)?
    var onViewer: ((_ key: String, _ group: String, _ index: Int) -> Void)?
    /// Each group's chosen element.
    private(set) var chosen: [String: String] = [:]
    private var choices: [String: GenUIChoiceNodes] = [:]

    nonisolated init() {}

    /// Another document: no answers yet.
    func reset() {
        chosen = [:]
        choices = [:]
    }

    /// The shown nodes' choices; a group already answered shows its answer.
    func adopt(_ choices: [String: GenUIChoiceNodes]) {
        self.choices = choices
        for (group, key) in chosen { show(group, chosen: key) }
    }

    /// An element was activated: report it, and if it's in a group, mark it
    /// and close the rest. A closed group reports nothing more.
    func activate(_ key: String, _ action: GenUIAction, group: String?) {
        if let group {
            guard chosen[group] == nil else { return }
            chosen[group] = key
            show(group, chosen: key)
        }
        onAction?(key, action)
    }

    private func show(_ group: String, chosen key: String) {
        for (member, choice) in choices where choice.group == group {
            let node = choice.node
            node.onPress = nil
            node.onPressIn = nil
            node.onPressOut = nil
            node.pressedOpacity = nil
            let isChosen = member == key
            switch choice.look {
            case .press(let ground):
                ground.updateStyle { $0.backgroundColor = isChosen ? Color(GenUITone.accent.fill) : nil }
                for child in node.children.dropFirst() { child.updateStyle { $0.opacity = isChosen ? 1 : 0.4 } }
            case .button:
                node.updateStyle { style in
                    if isChosen {
                        style.backgroundColor = Color(GenUITone.accent.fill)
                        style.borderColor = Color(GenUITone.accent.ink)
                    } else {
                        style.opacity = 0.4
                    }
                }
            }
            node.accessibility.role = isChosen ? .button : .none
            node.accessibility.hint = isChosen ? "Selected" : nil
        }
    }
}

/// A Gen UI document drawn by Ultraview at a planned width. The plan and
/// the nodes are made off the main thread (`load`, or `apply` with nodes a
/// caller built ahead); the main thread only hands them to the host and
/// applies Ultraview's commits. Its height is the plan's, known before
/// anything is drawn.
@MainActor
final class GenUIBlockView: UIView {
    let interaction = GenUIInteraction()
    /// The height of each document shown, once its plan is in.
    var onHeight: ((CGFloat) -> Void)?
    private(set) var built: GenUIBuilt?
    private var host: NodeHostView?
    private var snapping: [GenUICarouselSnap] = []
    private var loading: Task<Void, Never>?
    private var pictures: [Task<Void, Never>] = []
    /// The planner and width shown, or on their way, whose document it is,
    /// and what its elements may run.
    private var shown: (planner: GenUIPlanner, width: CGFloat, identity: String?, runs: GenUIRuns)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: GenUIBlockView, _) in view.redraw() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        loading?.cancel()
        pictures.forEach { $0.cancel() }
    }

    private var dark: Bool { traitCollection.userInterfaceStyle == .dark }

    /// Plans `document` at `width` and builds its nodes off the main thread,
    /// then shows them. A later call replaces an earlier one still on its way.
    func load(_ document: GenUIRenderDocument, width: CGFloat, traits: GenUITraits, files: (any GenUIFiles)?, runs: GenUIRuns) {
        show(GenUIPlanner(document: document, traits: traits), width: width, identity: shown?.identity, files: files, runs: runs)
    }

    /// Builds the nodes of `planner`'s plan at `width` off the main thread
    /// (a plan already made, as a conversation's row was sized by, is
    /// reused), then shows them; nothing when that is already shown. Another
    /// `identity`, another document, starts with no answers. Other `runs`
    /// draw the same plan with other elements enabled.
    func show(_ planner: GenUIPlanner, width: CGFloat, identity: String?, files: (any GenUIFiles)?, runs: GenUIRuns) {
        if let shown, shown.planner === planner, shown.width == width, shown.identity == identity, shown.runs == runs { return }
        if shown?.identity != identity { interaction.reset() }
        shown = (planner, width, identity, runs)
        loading?.cancel()
        let interaction = interaction
        let dark = dark
        loading = Task { [weak self] in
            let built = await Task.detached(priority: .userInitiated) {
                GenUINodeBuilder.build(planner.plan(width: width), interaction: interaction, dark: dark, runs: runs)
            }.value
            guard !Task.isCancelled else { return }
            self?.apply(built, files: files)
        }
    }

    /// Shows nodes built off the main thread.
    func apply(_ built: GenUIBuilt, files: (any GenUIFiles)?) {
        self.built = built
        pictures.forEach { $0.cancel() }
        host?.removeFromSuperview()
        let host = NodeHostView(rootNode: built.root)
        // A carousel runs out past the block into the margins it was given.
        host.clipsToBounds = false
        host.onCommit = { [weak self] in self?.attachSnapping() }
        addSubview(host)
        self.host = host
        snapping = []
        interaction.adopt(built.choices)
        // Built for the appearance of its time; catch up with this one.
        if built.dark != dark { redraw() }
        let scale = traitCollection.displayScale
        pictures = built.images.map { node, file, side in
            let pixels = Int((side * scale).rounded(.up))
            return Task.detached(priority: .utility) {
                guard let image = await files?.image(file, pixels: pixels), !Task.isCancelled else { return }
                node.drawing = GenUIPictureDrawing(image: image)
            }
        }
        setNeedsLayout()
        onHeight?(built.plan.size.height)
    }

    /// Redraws what follows light and dark; Ultraview draws it off the main thread.
    private func redraw() {
        guard let built else { return }
        let dark = dark
        for (node, make) in built.drawn { node.drawing = make(dark) }
    }

    /// Carousels settle on a card once their scroll views exist.
    private func attachSnapping() {
        guard let built, snapping.count < built.snaps.count else { return }
        for (node, stops) in built.snaps {
            guard let scroll = node.view as? UIScrollView, !snapping.contains(where: { $0.scroll === scroll }) else { continue }
            snapping.append(GenUICarouselSnap(scroll: scroll, stops: stops))
        }
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: built?.plan.size.height ?? 0)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let built else { return }
        host?.frame = CGRect(origin: .zero, size: built.plan.size)
    }
}

/// A carousel settling one card at a time: when a swipe ends it goes to
/// the next card in the swipe's direction (`GenUICarouselLayout.stop`).
/// Ultraview's scroll node has no snapping of its own, so this follows its
/// scroll view's pan.
@MainActor
final class GenUICarouselSnap: NSObject {
    weak var scroll: UIScrollView?
    private let stops: [CGFloat]
    private var start: CGFloat = 0

    init(scroll: UIScrollView, stops: [CGFloat]) {
        self.scroll = scroll
        self.stops = stops
        super.init()
        scroll.decelerationRate = .fast
        scroll.panGestureRecognizer.addTarget(self, action: #selector(panned(_:)))
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        guard let scroll else { return }
        switch pan.state {
        case .began:
            start = scroll.contentOffset.x
        case .ended, .cancelled:
            // Points per millisecond, positive as the content moves left.
            let velocity = -pan.velocity(in: scroll).x / 1000
            let stop = GenUICarouselLayout.stop(in: stops, proposed: scroll.contentOffset.x, velocity: velocity, current: start)
            scroll.setContentOffset(CGPoint(x: stop, y: scroll.contentOffset.y), animated: true)
        default:
            break
        }
    }
}
#endif
