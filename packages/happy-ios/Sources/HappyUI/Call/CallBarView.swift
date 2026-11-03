#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The voice call's bar across the top of the window (`CallBarLayout`):
/// Happy's first-run colours under Telegram-like waves, the call's name
/// and clock centred in the row at its foot, mute at the leading end and
/// end at the trailing one. A call that couldn't start or that dropped
/// stays here in red, saying why, until it is closed.
///
/// Adapted from Telegram-iOS `TelegramCallsUI/Sources/CallStatusBarNode.swift`
/// (the row: semibold 13 title, regular 13 monospaced line, white, centred)
/// (permission from Steve).
final class CallBarView: UIView {
    struct Environment: Equatable {
        var safeArea: LayoutInsets
        var statusBar: CGFloat
        var compactWidth: Bool
        var landscape: Bool
    }

    var environment = Environment(safeArea: LayoutInsets(), statusBar: 0, compactWidth: true, landscape: false) {
        didSet { if environment != oldValue { setNeedsLayout() } }
    }
    var onMute: (() -> Void)?
    var onEnd: (() -> Void)?
    /// A tap on the bar away from its buttons.
    var onTap: (() -> Void)?

    private let waves = CallWavesView()
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private let muteButton = UIButton(type: .custom)
    private let endButton = UIButton(type: .custom)
    private let muteGlyph = UIImageView()
    private let endGlyph = UIImageView()
    private lazy var summary = UIAccessibilityElement(accessibilityContainer: self)
    private var state: CallState = .idle
    private var clock: String?

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = false
        accessibilityIdentifier = "call-bar"
        addSubview(waves)
        let text = UIColor(Palette.CallBar.text)
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = text
        titleLabel.lineBreakMode = .byTruncatingTail
        subtitleLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        subtitleLabel.textColor = text
        subtitleLabel.lineBreakMode = .byTruncatingTail
        for label in [titleLabel, subtitleLabel] {
            label.isAccessibilityElement = false
            label.adjustsFontForContentSizeCategory = false
            addSubview(label)
        }
        for (glyph, button, identifier) in [(muteGlyph, muteButton, "call-mute"), (endGlyph, endButton, "call-end")] {
            glyph.tintColor = text
            glyph.contentMode = .center
            glyph.isUserInteractionEnabled = false
            addSubview(glyph)
            button.accessibilityIdentifier = identifier
            button.addAction(UIAction { [weak glyph] _ in glyph?.alpha = 0.5 }, for: [.touchDown, .touchDragEnter])
            button.addAction(UIAction { [weak glyph] _ in glyph?.alpha = 1 }, for: [.touchUpInside, .touchUpOutside, .touchDragExit, .touchCancel])
            addSubview(button)
        }
        muteButton.addAction(UIAction { [weak self] _ in self?.onMute?() }, for: .primaryActionTriggered)
        endButton.addAction(UIAction { [weak self] _ in self?.onEnd?() }, for: .primaryActionTriggered)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        summary.accessibilityTraits = [.staticText, .updatesFrequently]
        apply(.idle, clock: nil, animated: false)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    @objc private func tapped() { onTap?() }

    func update(level: Double) { waves.update(level: level) }

    /// The bar's height in its environment.
    var barHeight: CGFloat {
        CallBarLayout.height(safeArea: environment.safeArea, statusBar: environment.statusBar,
                             compactWidth: environment.compactWidth, landscape: environment.landscape)
    }

