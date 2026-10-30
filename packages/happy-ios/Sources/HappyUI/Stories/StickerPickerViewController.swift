#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What the picker hands back: a sticker from a pack, a system emoji, or
/// one of the interactive stickers over them (a link, a reaction bubble),
/// which the editor asks more of.
enum StickerPick: Equatable {
    case sticker(Sticker)
    case emoji(String)
    case link
    case reaction
}

/// The story editor's sticker picker, drawn as happy-agent's API.md "The
/// picker" says and Telegram's sticker panel looks: a search field and
/// emoji chips, then one scroll of the interactive stickers (LINK and the
/// reaction bubble), Recently used (with its ✕) and every pack under its
/// centred uppercase title, and a floating switch between Stickers and Emoji. Tapping hands the pick back; holding shows it large.
final class StickerPickerViewController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegate, UITextFieldDelegate {
    enum Mode {
        /// Stickers and emoji, for a sticker or emoji overlay.
        case all
        /// The Emoji tab's system emoji alone, for a reaction bubble.
        case emojiOnly
    }

    enum Tab { case stickers, emoji }

    private struct Section {
        var title: String?
        var kind: StickerPackKindLayout
        var items: [StickerPick]
        var clears = false
    }

    var onPick: ((StickerPick) -> Void)?
    private let session: StoriesSession
    private let mode: Mode
    private var shownTab: Tab
    private let search = UISearchTextField()
    private let chips = UIScrollView()
    private let grid = StickerPickerCollectionLayout()
    private lazy var collection = UICollectionView(frame: .zero, collectionViewLayout: grid)
    private let switcher = UIView()
    private let switchButtons = [UIButton(type: .system), UIButton(type: .system)]
    private let empty = UILabel()
    private let pills = UIView()
    private let linkPill = UIButton(type: .custom)
    private let reactionPill = UIButton(type: .custom)
    private let preview = StoryStickerContentView()
    private let previewDim = UIView()
    private var packs: [StickerPackContents] = []
    private var recents: [StickerRef] = []
    private var results: [Sticker]?
    private var sections: [Section] = []
    private var watch: Watch?
    private var loading: Task<Void, Never>?
    private var searching: Task<Void, Never>?
    /// The keyboard's top, in this view, while it is up.
    private var keyboardTop: CGFloat?

