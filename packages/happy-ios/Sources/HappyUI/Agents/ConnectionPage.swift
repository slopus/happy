#if canImport(UIKit)
import Foundation
import HappyCore

/// What Settings › Connection shows, card by card, worked out from one
/// recorder snapshot and the link's state, and the same as plain text for
/// Copy Diagnostics. Equatable, so a tick that changes nothing redraws
/// nothing.
struct ConnectionPage: Equatable {
    struct Row: Equatable {
        var id: String
        var title: String
        var value: String?
        /// Bytes per minute, for the sparkline row.
        var chart: [Int64]?
        /// A row that does something when tapped.
        var isAction = false
    }

    struct Card: Equatable {
        var id: String
        var header: String?
        var rows: [Row]
        var footer: String?
    }

    enum Kind: Equatable {
        case agent(name: String)
        case legacy(serverURL: URL, socketURL: URL)
    }

    struct Inputs: Equatable {
        var kind: Kind
        var state: LinkState
        var network: NetworkPathDetails
        var snapshot: ConnectionSnapshot
        var version: String
        var variant: String
    }

    var cards: [Card]
    var diagnostics: String

    func row(_ id: String) -> Row? { cards.lazy.flatMap(\.rows).first { $0.id == id } }

    typealias Text = Strings.Connection

    /// Every channel a request goes on; Socket.IO's frames are not requests.
    static let requestChannels: [ConnectionChannel] = [.http, .tailcat, .media, .browser]

    static func make(_ inputs: Inputs) -> ConnectionPage {
        let snapshot = inputs.snapshot
        let totals = snapshot.totals
        var status: [Row] = [
            Row(id: "type", title: Text.type, value: type(inputs)),
            Row(id: "state", title: Text.state, value: stateText(inputs.state)),
        ]
        var tailcat: Card?
        let since: TimeInterval?
        switch inputs.kind {
        case .agent(let name):
            status.append(Row(id: "computer", title: Text.computer, value: name))
            if let tunnel = snapshot.tunnel {
                status.append(Row(id: "node", title: Text.node, value: tunnel.nodeKey))
                status.append(Row(id: "port", title: Text.port, value: String(tunnel.port)))
                status.append(Row(id: "relay", title: Text.relay, value: relay(tunnel)))
            }
            if let path = snapshot.path {
                status.append(Row(id: "path", title: Text.path, value: pathText(path)))
            }
            since = snapshot.tunnelSince
            tailcat = Card(id: "tailcat", header: Text.tailcat, rows: [
                Row(id: "flows", title: Text.liveFlows, value: Text.flows(count(snapshot.liveFlows))),
                Row(id: "tunnels", title: Text.tunnels, value: count(snapshot.tunnels)),
                Row(id: "error", title: Text.lastError, value: lastError(snapshot)),
            ], footer: Text.tailcatFooter)
        case .legacy(let serverURL, let socketURL):
            status.append(Row(id: "server", title: Text.server, value: serverURL.absoluteString))
            status.append(Row(id: "realtime", title: Text.realtime, value: realtime(socketURL)))
            since = snapshot.streamSince[.socket]
        }
        status.append(Row(id: "connected", title: Text.connectedFor, value: snapshot.age(since).map(duration) ?? Text.notConnected))
        status.append(Row(id: "network", title: Text.network, value: inputs.network.text))
        if case .legacy = inputs.kind {
            status.append(Row(id: "error", title: Text.lastError, value: lastError(snapshot)))
        }

        let agent = if case .agent = inputs.kind { true } else { false }
        let failed = totals.failures(on: requestChannels)
        let streamChannel: ConnectionChannel = agent ? .tailcat : .socket
        let p50 = totals.latency(0.5, on: requestChannels), p95 = totals.latency(0.95, on: requestChannels)
        let opened = totals.count(.connectionsOpened)
        let peak = totals.bytesPerMinute.max() ?? 0
        let window = Card(id: "window", header: Text.lastTenMinutes, rows: [
            Row(id: "sent", title: Text.sent, value: size(totals.count(.bytesSent))),
            Row(id: "received", title: Text.received, value: size(totals.count(.bytesReceived))),
            Row(id: "requests", title: Text.requests, value: Text.requestsValue(count(totals.requests(on: requestChannels)), failed: failed > 0 ? count(failed) : nil)),
            // HTTP's closes are never seen (URLSession pools them), so a
            // Happy CLI account says only what opened.
            Row(id: "connections", title: Text.connections, value: Text.openedClosed(count(opened), agent ? count(totals.count(.connectionsClosed)) : nil)),
            Row(id: "streams", title: agent ? Text.eventStreams : Text.webSockets, value: Text.streams(
                count(totals.count(.streamsOpened, streamChannel)), count(totals.count(.streamsClosed, streamChannel)),
                reconnects: count(totals.count(.streamReconnects, streamChannel)))),
            Row(id: "latency", title: Text.latency, value: p50.flatMap { p50 in p95.map { Text.latencyValue(p50: milliseconds(p50), p95: milliseconds($0)) } } ?? Text.dash),
            Row(id: "chart", title: Text.bytesPerMinute, value: peak > 0 ? Text.peak(size(peak)) : nil, chart: totals.bytesPerMinute),
        ], footer: windowFooter(snapshot, agent: agent))

        let channels = totals.channelsUsed
        let byChannel = channels.isEmpty ? nil : Card(id: "channels", header: Text.byChannel, rows: channels.map { channel in
            Row(id: "channel-\(channel.rawValue)", title: channel.name, value: channelSummary(totals, channel))
        })
        let copy = Card(id: "copy", rows: [Row(id: "copy", title: Text.copy, isAction: true)], footer: Text.copyFooter)

        let cards = [Card(id: "status", header: Text.status, rows: status), window] + [byChannel, tailcat].compactMap { $0 } + [copy]
        return ConnectionPage(cards: cards, diagnostics: diagnostics(inputs, cards: cards))
    }

