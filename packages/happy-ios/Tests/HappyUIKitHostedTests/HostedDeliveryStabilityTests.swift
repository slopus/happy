#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// Nothing in a person's own bubble moves or changes size as its mark
/// moves on, in both chats, on screen: a send walked from the clock to
/// one check and two, refused and sent again, with the server's (or the
/// computer's) time arriving a minute after the phone's ("12:59 PM" to
/// "1:00 PM", "9:59 AM" to "10:00 AM"). At every step the bubble, the
/// words, the time, the mark's view and the row's height are the same to
/// the point, inline and on a line of their own, at four text sizes.
///
/// Also: every mark draws inside its view, whichever it is, and the
/// view's frame and its tap target are the same for all four.
///
/// With `HAPPY_EVIDENCE_DIR` set, each step is kept there.
@MainActor
final class HostedDeliveryStabilityTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    private func find<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        if let found = view as? View { return found }
        for subview in view.subviews { if let found = find(type, in: subview) { return found } }
        return nil
    }

    /// Today at `hour`:`minute`:`second`, this phone's time zone, in ms.
    private func today(_ hour: Int, _ minute: Int, _ second: Int) -> Double {
        var parts = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        parts.hour = hour; parts.minute = minute; parts.second = second
        return Calendar.current.date(from: parts)!.timeIntervalSince1970 * 1000
    }

    /// The phone's time for a send, and the time its echo carries.
    private var pairs: [(phone: Double, echo: Double)] {
        [(today(12, 59, 40), today(13, 0, 5)), (today(9, 59, 50), today(10, 0, 12))]
    }

    private let sizes: [(String, TextSizeCategory?)] = [("designed", nil), ("XS", .extraSmall), ("XXXL", .extraExtraExtraLarge), ("AX-L", .accessibilityLarge)]
    private let words = [("inline", "Run the tests"), ("own-line", "Run the tests again with the cache cleared, then tell me what changed in the timings")]

    /// What one step put on screen, in the window's coordinates.
    private struct Step: Equatable {
        var row: CGRect
        var bubble: CGRect
        var text: CGRect
        var time: CGRect
        var timeString: String
        var mark: CGRect
        var markView: CGRect
        var retry: CGRect?
    }

    /// Reads a step off the row view now on screen and checks its mark
    /// draws inside the mark's view.
    private func read(_ view: UIView, plan: ChatRowPlan, canvas: UIView, window: UIWindow, label: String) throws -> (Step, MessageDelivery?) {
        let flight = try XCTUnwrap(plan.flight, "\(label): no bubble shape")
        let index = try XCTUnwrap(plan.items.lastIndex { if case .delivery = $0 { true } else { false } }, "\(label): no mark")
        guard case .delivery(_, let markFrame) = plan.items[index], case .text(let timeLayout, let timeFrame) = plan.items[index - 1] else {
            throw XCTSkip("\(label): no time before the mark")
        }
        let delivery = try XCTUnwrap(find(ChatDeliveryView.self, in: canvas), "\(label): no mark view")
        // Each visible mark's drawing stays in the view, so the view's
        // frame is all a state may take.
        for layer in delivery.layer.sublayers ?? [] where !layer.isHidden {
            guard let shape = layer as? CAShapeLayer, let path = shape.path else { continue }
            let stroke = shape.strokeColor == nil ? 0 : shape.lineWidth / 2
            let drawn = path.boundingBoxOfPath.insetBy(dx: -stroke, dy: -stroke).offsetBy(dx: layer.frame.minX, dy: layer.frame.minY)
            XCTAssertTrue(delivery.bounds.insetBy(dx: -0.01, dy: -0.01).contains(drawn), "\(label): \(String(describing: delivery.mark?.state)) draws \(drawn) outside \(delivery.bounds)")
        }
        let retry = plan.hits.first { if case .retry = $0.action { $0.frame.size == CGSize(width: markFrame.width + 16, height: markFrame.height + 16) } else { false } }
        let step = Step(
            row: view.convert(view.bounds, to: window),
            bubble: view.convert(flight.bubble.frame, to: window),
            text: view.convert(try XCTUnwrap(flight.text), to: window),
            time: view.convert(timeFrame, to: window),
            timeString: timeLayout.string.string,
            mark: view.convert(markFrame, to: window),
            markView: delivery.convert(delivery.bounds, to: window),
            retry: retry.map { view.convert($0.frame, to: window) }
        )
        return (step, delivery.mark?.state)
    }

    private func shot(_ window: UIWindow, _ rect: CGRect, _ name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_EVIDENCE_DIR"] else { return }
        let area = rect.insetBy(dx: -16, dy: -12).intersection(window.bounds)
        let image = UIGraphicsImageRenderer(bounds: area).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("stability-\(name).png"))
    }

    /// Every step against the first: the same to the point.
    private func expectStill(_ steps: [(String, Step)], _ label: String) {
        guard let first = steps.first?.1 else { return XCTFail("\(label): no steps") }
        for (name, step) in steps {
            XCTAssertEqual(step.row, first.row, "\(label) \(name): the row moved or resized")
            XCTAssertEqual(step.bubble, first.bubble, "\(label) \(name): the bubble moved or resized")
            XCTAssertEqual(step.text, first.text, "\(label) \(name): the words moved")
            XCTAssertEqual(step.time, first.time, "\(label) \(name): the time moved or resized")
            XCTAssertEqual(step.timeString, first.timeString, "\(label) \(name): the time changed")
            XCTAssertEqual(step.mark, first.mark, "\(label) \(name): the mark's frame changed")
            XCTAssertEqual(step.markView, first.markView, "\(label) \(name): the mark's view moved")
            // The bubble holds the mark, whatever it is.
            XCTAssertTrue(step.bubble.contains(step.mark), "\(label) \(name): the mark leaves the bubble")
            if let retry = step.retry {
                let target = first.mark.insetBy(dx: -8, dy: -8)
                for (a, b) in [(retry.minX, target.minX), (retry.minY, target.minY), (retry.width, target.width), (retry.height, target.height)] {
                    XCTAssertEqual(a, b, accuracy: 0.001, "\(label) \(name): the retry target \(retry) is not \(target)")
                }
            }
        }
    }

    // MARK: The agent chat

    func testTheAgentChatsBubbleNeverMovesAsItsMarkAndTimeSettle() async throws {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        addTeardownBlock { @MainActor in window.isHidden = true; hostWindow?.makeKey() }
        let root = try XCTUnwrap(window.rootViewController?.view)
        root.backgroundColor = .systemBackground
        let transcript = AgentChatUltraList(frame: root.bounds)
        let host = StillHost()
        transcript.host = host
        root.addSubview(transcript)
        transcript.setViewport(size: root.bounds.size, insets: UIEdgeInsets(top: 120, left: 0, bottom: 100, right: 0))
        let earlier = ChatItem(id: "a1", role: .agent, pieces: [.text("The cache test fails because the file changed under it.")], delivery: .sent)

        for (sizeName, size) in sizes {
            let environment = size.map { TextEnvironment(scale: TextScale($0), displayScale: window.traitCollection.displayScale) }
            let key = ChatPlanner.Key(width: root.bounds.width, maxContentWidth: .greatestFiniteMagnitude, environment: environment)
            for (placement, text) in words {
                for (pairIndex, pair) in pairs.enumerated() {
                    // A planner per send, as each screen has its own.
                    let planner = ChatPlanner(syntax: CodeSyntaxService())
                    let id = "u-\(sizeName)-\(placement)-\(pairIndex)"
                    let label = "agent \(sizeName) \(placement) \(MessageTime.string(pair.phone))→\(MessageTime.string(pair.echo))"
                    // Sending on this phone with its time; refused; sent
                    // again; taken by the computer (its time now); taken
                    // into a run; refused; and taken again.
                    let walk: [(String, ChatItem.Delivery, Double)] = [
                        ("clock", .sending, pair.phone), ("failed", .failed("refused"), pair.phone), ("clock-again", .sending, pair.phone),
                        ("one", .pending, pair.echo), ("two", .sent, pair.echo), ("failed-late", .failed("refused"), pair.echo), ("two-again", .sent, pair.echo),
                    ]
                    var steps: [(String, Step)] = []
                    var marks: [MessageDelivery?] = []
                    for (name, delivery, time) in walk {
                        let item = ChatItem(id: id, role: .user, pieces: [.text(text)], delivery: delivery, time: time)
                        let shown = await planner.plans([earlier, item], key: key, copied: nil)
                        transcript.apply(shown, animated: true)
                        let mounted = try await until { (transcript.list.loadedItemView(at: 0) as? AgentChatRowView)?.row.plan === shown[1] }
                        XCTAssertTrue(mounted, "\(label) \(name): never shown")
                        let view = try XCTUnwrap(transcript.list.loadedItemView(at: 0) as? AgentChatRowView)
                        try await Task.sleep(for: .milliseconds(60))
                        let (step, mark) = try read(view, plan: shown[1], canvas: view.canvas, window: window, label: "\(label) \(name)")
                        steps.append((name, step))
                        marks.append(mark)
                        if sizeName == "designed", pairIndex == 0 { try shot(window, step.bubble, "agent-\(placement)-\(name)") }
                    }
                    XCTAssertEqual(marks, [.sending, .failed, .sending, .received, .accepted, .failed, .accepted], label)
                    // The phone's time stays: the row first showed it.
                    XCTAssertEqual(steps.first?.1.timeString, MessageTime.string(pair.phone), label)
                    expectStill(steps, label)
                }
            }
        }
    }

    // MARK: The Happy CLI chat

    func testTheHappyCLIChatsBubbleNeverMovesAsItsMarkAndTimeSettle() async throws {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        addTeardownBlock { @MainActor in window.isHidden = true; hostWindow?.makeKey() }
        let root = try XCTUnwrap(window.rootViewController?.view)
        root.backgroundColor = .systemBackground
        window.layoutIfNeeded()
        let list = ChatListView(frame: root.bounds.inset(by: UIEdgeInsets(top: 100, left: 0, bottom: 100, right: 0)))
        root.addSubview(list)
        list.layoutIfNeeded()
        list.setEdgeInsets(newest: 8, oldest: 8)
        // The agent says when it takes a message in: two checks come from
        // its receipt, and a refusal from its rejection.
        let record = SessionRecord(id: "s", seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            projectId: nil, metadataVersion: 1, metadataCipher: "cipher",
            metadata: .object(["client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1), "capabilities": .object(["messageReceipts": .bool(true)])]),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil, dataKeyCipher: "wrapped", decryptable: true)
        let session = ChatSessionState(record: record, settings: AccountSettings())
        let agent = ChatMessage.agentText(AgentTextMessage(id: "a1", createdAt: 1_000, text: "The cache test fails because the file changed under it."))

        for (sizeName, size) in sizes {
            for (placement, text) in words {
                for (pairIndex, pair) in pairs.enumerated() {
                    let planner = RowPlanner<ChatRowInput, ChatRowPlan> { ChatRowRenderer.plan($0, width: $1) }
                    let localId = "l-\(sizeName)-\(placement)-\(pairIndex)"
                    let label = "Happy CLI \(sizeName) \(placement) \(MessageTime.string(pair.phone))→\(MessageTime.string(pair.echo))"
                    // In the outbox with the phone's time; refused; sent
                    // again; stored by the server (its time now, the
                    // agent's receipt pending); received; rejected.
                    let walk: [(String, Int64, Bool, OutboxDelivery?, String?)] = [
                        ("clock", Int64(pair.phone), true, .sending, nil), ("failed", Int64(pair.phone), true, .failed("offline"), nil),
                        ("clock-again", Int64(pair.phone), true, .sending, nil), ("one", Int64(pair.echo), true, nil, nil),
                        ("two", Int64(pair.echo), false, nil, nil), ("rejected", Int64(pair.echo), false, nil, "rejected"),
                    ]
                    var applied = ChatRowsApplied()
                    var steps: [(String, Step)] = []
                    var marks: [MessageDelivery?] = []
                    for (name, createdAt, pending, delivery, error) in walk {
                        var view = ChatRowsView()
                        view.width = list.bounds.width
                        if let size { view.text = ChatRowText(environment: TextEnvironment(scale: TextScale(size), displayScale: window.traitCollection.displayScale), words: .english) }
                        let user = ChatMessage.userText(UserTextMessage(id: localId, localId: localId, createdAt: createdAt, text: text, pending: pending, sendError: error))
                        let input = ChatRowsInput(
                            snapshot: LegacyChatSnapshot(sessionId: "s", messages: [agent, user], delivery: delivery.map { [localId: $0] } ?? [:], isLoaded: true),
                            session: session, view: view, render: .isolated()
                        )
                        guard let derived = ChatRows.derive(input, applied: applied, planner: planner) else { XCTFail("\(label) \(name): nothing derived"); continue }
                        applied = derived.state
                        if let update = derived.output.list { list.apply(update, animated: true) }
                        let identity = "chat:message:\(localId)"
                        func rowView() -> ChatUltraRowView? {
                            list.ultra.list.items.firstIndex { $0.identity == identity }.flatMap(list.ultra.list.loadedItemView(at:)) as? ChatUltraRowView
                        }
                        let ready = try await until { list.isDisplayReady && rowView()?.row.plan === applied.rows.plans.first }
                        XCTAssertTrue(ready, "\(label) \(name): never drawn")
                        let row = try XCTUnwrap(rowView())
                        try await Task.sleep(for: .milliseconds(60))
                        let (step, mark) = try read(row, plan: row.row.plan, canvas: row.canvas, window: window, label: "\(label) \(name)")
                        steps.append((name, step))
                        marks.append(mark)
                        if sizeName == "designed", pairIndex == 0 { try shot(window, step.bubble, "legacy-\(placement)-\(name)") }
                    }
                    XCTAssertEqual(marks, [.sending, .failed, .sending, .received, .accepted, .failed], label)
                    XCTAssertEqual(steps.first?.1.timeString, MessageTime.string(pair.phone), label)
                    expectStill(steps, label)
                    list.apply(ChatListUpdate(ids: [], plans: [], model: ChatListLayout(width: list.bounds.width, heights: []), footer: nil, changeset: RowChangeset(), pinning: nil), animated: false)
                    try await Task.sleep(for: .milliseconds(50))
                }
            }
        }
    }

    // MARK: The time's width

    /// Times of one format are one width: tabular digits. A 12-hour
    /// clock's "AM" and "PM" are not the same width, nor are "9:59" and
    /// "10:00"; a row never changes between them, since it keeps the time
    /// it first showed (the walks above).
    func testTimesOfOneFormatAreOneWidthInTwelveAndTwentyFourHourLocales() throws {
        let utc = TimeZone(identifier: "UTC")!
        func ms(_ hour: Int, _ minute: Int) -> Double { Double(hour * 3600 + minute * 60) * 1000 }
        for (localeId, groups) in [
            ("en_US", [[ms(1, 0), ms(1, 11), ms(9, 59), ms(4, 44)], [ms(10, 10), ms(11, 59), ms(10, 0)], [ms(13, 0), ms(19, 59), ms(21, 11)], [ms(22, 10), ms(23, 59), ms(12, 0)]]),
            ("en_GB", [[ms(1, 0), ms(10, 10), ms(11, 59), ms(12, 0), ms(23, 59), ms(0, 0)]]),
            ("de_DE", [[ms(1, 0), ms(10, 10), ms(11, 59), ms(12, 0), ms(23, 59)]]),
        ] {
            let formatter = MessageTime.makeFormatter(Locale(identifier: localeId), timeZone: utc)
            for size in [nil, TextSizeCategory.accessibilityLarge] {
                let environment = size.map { TextEnvironment(scale: TextScale($0), displayScale: 3) }
                for group in groups {
                    let measured = group.map { at -> (String, CGFloat) in
                        let string = formatter.string(from: Date(timeIntervalSince1970: at / 1000))
                        return (string, ChatTextLayout(MessageTime.attributed(string, ink: Palette.deliveryInk, in: environment), width: 1000, maxLines: 1).size.width)
                    }
                    for (string, width) in measured {
                        XCTAssertEqual(width, measured[0].1, accuracy: 0.001, "\(localeId) at \(size.map { "\($0)" } ?? "designed"): \(string) vs \(measured[0].0)")
                    }
                }
            }
        }
    }
}

/// Shows each plan in its row, as the screen does.
@MainActor
private final class StillHost: AgentChatTranscriptHost {
    func show(_ plan: ChatRowPlan, in view: ChatPlanView) { view.apply(plan) }
    func placedChunks(of plan: ChatRowPlan, in view: ChatPlanView) {}
    func transcriptScrolled() {}
    func transcriptWillBeginDragging() {}
    func transcriptDidEndDragging() {}
    func transcriptTapped(_ action: ChatRowAction) {}
    func transcriptOpened(_ url: String) {}
    func transcriptHeld(_ action: ChatRowAction, in view: UIView, frame: CGRect, at point: CGPoint) {}
}
#endif
