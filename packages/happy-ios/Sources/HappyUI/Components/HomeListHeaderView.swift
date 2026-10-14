#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// HomeListHeader.tsx on a phone: the offline plaque while every computer
/// is offline, then the update banner. Each is an ItemGroup with 4 above
/// and 16 below. UpdateBanner shows one notice: the store update first,
/// else "What's new". Its OTA reload belongs to the RN app.
final class HomeListHeaderView: UIView {
    var onTroubleshoot: (() -> Void)?
    var onNativeUpdate: (() -> Void)?
    var onWhatsNew: (() -> Void)?

    /// The notices and their words, drawn as they were measured: the list
    /// sets the value whose height it worked out off the main thread.
    var content = HomeBanners() {
        didSet { if content != oldValue { rebuild() } }
    }

    // One input at a time, for a list that sizes the header here: each
    // sets the notices again with the screens' current words.

    /// OfflineMachinesBanner.tsx's title; nil hides the plaque.
    var offlineTitle: String? {
        get { content.offlineTitle }
        set { content = HomeBanners(offlineTitle: newValue, nativeUpdate: content.nativeUpdate, whatsNew: content.whatsNew) }
    }

    /// `useNativeUpdate`: the store link while this build is too old.
    var showsNativeUpdate: Bool {
        get { content.nativeUpdate }
        set { content = HomeBanners(offlineTitle: content.offlineTitle, nativeUpdate: newValue, whatsNew: content.whatsNew) }
    }

    var showsWhatsNew: Bool {
        get { content.whatsNew }
        set { content = HomeBanners(offlineTitle: content.offlineTitle, nativeUpdate: content.nativeUpdate, whatsNew: newValue) }
    }

    var isEmpty: Bool { content.isEmpty }

    private var groups: [ItemGroupView] = []

    private func group(_ row: ItemRowView) -> ItemGroupView {
        let group = ItemGroupView(rows: [row])
        group.untitledPaddingTop = 4
        group.paddingBottom = 16
        return group
    }

    private func rebuild() {
        groups.forEach { $0.removeFromSuperview() }
        groups = content.notices.map { notice in
            let icon = switch notice.kind {
            case .offline: ItemIcon(.ionicons("warning-outline"), tint: Palette.warningText, size: 28)
            case .nativeUpdate: ItemIcon(.ionicons("download-outline"), tint: Palette.success, size: 28)
            case .whatsNew: ItemIcon(.ionicons("sparkles-outline"), tint: Palette.text, size: 28)
            }
            let kind = notice.kind
            return group(ItemRowView(title: notice.title, subtitle: notice.subtitle, icon: icon) { [weak self] in
                switch kind {
                case .offline: self?.onTroubleshoot?()
                case .nativeUpdate: self?.onNativeUpdate?()
                case .whatsNew: self?.onWhatsNew?()
                }
            })
        }
        groups.forEach(addSubview)
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> HomeListHeaderLayout {
        HomeListHeaderLayout(width: width, banners: groups.map(\.measurable))
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for (group, frame) in zip(groups, layout(width: bounds.width).banners) {
            group.setLayoutFrame(frame)
        }
    }
}
#endif