    // MARK: Words

    static func type(_ inputs: Inputs) -> String {
        switch inputs.kind {
        case .legacy(let serverURL, _):
            return serverURL.scheme?.lowercased() == "https" ? Text.happyServer : Text.happyServerPlain
        case .agent:
            switch inputs.snapshot.path {
            case .relayed?: return Text.tailcatRelayed(inputs.snapshot.tunnel?.regionLabel ?? "DERP")
            case .direct?: return Text.tailcatDirect
            case nil:
                if inputs.snapshot.tunnels > 0 { return Text.tailcatUp }
                return inputs.state == .offline || inputs.state == .waitingForNetwork ? "\(Text.tailcatUp) · \(Text.notConnected.lowercased())" : Text.tailcatConnecting
            }
        }
    }

    /// The headers' own words, begun with a capital as a value is.
    static func stateText(_ state: LinkState) -> String {
        let text = Strings.HeaderStatus.text(state)
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    static func relay(_ tunnel: TunnelInfo) -> String {
        [tunnel.regionLabel, tunnel.relayHost].compactMap { $0 }.joined(separator: " · ")
    }

    static func pathText(_ path: TunnelPath) -> String {
        switch path {
        case .relayed: Text.relayed
        case .direct(let endpoint): Text.direct(endpoint)
        }
    }

    /// The socket's endpoint and the Engine.IO version it asks for; its
    /// query holds nothing else (the token goes in the handshake).
    static func realtime(_ url: URL) -> String {
        let engine = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "EIO" }?.value
        let endpoint = "\(url.scheme ?? "wss")://\(url.host ?? "")\(url.port.map { ":\($0)" } ?? "")\(url.path)"
        return engine.map { "\(endpoint) · Engine.IO \($0)" } ?? endpoint
    }

    static func lastError(_ snapshot: ConnectionSnapshot) -> String {
        guard let error = snapshot.lastError else { return Text.none }
        return snapshot.age(snapshot.lastErrorAt).map { Text.ago(error, duration($0)) } ?? error
    }

