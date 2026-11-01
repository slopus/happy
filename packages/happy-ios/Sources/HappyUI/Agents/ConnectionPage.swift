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
        var status: [Row] = []
        var tailcat: Card?
        let since: TimeInterval?
        switch inputs.kind {
        case .agent(let name):
            status.append(Row(id: "type", title: Text.type, value: Text.tailcatUp))
            status.append(Row(id: "path", title: Text.path, value: pathText(inputs)))
            if case .direct(let endpoint)? = snapshot.path {
                status.append(Row(id: "endpoint", title: Text.endpoint, value: endpoint))
            }
            status.append(Row(id: "state", title: Text.state, value: stateText(inputs.state)))
            status.append(Row(id: "computer", title: Text.computer, value: name))
            if let tunnel = snapshot.tunnel {
                status.append(Row(id: "node", title: Text.node, value: tunnel.nodeKey))
                status.append(Row(id: "port", title: Text.port, value: String(tunnel.port)))
                status.append(Row(id: "relay", title: Text.relay, value: tunnel.regionLabel))
                if let host = tunnel.relayHost { status.append(Row(id: "relay-host", title: Text.relayServer, value: host)) }
            }
            since = snapshot.tunnelSince
            // Tailcat's own count when the tunnel is up; the app's, of the
            // flows it opened and has not closed, until then.
            var flows = [Row(id: "flows", title: Text.liveFlows, value: Text.of(count(snapshot.flows?.open ?? snapshot.liveFlows), count(snapshot.flows?.openLimit ?? 1024)))]
            if let tunnel = snapshot.flows {
                flows.append(Row(id: "closing-flows", title: Text.closingFlows, value: Text.of(count(tunnel.closing), count(tunnel.closingLimit))))
            }
            tailcat = Card(id: "tailcat", header: Text.tailcat, rows: flows + [
                Row(id: "tunnels", title: Text.tunnels, value: count(snapshot.tunnels)),
            ] + errorRows(snapshot), footer: Text.tailcatFooter)
        case .legacy(let serverURL, let socketURL):
            status.append(Row(id: "type", title: Text.type, value: Text.happyServer))
            status.append(Row(id: "protocol", title: Text.protocolTitle, value: serverURL.scheme?.lowercased() == "https" ? Text.httpsSocketIO : Text.httpSocketIO))
            status.append(Row(id: "state", title: Text.state, value: stateText(inputs.state)))
            status.append(Row(id: "server", title: Text.server, value: host(serverURL)))
            status.append(Row(id: "realtime", title: Text.realtime, value: socketURL.path.isEmpty ? "/" : socketURL.path))
            if let engine = engineVersion(socketURL) {
                status.append(Row(id: "engine", title: Text.engine, value: engine))
            }
            since = snapshot.streamSince[.socket]
        }
        status.append(Row(id: "connected", title: Text.connectedFor, value: snapshot.age(since).map(duration) ?? Text.notConnected))
        status.append(Row(id: "network", title: Text.network, value: inputs.network.text))
        if case .legacy = inputs.kind { status += errorRows(snapshot) }

        let agent = if case .agent = inputs.kind { true } else { false }
        let streamChannel: ConnectionChannel = agent ? .tailcat : .socket
        let p50 = totals.latency(0.5, on: requestChannels), p95 = totals.latency(0.95, on: requestChannels)
        let peak = totals.bytesPerMinute.max() ?? 0
        var window: [Row] = [
            Row(id: "sent", title: Text.sent, value: size(totals.count(.bytesSent))),
            Row(id: "received", title: Text.received, value: size(totals.count(.bytesReceived))),
            Row(id: "requests", title: Text.requests, value: count(totals.requests(on: requestChannels))),
            Row(id: "failed", title: Text.failed, value: count(totals.failures(on: requestChannels))),
            Row(id: "connections-opened", title: Text.connectionsOpened, value: count(totals.count(.connectionsOpened))),
        ]
        // HTTP's closes are never seen (URLSession pools them), so a Happy
        // CLI account says only what opened.
        if agent {
            window.append(Row(id: "connections-closed", title: Text.connectionsClosed, value: count(totals.count(.connectionsClosed))))
        }
        window += [
            Row(id: "streams-opened", title: agent ? Text.eventStreamsOpened : Text.webSocketsOpened, value: count(totals.count(.streamsOpened, streamChannel))),
            Row(id: "streams-closed", title: agent ? Text.eventStreamsClosed : Text.webSocketsClosed, value: count(totals.count(.streamsClosed, streamChannel))),
            Row(id: "reconnects", title: Text.reconnects, value: count(totals.count(.streamReconnects, streamChannel))),
            Row(id: "latency-p50", title: Text.latencyP50, value: p50.map(milliseconds) ?? Text.dash),
            Row(id: "latency-p95", title: Text.latencyP95, value: p95.map(milliseconds) ?? Text.dash),
            Row(id: "chart", title: Text.bytesPerMinute, value: peak > 0 ? Text.peak(size(peak)) : nil, chart: totals.bytesPerMinute),
        ]

        // A card a channel, headed by its name.
        let channels = totals.channelsUsed.map { channel in
            var rows = [
                Row(id: "channel-\(channel.rawValue)-sent", title: Text.sent, value: size(totals.count(.bytesSent, channel))),
                Row(id: "channel-\(channel.rawValue)-received", title: Text.received, value: size(totals.count(.bytesReceived, channel))),
            ]
            if requestChannels.contains(channel) {
                rows.append(Row(id: "channel-\(channel.rawValue)-requests", title: Text.requests, value: count(totals.requests(on: [channel]))))
            }
            return Card(id: "channel-\(channel.rawValue)", header: Text.traffic(channel.name), rows: rows)
        }
        let copy = Card(id: "copy", rows: [Row(id: "copy", title: Text.copy, isAction: true)], footer: Text.copyFooter)

        let cards = [Card(id: "status", header: Text.status, rows: status),
                     Card(id: "window", header: Text.lastTenMinutes, rows: window, footer: windowFooter(snapshot, agent: agent))]
            + channels + [tailcat, copy].compactMap { $0 }
        return ConnectionPage(cards: cards, diagnostics: diagnostics(inputs, cards: cards))
    }

    // MARK: Words

    /// How the tunnel goes; the type row says it is Tailcat.
    static func pathText(_ inputs: Inputs) -> String {
        switch inputs.snapshot.path {
        case .relayed?: return Text.relayed
        case .direct?: return Text.direct
        case nil:
            if inputs.snapshot.tunnels > 0 { return Text.dash }
            return inputs.state == .offline || inputs.state == .waitingForNetwork ? Text.notConnected : Text.connecting
        }
    }

    /// The headers' own words, begun with a capital as a value is.
    static func stateText(_ state: LinkState) -> String {
        let text = Strings.HeaderStatus.text(state)
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    /// The server's host, and its port when it names one; the protocol
    /// row has the scheme.
    static func host(_ url: URL) -> String {
        (url.host ?? url.absoluteString) + (url.port.map { ":\($0)" } ?? "")
    }

    /// The Engine.IO version the socket asks for; its query holds nothing
    /// else (the token goes in the handshake).
    static func engineVersion(_ url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "EIO" }?.value
    }

    /// "None", or the error and, a row under it, how long ago.
    static func errorRows(_ snapshot: ConnectionSnapshot) -> [Row] {
        guard let error = snapshot.lastError else { return [Row(id: "error", title: Text.lastError, value: Text.none)] }
        var rows = [Row(id: "error", title: Text.lastError, value: error)]
        if let age = snapshot.age(snapshot.lastErrorAt) {
            rows.append(Row(id: "error-age", title: Text.errorAge, value: Text.ago(duration(age))))
        }
        return rows
    }

    static func windowFooter(_ snapshot: ConnectionSnapshot, agent: Bool) -> String? {
        var parts: [String] = []
        if snapshot.counted < TimeInterval(MetricsRing.windowSeconds) - 1 { parts.append(Text.since(duration(snapshot.counted))) }
        if !agent { parts.append(Text.httpConnectionsFooter) }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
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
