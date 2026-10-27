import Foundation

/// What a conversation shared, as Telegram's shared media: the pictures,
/// recordings and files it showed, and the links written in it, newest
/// first. Derived from the transcript itself, nothing kept beside it.
public struct StemCellsShared: Equatable, Sendable {
    public enum Media: Equatable, Sendable {
        /// A picture sent with a message, from the bytes sent
        /// (`StemCellMediaLoader.sentKey(id)`): `id` is its message's and
        /// which of its pictures it is, the same whether the phone still
        /// sends it or history has it.
        case picture(id: String, mimeType: String, data: Data)
        /// What a tool presented: a picture, a recording or a file.
        case tool(StemCellMedia)

        /// What a screen knows it by.
        public var key: String {
            switch self {
            case .picture(let id, _, _): "sent/\(id)"
            case .tool(let media): media.key
            }
        }

        var isSent: Bool {
            if case .picture = self { true } else { false }
        }

        /// A picture, either kind; a recording or a file is not.
        public var isPicture: Bool {
            switch self {
            case .picture: true
            case .tool(let media): media.isVisual && !media.isVideo
            }
        }
    }

    public struct Link: Equatable, Sendable {
        public var url: String
        /// Its Markdown text, when it had one other than itself.
        public var title: String?
        /// Its host, `www.` dropped.
        public var host: String
    }

    public var media: [Media] = []
    public var links: [Link] = []

    public init(media: [Media] = [], links: [Link] = []) {
        self.media = media
        self.links = links
    }

    public var isEmpty: Bool { media.isEmpty && links.isEmpty }

    /// A sent picture's ID: its message's, and which of its pictures.
    static func pictureId(_ messageId: String, _ ordinal: Int) -> String { "\(messageId)#\(ordinal)" }

    /// What the phone's transcript shows, newest first, each once.
    public static func of(items: [StemCellChatItem]) -> StemCellsShared {
        var reader = Reader()
        return reader.read(items)
    }

    /// One item's media and links, in its order.
    static func of(item: StemCellChatItem) -> StemCellsShared {
        var shared = StemCellsShared()
        if case .collaborator = item.role { return shared }
        var media: [Media] = []
        var texts: [String] = []
        for piece in item.pieces {
            switch piece {
            case .picture(_, let mimeType, let data): media.append(.picture(id: pictureId(item.id, media.filter(\.isSent).count), mimeType: mimeType, data: data))
            case .gallery(let shown, _), .tree(let shown, _): media += shown.map(Media.tool)
            case .file(let one): media.append(.tool(one))
            case .text(let text): texts.append(text)
            case .artifact, .story, .sidebarProposal: break
            }
        }
        shared.add(media: media, texts: texts)
        return shared
    }

    /// The transcript read again as it changes: an item read before and
    /// unchanged isn't read again, so a reply streaming in costs its own
    /// text alone.
    public struct Reader: Sendable {
        private var kept: [String: (item: StemCellChatItem, shared: StemCellsShared)] = [:]

        public init() {}

        public mutating func read(_ items: [StemCellChatItem]) -> StemCellsShared {
            var next: [String: (item: StemCellChatItem, shared: StemCellsShared)] = [:]
            var shared = StemCellsShared()
            for item in items.reversed() {
                let one = kept[item.id].flatMap { $0.item == item ? $0.shared : nil } ?? StemCellsShared.of(item: item)
                next[item.id] = (item, one)
                shared.media += one.media
                shared.links += one.links
            }
            kept = next
            return shared.deduplicated()
        }
    }

    /// What a page of history shows, newest first, each once, as the
    /// transcript draws it: a person's pictures, a tool's media, and the
    /// links in what either side wrote.
    public static func of(messages: [AgentWire.Message]) -> StemCellsShared {
        var shared = StemCellsShared()
        for message in messages.reversed() where message.role == "user" || message.role == "agent" {
            var media: [Media] = []
            var texts: [String] = []
            var pictures = 0
            for block in message.content {
                switch block {
                case .text(let text):
                    texts.append(text)
                case .image(let mimeType, let data):
                    if let bytes = Data(base64Encoded: data) { media.append(.picture(id: pictureId(message.id, pictures), mimeType: mimeType, data: bytes)) }
                    pictures += 1
                case .toolCall(let id, _, _, let presentation):
                    guard let presentation, presentation.type == "media" else { continue }
                    media += (presentation.items ?? []).enumerated().map { .tool(StemCellMedia(toolCallId: id, index: $0.offset, item: $0.element)) }
                case .reasoning, .unknown:
                    continue
                }
            }
            shared.add(media: media, texts: texts)
        }
        return shared.deduplicated()
    }

    /// One message's media, then its links, after what is newer. Within
    /// a message, its own order.
    private mutating func add(media: [Media], texts: [String]) {
        self.media += media
        links += texts.flatMap(Self.links(in:))
    }

