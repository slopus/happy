import Foundation
import HappyCore

extension Strings {
    /// Settings › Connection: how the account reaches its server or
    /// computer, and what went over it in the last ten minutes. A
    /// diagnostics page, in English as Data and Storage is; the link's
    /// state is the headers' own words (`HeaderStatus`).
    enum Connection {
        static let title = "Connection"
        static let status = "Status"
        static let lastTenMinutes = "Last 10 Minutes"
        static let tailcat = "Tailcat"

        static let type = "Type"
        static let state = "State"
        static let computer = "Computer"
        static let node = "Node"
        static let port = "Port"
        static let relay = "Relay"
        static let relayServer = "Relay server"
        static let endpoint = "Peer address"
        static let protocolTitle = "Protocol"
        static let engine = "Engine.IO"
        static let path = "Path"
        static let server = "Server"
        static let realtime = "Realtime"
        static let connectedFor = "Connected"
        static let network = "Network"

        static let sent = "Sent"
        static let received = "Received"
        static let requests = "Requests"
        static let failed = "Failed requests"
        static let connectionsOpened = "Connections opened"
        static let connectionsClosed = "Connections closed"
        static let webSocketsOpened = "WebSockets opened"
        static let webSocketsClosed = "WebSockets closed"
        static let eventStreamsOpened = "Event streams opened"
        static let eventStreamsClosed = "Event streams closed"
        static let reconnects = "Reconnects"
        static let latencyP50 = "Request time p50"
        static let latencyP95 = "Request time p95"
        static let bytesPerMinute = "Bytes per minute"

        static let liveFlows = "Open flows"
        static let closingFlows = "Closing flows"
        static let tunnels = "Tunnels open"
        static let lastError = "Last error"
        static let errorAge = "When"
        static let none = "None"
        static let notConnected = "Not connected"
        static let dash = "—"

        static let copy = "Copy Diagnostics"
        static let copied = "Copied"
        static let copyFooter = "A plain-text snapshot of this page, for a bug report. It holds no keys, tokens or addresses that would let anyone in."

        static let tailcatFooter = "Each request opens its own flow through the tunnel. This phone may have 1,024 open at once; the computer accepts 256 at once on its port from every phone together. A closed flow lingers a moment to finish with the computer; past 1,024 of those, the oldest is dropped."
        static let httpConnectionsFooter = "The system keeps HTTP connections open to reuse them and closes them without saying, so only the ones it opened are counted."

        static func since(_ duration: String) -> String { "Counting for \(duration), since this account opened." }

        // The connection in plain words, a row each.
        static let tailcatUp = "Tailcat"
        static let happyServer = "Happy CLI server"
        static let httpsSocketIO = "HTTPS + Socket.IO"
        static let httpSocketIO = "HTTP + Socket.IO"
        static let relayed = "Relayed (DERP)"
        static let direct = "Direct (peer to peer)"
        static let connecting = "Connecting"

        static func traffic(_ channel: String) -> String { "\(channel) traffic" }
        static func peak(_ size: String) -> String { "peak \(size)" }
        static func of(_ count: String, _ limit: String) -> String { "\(count) of \(limit)" }
        static func ago(_ age: String) -> String { "\(age) ago" }
    }
}
