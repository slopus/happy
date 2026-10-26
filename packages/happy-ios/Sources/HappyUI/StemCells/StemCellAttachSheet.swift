#if canImport(UIKit)
import HappyIcons
import HappyLayout
import Photos
import UIKit

/// The composer's "+" sheet, after Claude's "Add to session": a glass close
/// circle, the title, and Photos (the whole library) at the right; a strip
/// of the camera and the newest photos, picked in order with numbered
/// checks, Photos turning into "Add N" while any are; then Paste from
/// clipboard, Add files, and the permission the next message runs with.
///
/// It only says what was chosen: the sheet goes first, then `onAction`
/// hears it, except for the permission, picked in a menu over the sheet,
/// which stays with the value updated by whoever presents it.
@MainActor
final class StemCellAttachSheetViewController: UIViewController {
    enum Action: Equatable {
        case photos
        case camera
        /// Photos picked in the strip, by `PHAsset.localIdentifier`, in order.
        case add([String])
        case paste
        case files
        case permission
    }

    var onAction: ((Action) -> Void)?
    /// The permission row's value: the mode's name.
    var permission: String {
        didSet { if permission != oldValue { rows[2].value.text = permission; view.setNeedsLayout() } }
    }
    /// The permission row's menu, as the composer's model control opens
    /// its own; nil until the models are read, the row dimmed meanwhile.
    var permissionMenu: UIMenu? {
        get { rows[2].menu }
        set {
            rows[2].menu = newValue
            rows[2].alpha = newValue == nil ? 0.5 : 1
        }
    }

    private let limit: Int
    /// Going because something was chosen.
    private var chose = false
    private let closeGlass = StemCellChatHeaderView.glass()
    private let closeButton = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let photosButton = UIButton(type: .system)
    private let strip = UIScrollView()
    private let camera = StemCellAttachTile()
    private var tiles: [StemCellAttachTile] = []
    private var assets: [PHAsset] = []
    private var picked: [String] = []
    private let group = UIView()
    private let rows: [StemCellAttachRow]
    private let thumbnails = PHCachingImageManager()

    init(limit: Int, permission: String) {
        self.limit = limit
        self.permission = permission
        rows = [
            StemCellAttachRow(icon: .ionicons("copy-outline"), title: Strings.StemCells.pasteFromClipboard, id: "attach-paste", value: nil),
            StemCellAttachRow(icon: .ionicons("document-outline"), title: Strings.StemCells.addFiles, id: "attach-files", value: nil),
            StemCellAttachRow(icon: .ionicons("shield-checkmark-outline"), title: Strings.StemCells.permission, id: "attach-permission", value: permission),
        ]
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            let height = Self.layout(width: 0, title: 0, photos: 0, tiles: 1).height
            sheet.detents = [.custom(identifier: .init("attach")) { _ in height }]
            sheet.prefersGrabberVisible = true
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private static func layout(width: CGFloat, title: CGFloat, photos: CGFloat, tiles: Int, values: [CGFloat?] = [nil, nil, 0], scale: CGFloat = 3) -> StemCellAttachSheetLayout {
        StemCellAttachSheetLayout(width: width, titleWidth: title, photosWidth: photos, tiles: tiles, values: values, scale: scale)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.stemCellsAttachGround)
        view.accessibilityIdentifier = "attach-sheet"

        closeButton.setImage(.icon(.ionicons("close"), size: 24), for: .normal)
        closeButton.tintColor = UIColor(Palette.headerTint)
        closeButton.accessibilityLabel = Strings.StemCells.close
        closeButton.accessibilityIdentifier = "attach-close"
        closeButton.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)
        closeGlass.cornerConfiguration = .capsule()
        closeGlass.contentView.addSubview(closeButton)
        view.addSubview(closeGlass)

        titleLabel.text = Strings.StemCells.addToMessage
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = UIColor(Palette.text)
        titleLabel.textAlignment = .center
        titleLabel.accessibilityTraits = .header
        view.addSubview(titleLabel)

        photosButton.titleLabel?.font = .systemFont(ofSize: 17)
        photosButton.tintColor = UIColor(Palette.headerTint)
        photosButton.accessibilityIdentifier = "attach-photos"
        photosButton.addAction(UIAction { [weak self] _ in self?.photosTapped() }, for: .touchUpInside)
        view.addSubview(photosButton)
        updatePhotos()

        strip.showsHorizontalScrollIndicator = false
        strip.alwaysBounceHorizontal = true
        strip.clipsToBounds = false
        strip.accessibilityIdentifier = "attach-strip"
        view.addSubview(strip)
        camera.showCamera(available: UIImagePickerController.isSourceTypeAvailable(.camera))
        camera.addAction(UIAction { [weak self] _ in self?.finish(.camera) }, for: .touchUpInside)
        strip.addSubview(camera)