    /// `newer`, then what `older` adds: the same media or link once.
    public func merged(older: StemCellsShared) -> StemCellsShared {
        var keys = Set(media.map(\.key))
        var urls = Set(links.map(\.url))
        var merged = self
        for one in older.media where keys.insert(one.key).inserted { merged.media.append(one) }
        for link in older.links where urls.insert(link.url).inserted { merged.links.append(link) }
        return merged
    }

    /// Each one once, where it first shows.
    public func deduplicated() -> StemCellsShared {
        StemCellsShared().merged(older: self)
    }

    // MARK: Links

    /// `[text](url)`, not `![alt](url)`; a URL may hold balanced parentheses.
    private static let markdownLink = try! NSRegularExpression(pattern: #"(?<!!)\[([^\]\n]{1,300})\]\((https?://(?:[^\s()]|\([^\s()]*\))+)\)"#)
    private static let markdownImage = try! NSRegularExpression(pattern: #"!\[[^\]\n]{0,300}\]\([^\s)]*\)"#)
    private static let bareLink = try! NSRegularExpression(pattern: #"https?://(?:[^\s<>"'`()\[\]{}]|\([^\s<>"'`()\[\]{}]*\))+"#, options: [.caseInsensitive])
    /// What ends a sentence rather than a link.
    private static let trailing = CharacterSet(charactersIn: ".,;:!?*_~'\"")

    /// The links in `text`, in its order: a Markdown link with its text, a
    /// bare one as written, punctuation after it left out.
    public static func links(in text: String) -> [Link] {
        let whole = NSRange(text.startIndex..., in: text)
        var found: [(location: Int, link: Link)] = []
        var covered = markdownImage.matches(in: text, range: whole).map(\.range)
        for match in markdownLink.matches(in: text, range: whole) {
            guard let titleRange = Range(match.range(at: 1), in: text), let urlRange = Range(match.range(at: 2), in: text),
                  let link = link(String(text[urlRange]), title: String(text[titleRange])) else { continue }
            found.append((match.range.location, link))
            covered.append(match.range)
        }
        for match in bareLink.matches(in: text, range: whole) where !covered.contains(where: { NSIntersectionRange($0, match.range).length > 0 }) {
            guard let range = Range(match.range, in: text), let link = link(String(text[range]), title: nil) else { continue }
            found.append((match.range.location, link))
        }
        return found.sorted { $0.location < $1.location }.map(\.link)
    }

    private static func link(_ raw: String, title: String?) -> Link? {
        var url = raw
        while let last = url.unicodeScalars.last, trailing.contains(last) { url.removeLast() }
        guard let host = URLComponents(string: url)?.host, !host.isEmpty else { return nil }
        let name = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let bare = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        return Link(url: url, title: name.flatMap { $0.isEmpty || $0 == url || $0 == raw ? nil : $0 }, host: bare)
    }
}

/// A conversation's shared media and links, read a page of history at a
/// time from the newest back, off the main thread: as many pages as it
/// takes to have what a screen asks for, never more than `pagesPerAsk`
/// for one ask.
public actor StemCellsSharedFeed {
    public struct State: Equatable, Sendable {
        public var shared = StemCellsShared()
        /// Older history is still unread.
        public var hasMore = true
        public var failed = false
        public init() {}
    }

    /// Small pages: a run comes whole, and a person's pictures come with
    /// it as their bytes (the ones the grid draws), a few MB a run; the
    /// direct connection takes 8 MB a response.
    public static let pageSize = 10
    public static let pagesPerAsk = 6

    private let client: DirectAgentClient
    private let agentId: String
    private var before: String?
    private(set) public var state = State()
    private var reading = false

    public init(client: DirectAgentClient, agentId: String) {
        self.client = client
        self.agentId = agentId
    }

    /// Reads on until `media` media or `links` links are in (nil: that
    /// section isn't asked about), history ends, or `pagesPerAsk` pages are
    /// read. One ask at a time; another while one reads gets what it had.
    public func load(media: Int?, links: Int?) async -> State {
        guard !reading else { return state }
        reading = true
        defer { reading = false }
        var pages = 0
        func short() -> Bool {
            state.shared.media.count < media ?? 0 || state.shared.links.count < links ?? 0
        }
        while state.hasMore, pages < Self.pagesPerAsk, short(), !Task.isCancelled {
            do {
                let page = try await client.messages(agentId, before: before, limit: Self.pageSize)
                pages += 1
                state.failed = false
                // Runs come oldest first; the page's oldest is the next cursor.
                let messages = page.runs.flatMap { $0.messages ?? [] }
                state.shared = state.shared.merged(older: StemCellsShared.of(messages: messages))
                before = page.runs.first?.id
                state.hasMore = page.hasMore && before != nil
            } catch {
                state.failed = true
                break
            }
        }
        return state
    }
}