    func apply(_ state: CallState, clock: String?, animated: Bool) {
        self.state = state
        self.clock = clock
        let colors: CallBarGradient
        let title: String
        var subtitle: String?
        var spoken: String
        switch state {
        case .idle, .connecting:
            colors = Palette.CallBar.connecting
            title = Strings.Call.title
            subtitle = Strings.Call.connecting
            spoken = Strings.Call.connecting
        case .active(let activity, let muted, _):
            colors = muted ? Palette.CallBar.muted : activity == .listening ? Palette.CallBar.listening : Palette.CallBar.speaking
            title = Strings.Call.title
            subtitle = muted ? [Strings.Call.muted, clock].compactMap { $0 }.joined(separator: " · ") : clock
            let doing: String = switch activity {
            case .listening: Strings.Call.listening
            case .userSpeaking: Strings.Call.userSpeaking
            case .agentSpeaking: Strings.Call.agentSpeaking
            }
            spoken = muted ? Strings.Call.muted : doing
        case .ended(let problem):
            colors = Palette.CallBar.failed
            title = Self.words(problem)
            spoken = title
        }
        waves.apply(colors, animated: animated)
        waves.isFlat = !Self.moves(state)
        titleLabel.text = title
        subtitleLabel.text = subtitle
        subtitleLabel.isHidden = subtitle == nil

        let live = state.isLive
        muteButton.isHidden = !state.isActive
        muteGlyph.isHidden = muteButton.isHidden
        let muted = state.isMuted
        muteGlyph.image = Self.symbol(muted ? "mic.slash.fill" : "mic.fill")
        muteButton.accessibilityLabel = muted ? Strings.Call.unmute : Strings.Call.mute
        muteButton.accessibilityTraits = muted ? [.button, .selected] : .button
        endGlyph.image = Self.symbol(live ? "phone.down.fill" : "xmark")
        endButton.accessibilityLabel = live ? Strings.Call.end : Strings.Call.close
        if state == .ended(.microphonePermission) { spoken += ". " + Strings.Call.openSettings }
        summary.accessibilityLabel = Strings.Call.accessibility(state: spoken, clock: live ? clock : nil)
        // These two open something on a tap: Settings, the voice paywall.
        let opens = state == .ended(.microphonePermission) || state == .ended(.limitReached)
        summary.accessibilityTraits = opens ? .button : [.staticText, .updatesFrequently]
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = CallBarLayout(
            width: bounds.width, safeArea: environment.safeArea, statusBar: environment.statusBar,
            compactWidth: environment.compactWidth, landscape: environment.landscape,
            titleSize: titleLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 20)),
            subtitleSize: subtitleLabel.isHidden ? .zero : subtitleLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 20))
        )
        waves.frame = layout.waves
        waves.restY = layout.bar.maxY
        titleLabel.frame = layout.title
        subtitleLabel.frame = layout.subtitle
        muteButton.frame = layout.mute
        endButton.frame = layout.end
        muteGlyph.frame = layout.muteGlyph
        endGlyph.frame = layout.endGlyph
        summary.accessibilityFrameInContainerSpace = layout.bar
    }

    /// What VoiceOver hears of the bar, for its echo in a presented screen (`CallBarEcho`).
    var spoken: (summary: String?, traits: UIAccessibilityTraits, mute: String?, end: String?, frame: CGRect) {
        (summary.accessibilityLabel, summary.accessibilityTraits, muteButton.isHidden ? nil : muteButton.accessibilityLabel,
         endButton.accessibilityLabel, summary.accessibilityFrameInContainerSpace)
    }

    override var accessibilityElements: [Any]? {
        get { [summary] + [muteButton, endButton].filter { !$0.isHidden } }
        set {}
    }

    /// Taps inside the bar; nothing below it (the waves' overhang) takes one.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        point.y >= 0 && point.y <= barHeight && point.x >= 0 && point.x <= bounds.width
    }

    private static func moves(_ state: CallState) -> Bool {
        if case .active = state { return true }
        return false
    }

    private static func symbol(_ name: String) -> UIImage? {
        UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold))
    }

    static func words(_ problem: CallProblem) -> String {
        switch problem {
        case .notSetUp: Strings.Call.notSetUp
        case .microphonePermission: Strings.Call.microphone
        case .subscriptionRequired: Strings.Call.subscription
        case .limitReached: Strings.Call.limit
        case .authentication: Strings.Call.authentication
        case .connection: Strings.Call.connection
        }
    }
}

extension CallState {
    var isActive: Bool { if case .active = self { true } else { false } }
    var isMuted: Bool { if case .active(_, let muted, _) = self { muted } else { false } }
}
#endif