    static func windowFooter(_ snapshot: ConnectionSnapshot, agent: Bool) -> String? {
        var parts: [String] = []
        if snapshot.counted < TimeInterval(MetricsRing.windowSeconds) - 1 { parts.append(Text.since(duration(snapshot.counted))) }
        if !agent { parts.append(Text.httpConnectionsFooter) }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    static func channelSummary(_ totals: MetricsTotals, _ channel: ConnectionChannel) -> String {
        var parts = ["↑ \(size(totals.count(.bytesSent, channel)))", "↓ \(size(totals.count(.bytesReceived, channel)))"]
        let requests = totals.requests(on: [channel])
        if requests > 0 { parts.append("\(count(requests)) req") }
        return parts.joined(separator: " · ")
    }

    // MARK: Numbers

    static func size(_ bytes: Int64) -> String { MediaSizeText.size(Int(clamping: bytes)) }

    /// "1,024": grouped as the page's English words are.
    static func count<T: BinaryInteger>(_ value: T) -> String {
        var grouped = ""
        for (index, digit) in String(value.magnitude).reversed().enumerated() {
            if index > 0, index % 3 == 0 { grouped.append(",") }
            grouped.append(digit)
        }
        return (value < 0 ? "-" : "") + String(grouped.reversed())
    }

    /// "42 s", "4 min 12 s", "1 h 5 min".
    static func duration(_ seconds: TimeInterval) -> String {
        let whole = max(0, Int(seconds.rounded(.down)))
        if whole < 60 { return "\(whole) s" }
        if whole < 3600 { return whole % 60 == 0 ? "\(whole / 60) min" : "\(whole / 60) min \(whole % 60) s" }
        let minutes = (whole % 3600) / 60
        return minutes == 0 ? "\(whole / 3600) h" : "\(whole / 3600) h \(minutes) min"
    }

    /// "85 ms", "1.2 s"; the bins' edges are ragged, so whole milliseconds.
    static func milliseconds(_ seconds: TimeInterval) -> String {
        let ms = seconds * 1000
        if ms < 1000 { return "\(Int(ms.rounded())) ms" }
        return String(format: "%.1f s", seconds)
    }

    // MARK: Diagnostics

    /// The page as plain text, with every counter by channel. Nothing in it
    /// opens anything: the computer's public node key, never its address;
    /// the server's URL, never a token.
    static func diagnostics(_ inputs: Inputs, cards: [Card]) -> String {
        let snapshot = inputs.snapshot
        let totals = snapshot.totals
        var lines = ["Happy connection diagnostics", "App: \(inputs.version) (\(inputs.variant))"]
        switch inputs.kind {
        case .agent: lines.append("Account: \(Strings.AccountKind.agent)")
        case .legacy: lines.append("Account: \(Strings.AccountKind.cli)")
        }
        lines.append("Window: last \(duration(snapshot.counted)) of \(MetricsRing.windowSeconds / 60) min")
        for card in cards where card.id != "copy" {
            lines.append("")
            lines.append(card.header ?? card.id)
            for row in card.rows {
                if let chart = row.chart {
                    lines.append("  \(row.title) (oldest first): " + chart.map { String($0) }.joined(separator: ", "))
                } else {
                    lines.append("  \(row.title): \(row.value ?? "")")
                }
            }
        }
        lines.append("")
        lines.append("Counters")
        for channel in ConnectionChannel.allCases {
            let values = ConnectionCounter.allCases.map { "\($0)=\(totals.count($0, channel))" }.joined(separator: " ")
            var line = "  \(channel.name): \(values)"
            if let p50 = totals.latency(0.5, on: [channel]), let p95 = totals.latency(0.95, on: [channel]) {
                line += " p50=\(milliseconds(p50)) p95=\(milliseconds(p95))"
            }
            lines.append(line)
        }
        return lines.joined(separator: "\n")
    }
}
#endif