    init(session: StoriesSession, mode: Mode) {
        self.session = session
        self.mode = mode
        shownTab = mode == .emojiOnly ? .emoji : .stickers
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        loading?.cancel()
        searching?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = UIColor(Palette.storiesStickerSheet)
        view.accessibilityIdentifier = "sticker-picker"
        search.placeholder = Strings.Stories.search
        search.accessibilityIdentifier = "sticker-search"
        search.returnKeyType = .search
        search.delegate = self
        search.addTarget(self, action: #selector(searchChanged), for: .editingChanged)
        search.isHidden = mode == .emojiOnly
        view.addSubview(search)
        chips.showsHorizontalScrollIndicator = false
        chips.isHidden = mode == .emojiOnly
        for emoji in StoryEmojiCatalog.chips {
            let chip = UIButton(type: .system)
            chip.setTitle(emoji, for: .normal)
            chip.titleLabel?.font = .systemFont(ofSize: 22)
            chip.backgroundColor = UIColor(white: 1, alpha: 0.08)
            chip.layer.cornerRadius = 17
            chip.accessibilityIdentifier = "sticker-chip:\(emoji)"
            chip.addAction(UIAction { [weak self] _ in self?.chip(emoji) }, for: .touchUpInside)
            chips.addSubview(chip)
        }
        view.addSubview(chips)
        collection.backgroundColor = .clear
        collection.dataSource = self
        collection.delegate = self
        collection.keyboardDismissMode = .onDrag
        collection.register(StickerPickerCell.self, forCellWithReuseIdentifier: StickerPickerCell.reuse)
        collection.register(StickerPickerHeader.self, forSupplementaryViewOfKind: StickerPickerCollectionLayout.header, withReuseIdentifier: StickerPickerHeader.reuse)
        collection.accessibilityIdentifier = "sticker-grid"
        collection.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(held(_:))))
        view.addSubview(collection)
        makePills()
        empty.text = Strings.Stories.noResults
        empty.textColor = UIColor(white: 1, alpha: 0.5)
        empty.textAlignment = .center
        empty.isHidden = true
        view.addSubview(empty)
        // The floating switch.
        switcher.backgroundColor = UIColor(white: 0.2, alpha: 0.95)
        switcher.layer.cornerRadius = 18
        switcher.isHidden = mode == .emojiOnly
        for (button, (title, id, value)) in zip(switchButtons, [(Strings.Stories.stickers, "sticker-tab-stickers", Tab.stickers), (Strings.Stories.emoji, "sticker-tab-emoji", Tab.emoji)]) {
            button.setTitle(title, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
            button.layer.cornerRadius = 15
            button.accessibilityIdentifier = id
            button.addAction(UIAction { [weak self] _ in self?.select(value) }, for: .touchUpInside)
            switcher.addSubview(button)
        }
        view.addSubview(switcher)
        previewDim.backgroundColor = UIColor(white: 0, alpha: 0.6)
        previewDim.isHidden = true
        previewDim.isUserInteractionEnabled = false
        previewDim.addSubview(preview)
        view.addSubview(previewDim)
        watch = session.watch { [weak self] snapshot in
            guard let self, snapshot.recents != recents else { return }
            recents = snapshot.recents
            rebuild()
        }
        // The reaction's emoji are the system's alone; no packs to read.
        if mode == .all { load() }
        rebuild()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    /// The switch floats over the keyboard while it is up.
    @objc private func keyboardChanged(_ note: Notification) {
        guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let top = view.convert(end, from: nil).minY
        keyboardTop = note.name == UIResponder.keyboardWillHideNotification || top >= view.bounds.maxY ? nil : top
        view.setNeedsLayout()
        UIView.animate(withDuration: 0.25) { self.view.layoutIfNeeded() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let safe = view.safeAreaInsets
        var y: CGFloat = 12
        if mode == .all {
            search.frame = CGRect(x: 12, y: y, width: bounds.width - 24, height: 36)
            y = search.frame.maxY + 8
            var x: CGFloat = 0
            for chip in chips.subviews.compactMap({ $0 as? UIButton }) {
                chip.frame = CGRect(x: x, y: 0, width: 44, height: 34)
                x += 44 + 6
            }
            chips.frame = CGRect(x: 12, y: y, width: bounds.width - 24, height: 34)
            chips.contentSize = CGSize(width: max(0, x - 6), height: 34)
            y = chips.frame.maxY + 8
        }
        collection.frame = CGRect(x: 0, y: y, width: bounds.width, height: bounds.height - y)
        collection.contentInset.bottom = safe.bottom
        layoutPills(width: bounds.width)
        empty.frame = CGRect(x: 16, y: y + 40, width: bounds.width - 32, height: 24)
        let switchSize = CGSize(width: 200, height: 36)
        let floor = min(bounds.height - safe.bottom, keyboardTop ?? .greatestFiniteMagnitude)
        switcher.frame = CGRect(x: (bounds.width - switchSize.width) / 2, y: floor - 12 - switchSize.height, width: switchSize.width, height: switchSize.height)
        for (index, button) in switchButtons.enumerated() {
            button.frame = CGRect(x: 3 + CGFloat(index) * 97, y: 3, width: 97, height: 30)
        }
        previewDim.frame = bounds
        let side = min(bounds.width * 0.7, 300)
        preview.frame = CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2 - 40, width: side, height: side)
        styleSwitch()
    }

    // MARK: Data

    private func load() {
        let client = session.client
        let media = session.media
        loading = Task { [weak self] in
            guard let list = try? await client.stickerPacks() else { return }
            let contents = await withTaskGroup(of: (Int, StickerPackContents?).self) { group in
                for (index, pack) in list.enumerated() {
                    group.addTask { (index, try? await client.stickerPack(pack.id)) }
                }
                var read: [Int: StickerPackContents] = [:]
                for await (index, pack) in group { read[index] = pack }
                return list.indices.compactMap { read[$0] }
            }
            guard let self, !Task.isCancelled else { return }
            for pack in contents { media.remember(pack) }
            // The app ships no VP9 decoder: webm stickers are left out.
            packs = contents.map { pack in
                var pack = pack
                pack.stickers.removeAll { $0.format == .webm }
                return pack
            }.filter { !$0.stickers.isEmpty }
            rebuild()
        }
    }

    private func rebuild() {
        var next: [Section] = []
        if let results {
            next.append(Section(title: nil, kind: shownTab == .stickers ? .stickers : .emoji, items: results.map(StickerPick.sticker)))
        } else if shownTab == .stickers {
            let known = Dictionary(packs.flatMap(\.stickers).map { ($0.ref, $0) }, uniquingKeysWith: { first, _ in first })
            // A recent sticker whose pack is gone is left out.
            let recent = recents.compactMap { known[$0] }
            if !recent.isEmpty { next.append(Section(title: Strings.Stories.recentlyUsed, kind: .stickers, items: recent.map(StickerPick.sticker), clears: true)) }
            for pack in packs where pack.pack.kind == .stickers {
                next.append(Section(title: pack.pack.title, kind: .stickers, items: pack.stickers.map(StickerPick.sticker)))
            }
        } else {
            for category in StoryEmojiCatalog.categories {
                next.append(Section(title: category.name, kind: .emoji, items: category.emoji.map(StickerPick.emoji)))
            }
            if mode == .all {
                for pack in packs where pack.pack.kind == .emoji {
                    next.append(Section(title: pack.pack.title, kind: .emoji, items: pack.stickers.map(StickerPick.sticker)))
                }
            }
        }
        sections = next
        grid.sections = next.map { StickerPickerLayout.Section(kind: $0.kind, count: $0.items.count, header: $0.title != nil) }
        grid.clears = Set(next.indices.filter { next[$0].clears })
        empty.isHidden = !(results?.isEmpty ?? false)
        collection.reloadData()
        view.setNeedsLayout()
    }

    // MARK: Interactive stickers

    /// Telegram's pills over the stickers: LINK, and the white reaction bubble with a heart.
    private func makePills() {
        linkPill.backgroundColor = UIColor(Palette.storiesStickerPill)
        linkPill.layer.cornerRadius = 6
        linkPill.layer.cornerCurve = .continuous
        linkPill.setImage(StoryEditorIcons.link, for: .normal)
        linkPill.setAttributedTitle(NSAttributedString(string: Strings.Stories.link.uppercased(), attributes: [.font: Self.pillFont, .foregroundColor: UIColor.white]), for: .normal)
        linkPill.contentHorizontalAlignment = .left
        linkPill.accessibilityIdentifier = "sticker-link"
        linkPill.accessibilityLabel = Strings.Stories.link
        linkPill.addAction(UIAction { [weak self] _ in self?.onPick?(.link) }, for: .touchUpInside)
        pills.addSubview(linkPill)
        reactionPill.setImage(StoryEditorIcons.reactionBubble, for: .normal)
        let heart = UILabel()
        heart.text = Strings.Stories.heart
        heart.font = .systemFont(ofSize: 26)
        heart.textAlignment = .center
        heart.isUserInteractionEnabled = false
        heart.frame = CGRect(x: 5, y: 3, width: 44, height: 44)
        reactionPill.addSubview(heart)
        reactionPill.accessibilityIdentifier = "sticker-reaction"
        reactionPill.accessibilityLabel = Strings.Stories.reaction
        reactionPill.addAction(UIAction { [weak self] _ in self?.onPick?(.reaction) }, for: .touchUpInside)
        pills.addSubview(reactionPill)
        collection.addSubview(pills)
    }

    /// Telegram sets them in its condensed camera face; the system's condensed bold stands in.
    private static let pillFont = UIFont.systemFont(ofSize: 22, weight: .semibold, width: .condensed)

    /// Over the stickers, in the scroll, while nothing is searched.
    private func layoutPills(width: CGFloat) {
        let shown = mode == .all && shownTab == .stickers && results == nil
        pills.isHidden = !shown
        guard shown else {
            if collection.contentInset.top != 0 { collection.contentInset.top = 0 }
            return
        }
        let title = (Strings.Stories.link.uppercased() as NSString).size(withAttributes: [.font: Self.pillFont]).width
        let r = StoryStickerPillsLayout.Metrics.reaction
        let placed = StoryStickerPillsLayout(width: width, sizes: [StoryStickerPillsLayout.pill(title: title), CGSize(width: r, height: r)])
        linkPill.frame = placed.items[0]
        linkPill.imageEdgeInsets = UIEdgeInsets(top: 0, left: StoryStickerPillsLayout.Metrics.pillPadding, bottom: 0, right: 0)
        linkPill.titleEdgeInsets = UIEdgeInsets(top: 0, left: StoryStickerPillsLayout.Metrics.pillPadding + StoryStickerPillsLayout.Metrics.pillGap, bottom: 0, right: 0)
        reactionPill.frame = placed.items[1]
        pills.frame = CGRect(x: 0, y: -placed.height, width: width, height: placed.height)
        if collection.contentInset.top != placed.height {
            collection.contentInset.top = placed.height
            collection.setContentOffset(CGPoint(x: 0, y: -collection.adjustedContentInset.top), animated: false)
        }
    }

    private func select(_ next: Tab) {
        guard next != shownTab else { return }
        shownTab = next
        if results != nil { runSearch() }
        rebuild()
        collection.setContentOffset(CGPoint(x: 0, y: -collection.adjustedContentInset.top), animated: false)
        styleSwitch()
    }

    private func styleSwitch() {
        for (index, button) in switchButtons.enumerated() {
            let on = (index == 0) == (shownTab == .stickers)
            button.backgroundColor = on ? UIColor(white: 1, alpha: 0.18) : .clear
            button.setTitleColor(on ? .white : UIColor(white: 1, alpha: 0.6), for: .normal)
            button.accessibilityTraits = on ? [.button, .selected] : .button
        }
    }

    // MARK: Search

    @objc private func searchChanged() { runSearch() }

    private func chip(_ emoji: String) {
        search.text = emoji
        runSearch()
    }

    /// Searching grows the sheet, so the results show over the keyboard.
    func textFieldDidBeginEditing(_ textField: UITextField) {
        guard let sheet = sheetPresentationController, sheet.selectedDetentIdentifier != .large else { return }
        sheet.animateChanges { sheet.selectedDetentIdentifier = .large }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    private func runSearch() {
        searching?.cancel()
        let text = (search.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            results = nil
            rebuild()
            return
        }
        let client = session.client
        let kind: StickerPackKind = shownTab == .stickers ? .stickers : .emoji
        // One emoji: drawn as emoji by default, or asked to be (❤️ is ❤ and U+FE0F).
        let first = text.unicodeScalars.first?.properties
        let isEmoji = text.count == 1 && (first?.isEmojiPresentation == true || (first?.isEmoji == true && text.unicodeScalars.count > 1))
        searching = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let found = (try? await client.searchStickers(query: isEmoji ? nil : String(text.prefix(64)), emoji: isEmoji ? text : nil, kind: kind)) ?? []
            guard let self, !Task.isCancelled else { return }
            results = found.filter { $0.format != .webm }
            rebuild()
        }
    }

    // MARK: Collection

    func numberOfSections(in collectionView: UICollectionView) -> Int { sections.count }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { sections[section].items.count }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: StickerPickerCell.reuse, for: indexPath) as! StickerPickerCell
        cell.show(sections[indexPath.section].items[indexPath.item], media: session.media)
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, viewForSupplementaryElementOfKind kind: String, at indexPath: IndexPath) -> UICollectionReusableView {
        let header = collectionView.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: StickerPickerHeader.reuse, for: indexPath) as! StickerPickerHeader
        let section = sections[indexPath.section]
        header.show(section.title ?? "", clears: section.clears)
        header.onClear = { [weak self] in self?.clearRecents() }
        return header
    }

    // Animated stickers play only while visible.
    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        (cell as? StickerPickerCell)?.content.visible = true
    }

    func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        (cell as? StickerPickerCell)?.content.visible = false
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        let pick = sections[indexPath.section].items[indexPath.item]
        if case .sticker(let sticker) = pick {
            let store = session.store
            Task { await store.useSticker(sticker.ref) }
        }
        onPick?(pick)
    }

    private func clearRecents() {
        let store = session.store
        Task { await store.clearRecents() }
    }

    @objc private func held(_ press: UILongPressGestureRecognizer) {
        switch press.state {
        case .began:
            guard let path = collection.indexPathForItem(at: press.location(in: collection)),
                  case .sticker(let sticker) = sections[path.section].items[path.item] else { return }
            preview.show(sticker, media: session.media)
            preview.visible = true
            previewDim.isHidden = false
            previewDim.alpha = 0
            UIView.animate(withDuration: 0.15) { self.previewDim.alpha = 1 }
        case .ended, .cancelled, .failed:
            preview.visible = false
            UIView.animate(withDuration: 0.15) { self.previewDim.alpha = 0 } completion: { finished in
                // A new hold that began during the fade keeps it.
                if finished, self.previewDim.alpha == 0 { self.previewDim.isHidden = true }
            }
        default:
            break
        }
    }
}

