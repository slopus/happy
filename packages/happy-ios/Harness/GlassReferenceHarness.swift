#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import UIKit

/// Two plain screens under UIKit's own navigation bar, nothing of Happy's
/// in them (`-screen glassReference`): what iOS 26 itself does with a bar's
/// glass as a screen is pushed and popped, to hold Happy's header against.
/// Home has an account button at the left and a gear at the right; the
/// pushed screen Back, a name with a line under it, and compose.
///
/// `-home native` gives the account button UIKit's own title, `-home
/// custom` a custom view, as Happy's switcher is. `-title` picks the
/// pushed screen's name: `text` the item's title and subtitle, `plain` a
/// title view of two labels, `glass` the same on a glass capsule of its
/// own, `item` the labels in a bar item with the bar's glass, `centered`
/// that item after a fixed space meant to bring it to the middle (with
/// `-spacer`, a clear item that hides the bar's glass instead).
/// `-detail` pushes a third screen with a black ground over the second
/// and pops it. `-dark` darkens it. It pushes and pops every 2 s; with
/// `-once` it opens pushed and stays, for a swipe back.
///
/// What iOS 26.5 does with them: the account button's glass blurs and
/// shrinks into Back (a tail on its right as it goes) and Back grows back
/// into it, the gear's into compose, their contents blurred to nothing
/// midway; a title, text or title view, rides with its screen's content,
/// under the right button and under the next screen's ground. A title
/// view's own glass goes with it as a second shape. An item's glass
/// morphs into home's account button, but the bar ignores the fixed
/// space's width and draws the clear spacer as a dark rectangle.
@MainActor
final class GlassReferenceHarness {
    private let navigation: UINavigationController
    private static var spacer = false

    init(window: UIWindow, arguments: [String]) {
        func option(_ name: String) -> String? {
            arguments.firstIndex(of: name).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        }
        if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
        let home = UIViewController()
        home.view.backgroundColor = .systemBackground
        let account = option("-home") ?? "native"
        if account == "custom" {
            let button = UIButton(configuration: .plain())
            button.configuration?.title = "Personal MacBook Pro"
            button.configuration?.image = UIImage(systemName: "person.crop.circle.fill")
            button.configuration?.imagePadding = 6
            button.configuration?.baseForegroundColor = .label
            button.sizeToFit()
            home.navigationItem.leftBarButtonItem = UIBarButtonItem(customView: button)
        } else {
            home.navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Personal MacBook Pro", image: nil, primaryAction: nil, menu: UIMenu(children: [UIAction(title: "Studio Mac") { _ in }]))
        }
        Self.spacer = arguments.contains("-spacer")
        home.navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "gearshape"), primaryAction: nil)
        Self.fill(home.view, rows: 12)
        navigation = UINavigationController(rootViewController: home)
        window.rootViewController = navigation
        let title = option("-title") ?? "text"
        let deeper = arguments.contains("-detail")
        if arguments.contains("-once") {
            // Pushed and left there, for a swipe back made by hand.
            navigation.pushViewController(Self.chat(title), animated: false)
            return
        }
        Task { @MainActor [navigation] in
            for _ in 0..<4 {
                try? await Task.sleep(for: .seconds(2))
                navigation.pushViewController(Self.chat(title), animated: true)
                if deeper {
                    try? await Task.sleep(for: .seconds(2))
                    navigation.pushViewController(Self.detail(), animated: true)
                    try? await Task.sleep(for: .seconds(2))
                    navigation.popViewController(animated: true)
                }
                try? await Task.sleep(for: .seconds(2))
                navigation.popViewController(animated: true)
            }
        }
    }

    /// The conversation's own page, as tapping its name opens it: no
    /// title in the bar, a ground of its own darker than the chat's.
    private static func detail() -> UIViewController {
        let detail = UIViewController()
        detail.view.backgroundColor = .black
        let picture = UIView(frame: CGRect(x: 150, y: 140, width: 100, height: 100))
        picture.backgroundColor = .systemTeal
        picture.layer.cornerRadius = 24
        detail.view.addSubview(picture)
        detail.navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), primaryAction: nil)
        return detail
    }

    private static func chat(_ title: String) -> UIViewController {
        let chat = UIViewController()
        chat.view.backgroundColor = .secondarySystemBackground
        fill(chat.view, rows: 20)
        let item = chat.navigationItem
        item.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "square.and.pencil"), primaryAction: nil)
        switch title {
        case "plain":
            item.titleView = labels()
        case "glass":
            let glass = UIVisualEffectView(effect: UIGlassEffect())
            glass.cornerConfiguration = .capsule()
            let content = labels()
            glass.frame = CGRect(x: 0, y: 0, width: content.bounds.width + 40, height: 44)
            content.center = CGPoint(x: glass.bounds.midX, y: glass.bounds.midY)
            glass.contentView.addSubview(content)
            item.titleView = glass
        case "item":
            let content = labels()
            content.frame.size.width += 24
            let name = UIBarButtonItem(customView: content)
            item.leftBarButtonItems = [name]
            item.leftItemsSupplementBackButton = true
        case "centered":
            // The labels' item pushed to the bar's middle by a space before it.
            let content = labels()
            content.frame.size.width += 24
            let name = UIBarButtonItem(customView: content)
            let width = UIScreen.main.bounds.width
            let room = max(0, width / 2 - content.bounds.width / 2 - 16 - 44 - 16)
            let space: UIBarButtonItem
            if spacer {
                // A clear view instead: the bar ignores a fixed space's width.
                let clear = UIView(frame: CGRect(x: 0, y: 0, width: room, height: 44))
                space = UIBarButtonItem(customView: clear)
                space.hidesSharedBackground = true
            } else {
                space = UIBarButtonItem.fixedSpace(room)
            }
            item.leftBarButtonItems = [space, name]
            item.leftItemsSupplementBackButton = true
        default:
            item.title = "Greeting"
            item.subtitle = "online"
        }
        return chat
    }

    private static func labels() -> UIView {
        let name = UILabel()
        name.text = "Greeting"
        name.font = .systemFont(ofSize: 17, weight: .semibold)
        name.textAlignment = .center
        let status = UILabel()
        status.text = "online"
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabel
        status.textAlignment = .center
        let stack = UIStackView(arrangedSubviews: [name, status])
        stack.axis = .vertical
        stack.alignment = .center
        stack.frame = CGRect(origin: .zero, size: stack.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize))
        stack.frame.size.width = max(stack.frame.width, 120)
        return stack
    }

    private static func fill(_ view: UIView, rows: Int) {
        let scroll = UIScrollView(frame: view.bounds)
        scroll.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(scroll)
        for row in 0..<rows {
            let label = UILabel(frame: CGRect(x: 20, y: 120 + CGFloat(row) * 56, width: 360, height: 44))
            label.text = "Row \(row + 1)"
            scroll.addSubview(label)
        }
        scroll.contentSize = CGSize(width: view.bounds.width, height: 120 + CGFloat(rows) * 56)
    }
}
#endif
