#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// What an agent connection's Settings say about voice, read and never
/// changed: this device's free time (`CallAllowance`, read from its store)
/// and what is on offer, as the call's paywall has it (`CallController.offer`).
/// There is no paid status, because nothing can be bought yet, so nothing
/// claims one. Debug builds can draw it from a
/// fixture for their screenshots (`HAPPY_VOICE_SETTINGS_FIXTURE`: `fresh`,
/// `some` or `used`).
struct AgentVoiceStatus: Equatable {
    /// Free seconds left in the rolling window.
    var remaining: Double
    /// When some free time is back, once it is all used, if that is known.
    var freeAgain: Date?
    var offer: CallOffer

    var minutesLeft: Int { remaining > 0 ? max(1, Int(remaining / 60)) : 0 }

    @MainActor
    static func current(now: Date = Date()) -> AgentVoiceStatus {
        #if DEBUG
        if let fixture = fixture(ProcessInfo.processInfo.environment["HAPPY_VOICE_SETTINGS_FIXTURE"], now: now) { return fixture }
        #endif
        let allowance = CallAllowance()
        let time = now.timeIntervalSince1970
        let remaining = allowance.remaining(at: time)
        let freeAgain = remaining > 0 ? nil : allowance.freeAgain(after: time).flatMap { $0 > time ? Date(timeIntervalSince1970: $0) : nil }
        return AgentVoiceStatus(remaining: remaining, freeAgain: freeAgain, offer: CallController.offer)
    }

    #if DEBUG
    @MainActor
    static func fixture(_ name: String?, now: Date) -> AgentVoiceStatus? {
        let offer = CallController.offer
        return switch name {
        case "fresh": AgentVoiceStatus(remaining: CallAllowance.freeSeconds, freeAgain: nil, offer: offer)
        case "some": AgentVoiceStatus(remaining: 12 * 60 + 20, freeAgain: nil, offer: offer)
        case "used": AgentVoiceStatus(remaining: 0, freeAgain: now.addingTimeInterval(5 * 86_400), offer: offer)
        default: nil
        }
    }
    #endif
}

/// Settings' Support Happy row: the boba, at its one size, leading the
/// row as tall as two, and the words beside it. It stays still here, the
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

/// An agent connection's Voice page: what voice is and how much free time
/// this device has left, then the subscription. Nothing here is a setting;
/// nothing changes voice. Where nothing is on sale, subscribing and
/// restoring are listed and say why they can't be used. Restore is a
/// placeholder for the real one, which comes with the products.
final class AgentVoiceViewController: SettingsPageViewController {
    private let status: () -> AgentVoiceStatus

    init(status: @escaping () -> AgentVoiceStatus = { AgentVoiceStatus.current() }) {
        self.status = status
        super.init(title: Strings.AgentVoice.title)
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
            Row(id: "voice-plan", title: Text.plan, icon: ("mic-outline", .orange), value: Text.free, accessory: .none),
            Row(id: "voice-free", title: Text.freeTime, icon: ("time-outline", .blue), value: Text.freeTimeValue, accessory: .none),
            Row(id: "voice-left", title: Text.left, icon: ("hourglass-outline", .green), value: status.minutesLeft > 0 ? Text.minutes(status.minutesLeft) : Text.usedUp, accessory: .none),
        ]
        if status.minutesLeft == 0, let back = status.freeAgain {
            allowance.append(Row(id: "voice-back", title: Text.back, icon: ("calendar-outline", .gray), value: back.formatted(.dateTime.month(.abbreviated).day().hour().minute()), accessory: .none))
        }
        let subscribe: Row
        let footer: String
        if case .preview(let price) = status.offer {
            subscribe = Row(id: "voice-subscribe", title: Text.subscribe, icon: ("heart", .red), value: Text.perMonth(price), action: { [weak self] in self?.showOffer() })
            footer = Text.previewFooter
        } else {
            subscribe = Row(id: "voice-subscribe", title: Text.subscribe, icon: ("heart", .red), value: Text.notYet, accessory: .none, dimmed: true, hint: Text.notYetHint)
            footer = Text.comingFooter
        }
        let restore = Row(id: "voice-restore", title: Strings.SupportUs.restore, icon: ("refresh-outline", .gray), value: Strings.SupportUs.notAvailable, accessory: .none, dimmed: true, hint: Text.restoreHint)
        return [
            allowance.withFooter(Text.about),
            [subscribe, restore].withFooter(footer),
        ]
    }

    /// Debug test runs only: voice's own sheet, its subscription drawn as
    /// on sale. The welcome while free time is left, the used one after;
    /// closing it starts nothing.
    private func showOffer() {
        let status = status()
        let screen: CallSheetViewController.Screen = status.minutesLeft > 0 ? .welcome(offer: status.offer) : .used(freeAgain: status.freeAgain, offer: status.offer)
        CallSheetViewController.present(screen, over: self)
    }
}
#endif
