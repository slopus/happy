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

/// What was done to one version of a Gen UI: each single-choice group's
/// answer and the secret each secret element's form saved. One per version
/// per computer client (`of`), shared by every view that shows it, the
/// chat's card and the artifact page alike, so what is done in one shows
/// in the others. Kept on this phone only, for as long as its client
/// lives; nothing is sent.
@MainActor
final class GenUIAnswers {
    /// Each group's chosen element.
    private(set) var chosen: [String: String] = [:]
    /// The secret each secret element's form saved, by the element's key:
    /// the name its form opens on when tapped again.
    private(set) var saved: [String: String] = [:]
    private let shown = NSHashTable<GenUIInteraction>.weakObjects()

    nonisolated init() {}

    /// The first answer `group` takes; every view showing it marks it.
    func choose(_ group: String, key: String) {
        guard chosen[group] == nil else { return }
        chosen[group] = key
        for interaction in shown.allObjects { interaction.show(group, chosen: key) }
    }

    /// `key`'s form saved the secret `id`; every view showing it marks it.
    func save(_ key: String, secret id: String) {
        saved[key] = id
        for interaction in shown.allObjects { interaction.showSaved(key) }
    }

    fileprivate func watch(_ interaction: GenUIInteraction) { shown.add(interaction) }
    fileprivate func unwatch(_ interaction: GenUIInteraction) { shown.remove(interaction) }

    /// Each client's versions, the latest `limit`, for as long as it lives.
    private static let clients = NSMapTable<AnyObject, Versions>.weakToStrongObjects()
    static let limit = 64

    private final class Versions {
        var answers: [String: GenUIAnswers] = [:]
        var order: [String] = []
    }

    /// `artifactId`'s `version` on `client`: the same answers wherever it
    /// shows. A version never changes, so they are kept while it is among
    /// the client's latest `limit`.
    static func of(_ client: AnyObject, artifactId: String, version: Int) -> GenUIAnswers {
        let key = "\(artifactId)/\(version)"
        let versions = clients.object(forKey: client) ?? {
            let versions = Versions()
            clients.setObject(versions, forKey: client)
            return versions
        }()
        versions.order.removeAll { $0 == key }
        versions.order.append(key)
        if let answers = versions.answers[key] { return answers }
        let answers = GenUIAnswers()
        versions.answers[key] = answers
        if versions.order.count > limit { versions.answers[versions.order.removeFirst()] = nil }
        return answers
    }
}

/// What one shown document's taps do: report an action or an image viewer
/// to the host, and mark its version's answers (`GenUIAnswers`): a group's
/// choice, a saved secret. Until it is given its version's shared answers
/// (`use`) it keeps its own.
@MainActor
final class GenUIInteraction {
    var onAction: ((_ key: String, _ action: GenUIAction) -> Void)?
    var onViewer: ((_ key: String, _ group: String, _ index: Int) -> Void)?
    /// Draws the document's glyphs again, a saved one's check among them.
    var redraw: (() -> Void)?
    private(set) var answers = GenUIAnswers()
    private var choices: [String: GenUIChoiceNodes] = [:]
    private var secrets: [String: GenUIChoiceNodes] = [:]

    /// Each group's chosen element.
    var chosen: [String: String] { answers.chosen }
    /// The secret each secret element's form saved, by the element's key.
    var saved: [String: String] { answers.saved }

    nonisolated init() {}

    /// Another document: no answers yet, its own until it is given its version's.
    func reset() {
        answers.unwatch(self)
        answers = GenUIAnswers()
        choices = [:]
        secrets = [:]
    }

    /// Its version's shared answers: what was done before it was given
    /// them is kept in them, and what they hold shows.
    func use(_ shared: GenUIAnswers) {
        guard shared !== answers else { return }
        let own = answers
        own.unwatch(self)
        answers = shared
        shared.watch(self)
        for (group, key) in own.chosen { shared.choose(group, key: key) }
        for (key, id) in own.saved where shared.saved[key] == nil { shared.save(key, secret: id) }
        showAll()
    }

    /// The shown nodes' choices and secret elements; a group already
    /// answered shows its answer, a form that saved its mark.
    func adopt(_ choices: [String: GenUIChoiceNodes], secrets: [String: GenUIChoiceNodes] = [:]) {
        self.choices = choices
        self.secrets = secrets
        answers.watch(self)
        showAll()
    }

    private func showAll() {
        for (group, key) in chosen { show(group, chosen: key) }
        for key in saved.keys { showSaved(key) }
    }

    /// `key`'s form saved the secret `id`: the element is marked, and still
    /// opens the form, on that secret; so is it wherever its version shows.
    func save(_ key: String, secret id: String) {
        answers.save(key, secret: id)
    }

    /// A saved secret button keeps its label and colours, its leading
    /// glyph a check; a pressable row that opens a form takes the accent's
    /// soft ground. VoiceOver hears "Saved" on either.
    fileprivate func showSaved(_ key: String) {
        guard let mark = secrets[key] else { return }
        switch mark.look {
        case .press(let ground):
            let fill = Color(GenUITone.accent.fill)
            ground.updateStyle { $0.backgroundColor = fill }
            mark.node.onPressOut = { ground.updateStyle { $0.backgroundColor = fill } }
        case .button(let saved):
            if let saved, !saved.isSaved {
                saved.isSaved = true
                redraw?()
            }
        }
        mark.node.accessibility.hint = Strings.GenUI.saved
    }

    /// An element was activated: report it, and if it's in a group, mark it
    /// and close the rest. A closed group reports nothing more.
    func activate(_ key: String, _ action: GenUIAction, group: String?) {
        if let group {
            guard chosen[group] == nil else { return }
            answers.choose(group, key: key)
        }
        onAction?(key, action)
    }

    fileprivate func show(_ group: String, chosen key: String) {
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
            node.accessibility.hint = isChosen ? Strings.GenUI.selected : nil
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
    /// Whose document it shows, as `show` was told.
    var identity: String? { shown?.identity }
    /// The version a conversation shows in it (`apply(_: GenUIEmbed)`).
    var conversationVersion: (artifactId: String, version: Int)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: GenUIBlockView, _) in view.redraw() }
        interaction.redraw = { [weak self] in self?.redraw() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // A conversation's card, put in the conversation after it was given its version.
        if window != nil { sharesAnswers() }
    }

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
        let words = GenUIWords.current
        loading = Task { [weak self] in
            let built = await Task.detached(priority: .userInitiated) {
                GenUINodeBuilder.build(planner.plan(width: width), interaction: interaction, dark: dark, runs: runs, words: words)
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
        interaction.adopt(built.choices, secrets: built.secrets)
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
