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

    /// OfflineMachinesBanner.tsx's title; nil hides the plaque.
    var offlineTitle: String? {
        didSet { if offlineTitle != oldValue { rebuild() } }
    }

    /// `useNativeUpdate`: the store link while this build is too old.
    var showsNativeUpdate = false {
        didSet { if showsNativeUpdate != oldValue { rebuild() } }
    }

    var showsWhatsNew = false {
        didSet { if showsWhatsNew != oldValue { rebuild() } }
    }

    var isEmpty: Bool { offlineTitle == nil && !showsNativeUpdate && !showsWhatsNew }

    private var groups: [ItemGroupView] = []

    private func group(_ row: ItemRowView) -> ItemGroupView {
        let group = ItemGroupView(rows: [row])
        group.untitledPaddingTop = 4
        group.paddingBottom = 16
        return group
    }

    private func rebuild() {
        groups.forEach { $0.removeFromSuperview() }
        groups = []
        if let offlineTitle {
            groups.append(group(ItemRowView(
                title: offlineTitle,
                subtitle: Strings.Troubleshoot.bannerSubtitle,
                icon: ItemIcon(.ionicons("warning-outline"), tint: Palette.warningText, size: 28)
            ) { [weak self] in
                self?.onTroubleshoot?()
            }))
        }
        if showsNativeUpdate {
            groups.append(group(ItemRowView(
                title: Strings.Home.nativeUpdateAvailable,
                subtitle: Strings.Home.tapToUpdateAppStore,
                icon: ItemIcon(.ionicons("download-outline"), tint: Palette.success, size: 28)
            ) { [weak self] in
                self?.onNativeUpdate?()
            }))
        } else if showsWhatsNew {
            groups.append(group(ItemRowView(
                title: Strings.Home.whatsNew,
                subtitle: Strings.Home.seeLatest,
                icon: ItemIcon(.ionicons("sparkles-outline"), tint: Palette.text, size: 28)
            ) { [weak self] in
                self?.onWhatsNew?()
            }))
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