/// The picker's grid, placed by `StickerPickerLayout`.
final class StickerPickerCollectionLayout: UICollectionViewLayout {
    static let header = "sticker-header"
    var sections: [StickerPickerLayout.Section] = [] { didSet { invalidateLayout() } }
    var clears: Set<Int> = [] { didSet { invalidateLayout() } }
    private var placed: StickerPickerLayout?

    override func prepare() {
        super.prepare()
        placed = StickerPickerLayout(width: collectionView?.bounds.width ?? 0, sections: sections, clears: clears)
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: collectionView?.bounds.width ?? 0, height: placed?.height ?? 0)
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.width != collectionView?.bounds.width
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard let placed else { return nil }
        var all: [UICollectionViewLayoutAttributes] = []
        for (section, value) in placed.sections.enumerated() {
            if let header = value.header, header.intersects(rect) {
                let attributes = UICollectionViewLayoutAttributes(forSupplementaryViewOfKind: Self.header, with: IndexPath(item: 0, section: section))
                attributes.frame = header
                all.append(attributes)
            }
            for (item, frame) in value.cells.enumerated() where frame.intersects(rect) {
                let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: item, section: section))
                attributes.frame = frame
                all.append(attributes)
            }
        }
        return all
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard let cells = placed?.sections[safe: indexPath.section]?.cells, cells.indices.contains(indexPath.item) else { return nil }
        let attributes = UICollectionViewLayoutAttributes(forCellWith: indexPath)
        attributes.frame = cells[indexPath.item]
        return attributes
    }

    override func layoutAttributesForSupplementaryView(ofKind elementKind: String, at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard let header = placed?.sections[safe: indexPath.section]?.header else { return nil }
        let attributes = UICollectionViewLayoutAttributes(forSupplementaryViewOfKind: elementKind, with: indexPath)
        attributes.frame = header
        return attributes
    }
}

