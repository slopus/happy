import Foundation

/// How `readConversation` pages through a conversation: backwards, from the
/// newest turn into older ones, a turn at a time. A turn is an exchange:
/// the person's message and the agent's last words after it, however many
/// runs that took (`CallTargetState.exchanges`), or the person's message
/// still waiting for an answer, which is the newest. Each has a reference
/// of its own, `t:` and the end of its ID on the computer (its first
/// run's, or the waiting message's own): two characters, more where two
/// would fit another turn the phone has of that conversation. Android's
/// `CallRead` is the same, word for word.
public enum CallRead {
    /// Turns a read gives unless it is told where to stop.
    public static let turns = 5
    /// The most one read gives, however far apart its ends are.
    public static let maxTurns = 50
    /// Words of each message a read gives unless asked for more or fewer.
    public static let words = 500
    public static let minWords = 20
    public static let maxWords = 5000
    /// Bytes of UTF-8 a word may take on average before a message is cut
    /// for its size alone: code and long names, or text with no spaces.
    static let bytesPerWord = 10

    /// Where a read starts (`from`) or stops (`backTo`).
    public enum Point: Equatable, Sendable {
        /// Turns back from the newest: 0 is the newest.
        case back(Int)
        /// A turn's reference without its `t:`.
        case ref(String)
    }

    /// What a read was asked for.
    public struct Request: Equatable, Sendable {
        public var from: Point?
        public var backTo: Point?
        public var words: Int

        public init(from: Point? = nil, backTo: Point? = nil, words: Int = CallRead.words) {
            self.from = from
            self.backTo = backTo
            self.words = words
        }
    }

    /// One turn as a read pages over it: a finished turn, or the message
    /// still waiting for an answer.
    public struct Item: Equatable, Sendable {
        public var id: String
        public var turn: CallTurn?
        public var pending: CallMessage?
    }

    /// The turns a read can give, oldest first: those with something to
    /// say (the person's message, the agent's last words, an error), then
    /// the message still waiting for an answer.
    public static func items(_ state: CallTargetState) -> [Item] {
        var items = state.exchanges.filter { $0.user?.isEmpty == false || $0.reply?.isEmpty == false || $0.ended == "error" }
            .map { Item(id: $0.id, turn: $0, pending: nil) }
        if let pending = state.unanswered { items.append(Item(id: pending.id, turn: nil, pending: pending)) }
        return items
    }

    /// Each ID's reference: `t:` and its last two characters, or as many
    /// more as tell it from every other ID here.
    public static func references(_ ids: [String]) -> [String] {
        ids.map { id in
            var length = min(2, id.count)
            while length < id.count, ids.contains(where: { $0 != id && $0.hasSuffix(id.suffix(length)) }) { length += 1 }
            return "t:" + id.suffix(length)
        }
    }

    /// The arguments' request, or why they can't be read.
    public static func request(_ arguments: [String: Any]) -> (request: Request?, refusal: String?) {
        var request = Request()
        switch point(arguments["from"], named: "from") {
        case .success(let value): request.from = value
        case .failure(let refusal): return (nil, refusal.reason)
        }
        switch point(arguments["backTo"], named: "backTo") {
        case .success(let value): request.backTo = value
        case .failure(let refusal): return (nil, refusal.reason)
        }
        switch arguments["words"] {
        case nil, is NSNull:
            break
        case let number as NSNumber where CFGetTypeID(number) != CFBooleanGetTypeID() && number.doubleValue.isFinite:
            request.words = clamp(number.doubleValue.rounded())
        case let text as String where Double(text.trimmingCharacters(in: .whitespaces))?.isFinite == true:
            request.words = clamp(Double(text.trimmingCharacters(in: .whitespaces))!.rounded())
        default:
            return (nil, "words must be a number of words, \(minWords) to \(maxWords).")
        }
        return (request, nil)
    }

    private static func clamp(_ words: Double) -> Int {
        Int(min(Double(maxWords), max(Double(minWords), words)))
    }

    struct Refusal: Error { var reason: String }

    /// `from` or `backTo` as given: absent, a number of turns back, or a
    /// turn's reference. A conversation's reference (`s3`) is told apart.
    private static func point(_ value: Any?, named name: String) -> Result<Point?, Refusal> {
        let wrong = Refusal(reason: "\(name) is a turn's ref from a read, such as t:3f, or a number of turns back from the newest (0 is the newest).")
        switch value {
        case nil, is NSNull:
            return .success(nil)
        case let number as NSNumber:
            guard CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.rounded() == number.doubleValue, number.doubleValue >= 0 else { return .failure(wrong) }
            return .success(.back(Int(min(number.doubleValue, 1_000_000))))
        case let raw as String:
            let text = raw.trimmingCharacters(in: .whitespaces)
            if text.isEmpty { return .success(nil) }
            if text.allSatisfy(\.isASCII), text.allSatisfy(\.isNumber) { return .success(.back(Int(text.prefix(7)) ?? 1_000_000)) }
            if text.lowercased().hasPrefix("t:"), text.count > 2 { return .success(.ref(String(text.dropFirst(2)))) }
            if text.first == "s", text.count > 1, text.dropFirst().allSatisfy(\.isNumber) {
                return .failure(Refusal(reason: "\(text) is a conversation's ref; \(name) takes a turn's ref, such as t:3f, or a number of turns back."))
            }
            return .failure(wrong)
        default:
            return .failure(wrong)
        }
    }

