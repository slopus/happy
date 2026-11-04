#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// What an agent connection's Settings say about voice, read and never
/// changed: this device's voice time (`CallAllowance`, read from its store:
/// the free 20 minutes, or the subscription's 5 hours this month) and what
/// is on offer, as the call's sheets have it (`Offers.offer`). Debug builds
/// can draw it from a
/// fixture for their screenshots (`HAPPY_VOICE_SETTINGS_FIXTURE`: `fresh`,
/// `some` or `used`).
struct AgentVoiceStatus: Equatable {
    /// Free seconds left in the rolling window.
    var remaining: Double
    /// When some free time is back, once it is all used, if that is known.
    var freeAgain: Date?
    var offer: CallOffer
    /// Whether the build can restore at all (it has RevenueCat's key).
    var canRestore = false

    var subscribed: Bool { offer == .subscribed }

    var minutesLeft: Int { remaining > 0 ? max(1, Int(remaining / 60)) : 0 }

    @MainActor
    static func current(now: Date = Date()) -> AgentVoiceStatus {
        #if DEBUG
        if let fixture = fixture(ProcessInfo.processInfo.environment["HAPPY_VOICE_SETTINGS_FIXTURE"], now: now) { return fixture }
        #endif
        let allowance = CallAllowance(period: { Offers.shared.month() })
        let time = now.timeIntervalSince1970
        let remaining = allowance.remaining(at: time)
        let freeAgain = remaining > 0 ? nil : allowance.freeAgain(after: time).flatMap { $0 > time ? Date(timeIntervalSince1970: $0) : nil }
        return AgentVoiceStatus(remaining: remaining, freeAgain: freeAgain, offer: Offers.shared.offer, canRestore: Offers.shared.canRestore)
    }

    #if DEBUG
    @MainActor
    static func fixture(_ name: String?, now: Date) -> AgentVoiceStatus? {
        let offer = Offers.shared.offer
        return switch name {
        case "fresh": AgentVoiceStatus(remaining: CallAllowance.freeSeconds, freeAgain: nil, offer: offer)
        case "some": AgentVoiceStatus(remaining: 12 * 60 + 20, freeAgain: nil, offer: offer)
        case "used": AgentVoiceStatus(remaining: 0, freeAgain: now.addingTimeInterval(5 * 86_400), offer: offer)
        default: nil
        }
    }
    #endif
}

/// Settings' Support Happy row: the boba at a tile's size, where the
/// other rows have their tiles, and the words beside it. It stays still here, the
/// pose it was drawn to rest in (`StateSceneView`'s `onDemand`, never
/// asked); it moves only in the sheet the row opens. It takes no touches
/// of its own: a tap anywhere on the row is the row's.
final class SupportBobaArt: UIView {
    let scene = StateSceneView(scene: .boba, size: SettingsLayout.Metrics.art, play: .onDemand, replayLabel: Strings.AgentVoice.supportSpoken)

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
        addSubview(scene)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        scene.frame = bounds
    }
}

/// An agent connection's Voice page: what voice is and how much time this
/// device has left, then the subscription. Nothing here is a setting;
/// nothing changes voice. Subscribe opens the store's own sheet and Restore
/// restores (`Offers`), with nothing in between; where nothing is on sale,
/// subscribing is listed and says so.
final class AgentVoiceViewController: SettingsPageViewController {
    private let status: () -> AgentVoiceStatus
    private var observation: SubscriptionObservation?

    init(status: @escaping () -> AgentVoiceStatus = { AgentVoiceStatus.current() }) {
        self.status = status
        super.init(title: Strings.AgentVoice.title)
        // Bought, restored, or another account: the page says so at once.
        observation = Offers.shared.observe { [weak self] in self?.reload() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Back from a call: the time left is read again.
        reload()
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Row = SettingsRow
        typealias Text = Strings.AgentVoice
        let status = status()
        var allowance = [
            Row(id: "voice-plan", title: Text.plan, icon: ("mic-outline", .orange), value: status.subscribed ? Strings.Offer.subscribed : Text.free, accessory: .none),
            status.subscribed
                ? Row(id: "voice-free", title: Strings.Offer.includedVoice, icon: ("time-outline", .blue), value: Strings.Offer.includedValue, accessory: .none)
                : Row(id: "voice-free", title: Text.freeTime, icon: ("time-outline", .blue), value: Text.freeTimeValue, accessory: .none),
            Row(id: "voice-left", title: Text.left, icon: ("hourglass-outline", .green), value: status.minutesLeft > 0 ? Text.minutes(status.minutesLeft) : Text.usedUp, accessory: .none),
        ]
        if status.minutesLeft == 0, let back = status.freeAgain {
            allowance.append(Row(id: "voice-back", title: Text.back, icon: ("calendar-outline", .gray), value: back.formatted(.dateTime.month(.abbreviated).day().hour().minute()), accessory: .none))
        }
        if status.subscribed { return [allowance.withFooter(Text.about), [Row(id: "voice-thanks", title: Strings.SupportUs.thankYou, icon: ("heart", .red), accessory: .none)]] }
        let subscribe: Row
        let footer: String
        if let price = status.offer.price {
            subscribe = Row(id: "voice-subscribe", title: Text.subscribe, icon: ("heart", .red), value: Text.perMonth(price), action: { [weak self] in self?.buy() })
            footer = if case .preview = status.offer { Text.previewFooter } else { Strings.Offer.voiceFooter }
        } else {
            subscribe = Row(id: "voice-subscribe", title: Text.subscribe, icon: ("heart", .red), value: Text.notYet, accessory: .none, dimmed: true, hint: Text.notYetHint)
            footer = Text.comingFooter
        }
        let restore = status.canRestore
            ? Row(id: "voice-restore", title: Strings.SupportUs.restore, icon: ("refresh-outline", .gray), action: { [weak self] in self?.restore() })
            : Row(id: "voice-restore", title: Strings.SupportUs.restore, icon: ("refresh-outline", .gray), value: Strings.SupportUs.notAvailable, accessory: .none, dimmed: true, hint: Text.restoreHint)
        return [
            allowance.withFooter(Text.about),
            [subscribe, restore].withFooter(footer),
        ]
    }

    /// The store's own sheet, which confirms the purchase.
    private func buy() {
        Task { await Offers.shared.subscribe(from: self) }
    }

    private func restore() {
        Task { await Offers.shared.restore(from: self) }
    }
}
#endif