        group.backgroundColor = UIColor(Palette.stemCellsAttachFill)
        group.layer.cornerRadius = StemCellAttachSheetLayout.Metrics.groupRadius
        group.layer.cornerCurve = .continuous
        group.clipsToBounds = true
        view.addSubview(group)
        for (index, row) in rows.enumerated() {
            group.addSubview(row)
            row.addAction(UIAction { [weak self] _ in
                self?.rowTapped(index)
            }, for: .touchUpInside)
        }
        loadPhotos()
    }

    // MARK: Photos

    private func loadPhotos() {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized, .limited:
            fetch()
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { @Sendable status in
                guard status == .authorized || status == .limited else { return }
                DispatchQueue.main.async { [weak self] in self?.fetch() }
            }
        default:
            break
        }
    }

    /// The newest photos, as many as the strip is worth scrolling through.
    private func fetch() {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        options.fetchLimit = 30
        Task.detached(priority: .userInitiated) {
            let found = PHAsset.fetchAssets(with: options)
            nonisolated(unsafe) let assets = (0..<found.count).map { found.object(at: $0) }
            await MainActor.run { [weak self] in self?.show(assets) }
        }
    }

    private func show(_ assets: [PHAsset]) {
        self.assets = assets
        tiles.forEach { $0.removeFromSuperview() }
        let side = StemCellAttachSheetLayout.Metrics.tile * (view.window?.screen.scale ?? 3)
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        tiles = assets.enumerated().map { index, asset in
            let tile = StemCellAttachTile()
            tile.accessibilityIdentifier = "attach-photo:\(index)"
            tile.accessibilityLabel = Strings.StemCells.photo(picked: nil)
            tile.addAction(UIAction { [weak self] _ in self?.toggle(asset.localIdentifier) }, for: .touchUpInside)
            thumbnails.requestImage(for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill, options: options) { @Sendable [weak tile] image, _ in
                // A failed full-size fetch (offline iCloud) keeps the degraded one.
                guard let got = image else { return }
                nonisolated(unsafe) let image = got
                let apply = { @MainActor in
                    guard let tile else { return }
                    tile.picture = image
                }
                if Thread.isMainThread { MainActor.assumeIsolated(apply) } else { DispatchQueue.main.async(execute: apply) }
            }
            strip.addSubview(tile)
            return tile
        }
        view.setNeedsLayout()
    }

    private func toggle(_ id: String) {
        if let index = picked.firstIndex(of: id) {
            picked.remove(at: index)
        } else {
            guard picked.count < limit else { return }
            picked.append(id)
            UISelectionFeedbackGenerator().selectionChanged()
        }
        for (asset, tile) in zip(assets, tiles) {
            let number = picked.firstIndex(of: asset.localIdentifier).map { $0 + 1 }
            tile.setNumber(number, animated: true)
            tile.accessibilityLabel = Strings.StemCells.photo(picked: number)
        }
        updatePhotos()
    }

    /// Photos, or "Add N" while the strip holds picks.
    private func updatePhotos() {
        let title = picked.isEmpty ? Strings.StemCells.photos : Strings.StemCells.addPhotos(picked.count)
        photosButton.setTitle(title, for: .normal)
        photosButton.titleLabel?.font = .systemFont(ofSize: 17, weight: picked.isEmpty ? .regular : .semibold)
        view.setNeedsLayout()
    }

    /// The title as just set: the button's own label learns it only on its next layout.
    private var photosWidth: CGFloat {
        guard let title = photosButton.title(for: .normal), let font = photosButton.titleLabel?.font else { return 0 }
        return ceil((title as NSString).size(withAttributes: [.font: font]).width)
    }

    private func photosTapped() {
        finish(picked.isEmpty ? .photos : .add(picked))
    }

    private func rowTapped(_ index: Int) {
        switch index {
        case 0: finish(.paste)
        case 1: finish(.files)
        default: onAction?(.permission)
        }
    }

    /// Closed or swiped away with nothing chosen (a choice is `onAction`).
    var onGone: (() -> Void)?

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed, !chose { onGone?() }
    }

    /// The sheet goes, then the choice is heard over what it covered.
    private func finish(_ action: Action) {
        chose = true
        let onAction = onAction
        dismiss(animated: true) { onAction?(action) }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let fits = CGSize(width: CGFloat.greatestFiniteMagnitude, height: 44)
        let layout = Self.layout(
            width: view.bounds.width, title: titleLabel.sizeThatFits(fits).width,
            photos: photosWidth, tiles: 1 + tiles.count,
            values: rows.map { $0.value.text == nil ? nil : $0.value.sizeThatFits(fits).width }, scale: view.layoutScale
        )
        closeGlass.frame = layout.close
        closeButton.frame = closeGlass.bounds
        titleLabel.frame = layout.title
        photosButton.frame = layout.photos
        strip.frame = layout.strip
        strip.contentSize = CGSize(width: layout.stripContentWidth, height: layout.strip.height)
        for (tile, frame) in zip([camera] + tiles, layout.tiles) { tile.frame = frame }
        group.frame = layout.group
        for (row, frame) in zip(rows, layout.rows) { row.place(frame) }
    }
}