    /// The turns `request` asks for among `items`, as indexes oldest first,
    /// or why they can't be read: a reference that fits no turn or several,
    /// or a start past the oldest.
    static func range(_ request: Request, in items: [Item], references: [String], older: Bool) -> Result<ClosedRange<Int>?, Refusal> {
        let ids = items.map(\.id)
        guard !ids.isEmpty else { return .success(nil) }
        func index(_ point: Point, name: String) -> Result<Int, Refusal> {
            switch point {
            case .back(let back):
                guard back < ids.count else {
                    let held = older ? " the phone has" : ""
                    return .failure(Refusal(reason: "\(name) \(back) is past the oldest of the \(ids.count) turns\(held) (0 to \(ids.count - 1) back)."))
                }
                return .success(ids.count - 1 - back)
            case .ref(let suffix):
                if let exact = ids.lastIndex(of: suffix) { return .success(exact) }
                let fits = ids.indices.filter { ids[$0].hasSuffix(suffix) }
                if fits.count == 1 { return .success(fits[0]) }
                if fits.isEmpty {
                    let held = older ? " in the turns the phone has of it" : ""
                    return .failure(Refusal(reason: "No turn t:\(suffix) in this conversation\(held). Use a ref from one of its reads."))
                }
                return .failure(Refusal(reason: "t:\(suffix) fits several turns: \(fits.map { references[$0] }.joined(separator: ", ")). Use one of those."))
            }
        }
        var newest = ids.count - 1
        if let from = request.from {
            switch index(from, name: "from") {
            case .success(let found): newest = found
            case .failure(let refusal): return .failure(refusal)
            }
        }
        var oldest = max(0, newest - (turns - 1))
        if let backTo = request.backTo {
            // Back past the oldest reads to the oldest.
            if case .back(let back) = backTo, back >= ids.count { oldest = 0 }
            else {
                switch index(backTo, name: "backTo") {
                case .success(let found): oldest = found
                case .failure(let refusal): return .failure(refusal)
                }
            }
        }
        if oldest > newest { swap(&oldest, &newest) }
        oldest = max(oldest, newest - (maxTurns - 1))
        return .success(oldest...newest)
    }

    /// A message cut in the middle: its start and its end, `words` of it in
    /// all, and between them how many were left out; nil if it is within
    /// `words` and `words` × 10 bytes. Half the words are the start's, half
    /// the end's, each cut at a whole word (or, a word too long for half
    /// the bytes, between characters).
    public static func cut(_ text: String, words limit: Int) -> (text: String, words: Int, leftOut: Int)? {
        // Each word's characters and UTF-8 bytes, start and end.
        var pieces: [(start: String.Index, end: String.Index, startByte: Int, endByte: Int)] = []
        var byte = 0
        var open: (String.Index, Int)?
        for index in text.indices {
            let character = text[index]
            if isSpace(character) {
                if let (start, startByte) = open { pieces.append((start, index, startByte, byte)); open = nil }
            } else if open == nil {
                open = (index, byte)
            }
            byte += character.utf8.count
        }
        if let (start, startByte) = open { pieces.append((start, text.endIndex, startByte, byte)) }
        let total = pieces.count
        let bytes = byte
        let maxBytes = limit * bytesPerWord
        guard total > limit || bytes > maxBytes else { return nil }
        let half = maxBytes / 2
        var headEnd = text.startIndex
        var head = 0
        while head < (limit + 1) / 2, head < total, pieces[head].endByte <= half {
            headEnd = pieces[head].end
            head += 1
        }
        if head == 0, let first = pieces.first {
            headEnd = text.index(first.start, offsetBy: CallContext.truncated(String(text[first.start...]), bytes: half).count)
        }
        var tailStart = text.endIndex
        var tail = 0
        while tail < limit / 2, total - 1 - tail >= head, bytes - pieces[total - 1 - tail].startByte <= half {
            tailStart = pieces[total - 1 - tail].start
            tail += 1
        }
        if tail == 0, let last = pieces.last, total > head || head == 0 {
            tailStart = text.index(last.end, offsetBy: -suffixCount(String(text[..<last.end]), bytes: half))
        }
        let leftOut = max(1, total - head - tail)
        let start = String(text[..<headEnd]).trimmingCharacters(in: .whitespacesAndNewlines)
        let end = String(text[tailStart...]).trimmingCharacters(in: .whitespacesAndNewlines)
        return ([start, "… (\(leftOut) \(leftOut == 1 ? "word" : "words") left out) …", end].filter { !$0.isEmpty }.joined(separator: " "), total, leftOut)
    }

    /// How many characters at the end of `text` fit `bytes` of UTF-8.
    private static func suffixCount(_ text: String, bytes: Int) -> Int {
        var count = 0
        var size = 0
        for character in text.reversed() {
            size += character.utf8.count
            if size > bytes { break }
            count += 1
        }
        return count
    }

    /// A space, tab or line break: where words end.
    static func isSpace(_ character: Character) -> Bool {
        character.unicodeScalars.allSatisfy { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" }
    }
}