/// A pack's (or Recently used's) centred uppercase title, with the ✕.
final class StickerPickerHeader: UICollectionReusableView {
    static let reuse = "header"
    var onClear: (() -> Void)?
    private let label = UILabel()
    private let clear = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = UIColor(white: 1, alpha: 0.5)
        label.textAlignment = .center
        addSubview(label)
        clear.setImage(UIImage.icon(.ionicons("close"), size: 16).withRenderingMode(.alwaysTemplate), for: .normal)
        clear.tintColor = UIColor(white: 1, alpha: 0.5)
        clear.accessibilityIdentifier = "sticker-recents-clear"
        clear.accessibilityLabel = Strings.Stories.clearRecents
        clear.addAction(UIAction { [weak self] _ in self?.onClear?() }, for: .touchUpInside)
        addSubview(clear)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ title: String, clears: Bool) {
        label.text = title.uppercased()
        accessibilityIdentifier = "sticker-header:\(title)"
        clear.isHidden = !clears
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = bounds.insetBy(dx: StickerPickerLayout.Metrics.clear, dy: 0)
        clear.frame = CGRect(x: bounds.width - StickerPickerLayout.Metrics.clear, y: 0, width: StickerPickerLayout.Metrics.clear, height: bounds.height)
    }
}

/// One sticker, fitted in its square, or one emoji.
final class StickerPickerCell: UICollectionViewCell {
    static let reuse = "sticker"
    let content = StoryStickerContentView()
    private let emoji = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        content.isUserInteractionEnabled = false
        contentView.addSubview(content)
        emoji.textAlignment = .center
        contentView.addSubview(emoji)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ pick: StickerPick, media: StoriesMedia) {
        switch pick {
        case .sticker(let sticker):
            emoji.isHidden = true
            content.isHidden = false
            content.visible = true
            content.show(sticker, media: media)
            accessibilityIdentifier = "sticker:\(sticker.packId)/\(sticker.id)"
            accessibilityLabel = sticker.emoji.first
        case .emoji(let value):
            // A cell that showed an animated sticker stops it.
            content.visible = false
            content.isHidden = true
            emoji.isHidden = false
            emoji.text = value
            accessibilityIdentifier = "emoji:\(value)"
            accessibilityLabel = value
        case .link, .reaction:
            break
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        content.frame = contentView.bounds.insetBy(dx: 2, dy: 2)
        emoji.frame = contentView.bounds
        emoji.font = .systemFont(ofSize: contentView.bounds.height * 0.72)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
#endif