/// One of the strip's square tiles: the camera, or a photo with its
/// numbered check once picked.
final class StemCellAttachTile: UIControl {
    private let image = UIImageView()
    private let check = LibraryCheckView()
    private let icon = IconView(size: 28, tint: Palette.headerTint)
    private let label = UILabel()

    var picture: UIImage? {
        get { image.image }
        set { image.image = newValue }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = StemCellAttachSheetLayout.Metrics.tileRadius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        backgroundColor = UIColor(Palette.stemCellsAttachFill)
        image.contentMode = .scaleAspectFill
        image.clipsToBounds = true
        image.isUserInteractionEnabled = false
        addSubview(image)
        check.isHidden = true
        addSubview(check)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The camera's tile: its glyph over its name, dimmed where there is none.
    func showCamera(available: Bool) {
        icon.icon = .ionicons("camera")
        icon.isUserInteractionEnabled = false
        addSubview(icon)
        label.text = Strings.StemCells.camera
        label.font = .systemFont(ofSize: 15, weight: .medium)
        label.textColor = UIColor(Palette.text)
        label.textAlignment = .center
        addSubview(label)
        isEnabled = available
        accessibilityTraits = available ? .button : [.button, .notEnabled]
        alpha = available ? 1 : 0.45
        accessibilityIdentifier = "attach-camera"
        accessibilityLabel = Strings.StemCells.camera
        accessibilityHint = available ? nil : Strings.StemCells.cameraUnavailable
    }

    func setNumber(_ number: Int?, animated: Bool) {
        check.isHidden = number == nil
        check.set(number, animated: animated)
        accessibilityTraits = number == nil ? .button : [.button, .selected]
    }

    override var isHighlighted: Bool {
        didSet { image.alpha = isHighlighted ? 0.7 : 1 }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        image.frame = bounds
        check.frame = StemCellAttachSheetLayout.check
        // The camera's glyph and name, centred together.
        let labelHeight: CGFloat = 20
        let block = 28 + 6 + labelHeight
        let top = ((bounds.height - block) / 2).rounded()
        icon.frame = CGRect(x: (bounds.width - 28) / 2, y: top, width: 28, height: 28)
        label.frame = CGRect(x: 4, y: top + 28 + 6, width: bounds.width - 8, height: labelHeight)
    }
}

/// One row of the sheet's group: an icon, its name, and for a setting its
/// value and a chevron.
final class StemCellAttachRow: UIControl {
    private let icon: IconView
    private let title = UILabel()
    let value = UILabel()
    private let chevron = IconView(.ionicons("chevron-forward"), size: 14, tint: Palette.textSecondary)
    private let separator = UIView()

    init(icon: Icon, title text: String, id: String, value shown: String?) {
        self.icon = IconView(icon, size: 24, tint: Palette.headerTint)
        super.init(frame: .zero)
        for view in [self.icon, chevron] as [UIView] { view.isUserInteractionEnabled = false }
        title.text = text
        title.font = .systemFont(ofSize: 17)
        title.textColor = UIColor(Palette.text)
        value.text = shown
        value.font = .systemFont(ofSize: 17)
        value.textColor = UIColor(Palette.textSecondary)
        value.textAlignment = .right
        chevron.isHidden = shown == nil
        separator.backgroundColor = UIColor(Palette.stemCellsDivider)
        for view in [self.icon, title, value, chevron, separator] as [UIView] { addSubview(view) }
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityIdentifier = id
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var accessibilityLabel: String? {
        get { title.text }
        set {}
    }

    override var accessibilityValue: String? {
        get { value.text }
        set {}
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(Palette.stemCellsRowPressed) : .clear }
    }

    /// Opened by a tap, over the sheet; one set while it is open replaces it there.
    var menu: UIMenu? {
        didSet {
            isContextMenuInteractionEnabled = menu != nil
            showsMenuAsPrimaryAction = menu != nil
            if let menu { contextMenuInteraction?.updateVisibleMenu { menu.replacing($0) } }
        }
    }

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard let menu else { return nil }
        let configuration = UIContextMenuConfiguration(actionProvider: { _ in menu })
        // Top-down in the order given, whichever way it opens.
        configuration.preferredMenuElementOrder = .fixed
        return configuration
    }

    /// Placed by the sheet's layout, its parts in its own space.
    func place(_ row: StemCellAttachSheetLayout.Row) {
        frame = row.frame
        let origin = row.frame.origin
        icon.frame = row.icon.offsetBy(dx: -origin.x, dy: -origin.y)
        title.frame = row.title.offsetBy(dx: -origin.x, dy: -origin.y)
        value.frame = row.value?.offsetBy(dx: -origin.x, dy: -origin.y) ?? .zero
        chevron.frame = row.chevron?.offsetBy(dx: -origin.x, dy: -origin.y) ?? .zero
        separator.isHidden = row.separator == nil
        separator.frame = row.separator?.offsetBy(dx: -origin.x, dy: -origin.y) ?? .zero
    }
}
#endif
