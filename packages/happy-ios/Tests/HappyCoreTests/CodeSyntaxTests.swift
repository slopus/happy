import Foundation
import XCTest
@testable import HappyCore

/// SimpleSyntaxHighlighter.tsx's tokenizer as the port first had it: the
/// whole block's bracket nesting first, then each line. The per-line
/// tokenizer must give exactly this.
private enum WholeBlockHighlighter {
    static func tokenize(_ code: String, language: String?) -> [SyntaxToken] {
        guard let language else { return [SyntaxToken(code, .plain)] }
        let lang = language.lowercased()
        let grammar: SyntaxHighlighter.Grammar = lang == "python" || lang == "py" ? .python
            : lang == "typescript" || lang == "ts" ? .typescript : lang == "java" ? .java : .base
        let patterns = SyntaxHighlighter.patterns(for: grammar)
        let nesting = bracketNesting(code)
        var tokens: [SyntaxToken] = []
        var globalOffset = 0
        for (lineIndex, line) in code.jsSplit("\n").enumerated() {
            if lineIndex > 0 {
                tokens.append(SyntaxToken("\n", .plain))
                globalOffset += 1
            }
            let source = line as NSString
            var found: [(start: Int, end: Int, kind: SyntaxToken.Kind, order: Int)] = []
            for pattern in patterns {
                for match in pattern.regex.matches(in: line) {
                    let start: Int
                    let length: Int
                    if let group = pattern.captureGroup {
                        let text = match.group(group, in: line) ?? ""
                        let whole = source.substring(with: match.range) as NSString
                        let offset = whole.range(of: text).location
                        start = match.range.location + (offset == NSNotFound ? 0 : offset)
                        length = (text as NSString).length
                    } else {
                        start = match.range.location
                        length = match.range.length
                    }
                    found.append((start, start + length, pattern.kind, found.count))
                }
            }
            found.sort { $0.start != $1.start ? $0.start < $1.start : $0.order < $1.order }
            var current = 0
            var lastEnd = 0
            for token in found where token.start >= lastEnd {
                lastEnd = token.end
                if token.start > current {
                    tokens.append(SyntaxToken(source.substring(with: NSRange(location: current, length: token.start - current)), .plain))
                }
                let text = source.substring(with: NSRange(location: token.start, length: token.end - token.start))
                if token.kind == .bracket {
                    tokens.append(SyntaxToken(text, .bracket, nestLevel: nesting[globalOffset + token.start] ?? 1))
                } else {
                    tokens.append(SyntaxToken(text, token.kind))
                }
                current = token.end
            }
            if current < source.length {
                tokens.append(SyntaxToken(source.substring(from: current), .plain))
            }
            globalOffset += source.length
        }
        return tokens
    }

    static func bracketNesting(_ code: String) -> [Int: Int] {
        let pairs: [UInt16: UInt16] = [40: 41, 91: 93, 123: 125, 60: 62]
        let closers = Set(pairs.values)
        var map: [Int: Int] = [:]
        var stack: [UInt16] = []
        for (index, unit) in code.utf16.enumerated() {
            if pairs[unit] != nil {
                stack.append(unit)
                map[index] = stack.count
            } else if closers.contains(unit), let open = stack.popLast() {
                if pairs[open] == unit {
                    map[index] = stack.count + 1
                }
            }
        }
        return map
    }
}

/// The real tokenizer, counted, on a clock that moves one millisecond per
/// line tokenized; optionally held, uncounted, on the line it is asked for
/// once `holdsAfter` lines are done (its first line, for `holdsFirstLine`),
/// until the gate opens.
private final class CodeSyntaxProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    private var ticks = 0
    private let base = ContinuousClock.now
    private let holdsAfter: Int?
    let gate: ApplyPerfGate?

    init(holdsFirstLine: Bool = false, holdsAfter: Int? = nil) {
        self.holdsAfter = holdsAfter ?? (holdsFirstLine ? 0 : nil)
        gate = self.holdsAfter == nil ? nil : ApplyPerfGate()
    }

    var calls: Int { lock.withLock { lines.count } }
    var tokenized: [String] { lock.withLock { lines } }
    func at(_ milliseconds: Int) -> ContinuousClock.Instant { base + .milliseconds(milliseconds) }
    var now: ContinuousClock.Instant { lock.withLock { base + .milliseconds(ticks) } }

    func service(lineCountLimit: Int = 16_384, payloadLimit: Int = 4 * 1024 * 1024,
                 queueCountLimit: Int = 64, queuePayloadLimit: Int = 4 * 1024 * 1024) -> CodeSyntaxService {
        CodeSyntaxService(lineCountLimit: lineCountLimit, payloadLimit: payloadLimit, queueCountLimit: queueCountLimit,
                          queuePayloadLimit: queuePayloadLimit, now: { self.now }) { text, grammar, stack in
            if let holdsAfter = self.holdsAfter, self.calls >= holdsAfter { self.gate?.pass() }
            self.lock.withLock {
                self.lines.append(text)
                self.ticks += 1
            }
            return SyntaxHighlighter.tokenizeLine(text, grammar: grammar, stack: stack)
        }
    }
}

private func code(lines count: Int, tag: String = "") -> String {
    (0..<count).map { "const value\(tag)\($0) = compute(\($0), [\($0)]) // \(tag)" }.joined(separator: "\n")
}

final class CodeSyntaxHighlighterTests: XCTestCase {
    func testLineByLineTokensMatchTheWholeBlockTokenizer() {
        let samples = [
            "", "\n", "a\n", "f(g(1))", "{\n}", "x = \"if\" // done", "def run():\n    return [a == (b or 1)]",
            "if (a < b && c > d) {\n  return x[i] }\n}", "foo(]\n)", "<div>{items.map((x) => (\n  <li>{x}</li>\n))}</div>",
            "/* a ( */ b)\nc]", "s = '(' + \")\"\n(", "a\r\n(b)\r\n", "😀(é[\n]) 👍", "@cached\ndef f(a, b):\n    return [a == (b or 1)]",
        ]
        var seed: UInt64 = 0x9E37_79B9_7F4A_7C15
        func random(_ bound: Int) -> Int {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((seed >> 33) % UInt64(bound))
        }
        let alphabet = Array("({[<>]})\n\"'`/ *#ab1.=;:!?@")
        let generated = (0..<300).map { _ in String((0..<random(80)).map { _ in alphabet[random(alphabet.count)] }) }
        for code in samples + generated {
            for language in [nil, "js", "Python", "ts", "JAVA", "rust"] as [String?] {
                XCTAssertEqual(SyntaxHighlighter.tokenize(code, language: language),
                               WholeBlockHighlighter.tokenize(code, language: language), "\(code.debugDescription) \(language ?? "nil")")
            }
        }
    }

    func testABlocksLinesChainTheirBracketStacks() {
        let first = SyntaxHighlighter.tokenizeLine("f(a, [b", grammar: .base, stack: .init())
        XCTAssertEqual(first.stack, .init([40, 91]))
        let second = SyntaxHighlighter.tokenizeLine("])", grammar: .base, stack: first.stack)
        XCTAssertEqual(second.tokens, [SyntaxToken("]", .bracket, nestLevel: 2), SyntaxToken(")", .bracket, nestLevel: 1)])
        XCTAssertEqual(second.stack, .init())
        // The same text after other lines is another line.
        XCTAssertEqual(SyntaxHighlighter.tokenizeLine("])", grammar: .base, stack: .init()).tokens,
                       [SyntaxToken("]", .bracket, nestLevel: 1), SyntaxToken(")", .bracket, nestLevel: 1)])
        // `<` is counted though never coloured as a bracket.
        XCTAssertEqual(SyntaxHighlighter.tokenizeLine("a < (b", grammar: .base, stack: .init()).stack, .init([60, 40]))
    }

    func testFenceLanguagesFoldIntoFourGrammarsCompiledOnce() {
        XCTAssertEqual(SyntaxHighlighter.Grammar(language: "PY"), .python)
        XCTAssertEqual(SyntaxHighlighter.Grammar(language: "Python"), .python)
        XCTAssertEqual(SyntaxHighlighter.Grammar(language: "TypeScript"), .typescript)
        XCTAssertEqual(SyntaxHighlighter.Grammar(language: "ts"), .typescript)
        XCTAssertEqual(SyntaxHighlighter.Grammar(language: "Java"), .java)
        XCTAssertEqual(SyntaxHighlighter.Grammar(language: "tsx"), .base)
        XCTAssertEqual(SyntaxHighlighter.Grammar(language: "my secret project"), .base)
        for grammar in SyntaxHighlighter.Grammar.allCases {
            XCTAssertTrue(zip(grammar.patterns, grammar.patterns).allSatisfy { $0.regex === $1.regex }, "\(grammar)")
        }
    }
}

final class CodeSyntaxServiceTests: XCTestCase {
    private let later = ContinuousClock.now + .seconds(3600)

    /// A reply streaming a 120-line block, a few characters a token: each
    /// pass tokenizes the line that grew (and one a newline finished), not
    /// the block.
    func testAStreamingBlockTokenizesOnlyTheLinesThatGrew() {
        let probe = CodeSyntaxProbe()
        let service = probe.service()
        let block = code(lines: 120)
        let units = Array(block.utf16)
        var end = 0
        var passes = 0
        var wholeBlockLines = 0
        while end < units.count {
            let start = end
            end = min(units.count, end + 4)
            let prefix = String(decoding: units[..<end], as: UTF16.self)
            let before = probe.calls
            guard case .highlighted(let tokens) = service.tokens(prefix, language: "ts", until: later) else {
                return XCTFail("a far deadline highlights")
            }
            let newlines = units[start..<end].filter { $0 == 10 }.count
            XCTAssertLessThanOrEqual(probe.calls - before, newlines + 1, "pass \(passes)")
            if passes % 97 == 0 || end == units.count {
                XCTAssertEqual(tokens, SyntaxHighlighter.tokenize(prefix, language: "ts"))
            }
            passes += 1
            wholeBlockLines += prefix.jsSplit("\n").count
        }
        XCTAssertLessThanOrEqual(probe.calls, passes + 120)
        print("CodeSyntax streaming: \(passes) passes, \(probe.calls) lines tokenized (whole block each pass: \(wholeBlockLines))")
        XCTAssertGreaterThan(wholeBlockLines, probe.calls * 40)

        // Typing at the end of the last line: one line per pass.
        var typed = block
        for character in " + 1" {
            typed.append(character)
            let before = probe.calls
            _ = service.tokens(typed, language: "ts", until: later)
            XCTAssertEqual(probe.calls - before, 1)
            XCTAssertEqual(probe.tokenized.last, typed.jsSplit("\n").last)
        }
    }

    /// An edit that opens a bracket colours the lines after it anew; the
    /// lines before it are kept.
    func testAnOpenedBracketRetokenizesOnlyTheLinesAfterIt() {
        let probe = CodeSyntaxProbe()
        let service = probe.service()
        let before = "a\nb\nc)\nd]"
        _ = service.tokens(before, language: "js", until: later)
        XCTAssertEqual(probe.calls, 4)
        let after = "a\nb(\nc)\nd]"
        XCTAssertEqual(service.tokens(after, language: "js", until: later), .highlighted(SyntaxHighlighter.tokenize(after, language: "js")))
        XCTAssertEqual(Array(probe.tokenized.dropFirst(4)), ["b(", "c)"], "d] starts with nothing open either way")
    }

    /// One pass shares one deadline: what the first block spends, the
    /// second does not get; the rest is tokenized in the background, once.
    /// The background is held on its first line until the pass is counted.
    func testAPassDeadlineIsSharedAndTheRestFinishesInTheBackground() async throws {
        let probe = CodeSyntaxProbe(holdsAfter: 5)
        let service = probe.service()
        let signals = service.completions()
        let first = code(lines: 3, tag: "a")
        let second = code(lines: 4, tag: "b")
        let (a, b) = SyntaxPass.run(until: probe.at(5)) {
            (service.tokens(first, language: "ts"), service.tokens(second, language: "ts"))
        }
        XCTAssertEqual(a, .highlighted(SyntaxHighlighter.tokenize(first, language: "ts")))
        XCTAssertEqual(b, .pending)
        probe.gate?.waitUntilHeld()
        XCTAssertEqual(probe.calls, 5, "three lines, then two of four")
        XCTAssertEqual(service.queuedUsage.count, 1, "the rest of the second block, running")

        probe.gate?.open()
        let signal: Void? = try await syncPerfNext(signals)
        XCTAssertNotNil(signal)
        await service.idle()
        XCTAssertEqual(probe.calls, 7, "the background takes the two lines left, not the block")
        XCTAssertEqual(service.tokens(second, language: "ts", until: probe.at(0)), .highlighted(SyntaxHighlighter.tokenize(second, language: "ts")),
                       "cached: highlighted with no time left")
        XCTAssertEqual(probe.calls, 7)
        XCTAssertEqual(service.queuedUsage.count, 0)
    }

    func testBlocksPastTheLimitsArePlainAndNeverQueued() {
        let probe = CodeSyntaxProbe()
        let service = probe.service(queuePayloadLimit: 64 * 1024)
        let tooManyLines = Array(repeating: "x", count: DiffSyntax.maxLines + 1).joined(separator: "\n")
        let tooLongLine = String(repeating: "x", count: DiffSyntax.maxLine + 1)
        let tooManyCharacters = Array(repeating: String(repeating: "y", count: 1000), count: 129).joined(separator: "\n")
        let pastTheQueue = Array(repeating: String(repeating: "z", count: 1000), count: 40).joined(separator: "\n")
        for block in [tooManyLines, tooLongLine, tooManyCharacters, pastTheQueue] {
            XCTAssertEqual(service.tokens(block, language: "js", until: probe.at(0)), .plain)
            XCTAssertEqual(service.tokens(block, language: "js", until: later), .plain)
        }
        XCTAssertEqual(service.tokens("let x = 1", language: nil, until: later), .plain)
        XCTAssertEqual(probe.calls, 0)
        XCTAssertEqual(service.queuedUsage.count, 0)
        // Just inside: highlighted.
        let atTheLimit = Array(repeating: "x", count: DiffSyntax.maxLines).joined(separator: "\n")
        XCTAssertNotEqual(service.tokens(atTheLimit, language: "js", until: later), .plain)
    }

    /// The queue's count and bytes include the job running; a full queue
    /// drops a block, and the running job's end tells its plan to ask again.
    func testTheQueueCountsTheRunningJobAndAFullQueueStillSignals() async throws {
        let probe = CodeSyntaxProbe(holdsFirstLine: true)
        let a = code(lines: 3, tag: "a")
        let b = code(lines: 3, tag: "b")
        let c = code(lines: 3, tag: "c")
        let bytes = { (code: String) in code.utf16.count * 2 }
        let service = probe.service(queueCountLimit: 2)
        let signals = service.completions()
        XCTAssertEqual(service.tokens(a, language: "js", until: probe.at(0)), .pending)
        probe.gate?.waitUntilHeld()
        XCTAssertEqual(service.tokens(b, language: "js", until: probe.at(0)), .pending)
        XCTAssertEqual(service.tokens(a, language: "js", until: probe.at(0)), .pending)
        XCTAssertEqual(service.queuedUsage.count, 2, "a running, b queued, a again is the same job")
        XCTAssertEqual(service.queuedUsage.bytes, bytes(a) + bytes(b))
        XCTAssertEqual(service.tokens(c, language: "js", until: probe.at(0)), .pending)
        XCTAssertEqual(service.queuedUsage.count, 2, "c is dropped")

        probe.gate?.open()
        let signal: Void? = try await syncPerfNext(signals)
        XCTAssertNotNil(signal, "a's end tells c's plan to ask again")
        await service.idle()
        XCTAssertEqual(service.queuedUsage.count, 0)
        XCTAssertEqual(service.queuedUsage.bytes, 0)
        XCTAssertEqual(service.tokens(c, language: "js", until: probe.at(0)), .pending)
        await service.idle()
        XCTAssertEqual(service.tokens(c, language: "js", until: probe.at(0)), .highlighted(SyntaxHighlighter.tokenize(c, language: "js")))

        // By bytes: room for exactly a and b.
        let bytesProbe = CodeSyntaxProbe(holdsFirstLine: true)
        let tight = bytesProbe.service(queuePayloadLimit: bytes(a) + bytes(b))
        XCTAssertEqual(tight.tokens(a, language: "js", until: bytesProbe.at(0)), .pending)
        bytesProbe.gate?.waitUntilHeld()
        _ = tight.tokens(b, language: "js", until: bytesProbe.at(0))
        _ = tight.tokens(c, language: "js", until: bytesProbe.at(0))
        XCTAssertEqual(tight.queuedUsage.count, 2)
        XCTAssertEqual(tight.queuedUsage.bytes, bytes(a) + bytes(b))
        bytesProbe.gate?.open()
        await tight.idle()
    }

    /// Clearing drops the cache and the queue; the running job ends
    /// without writing, and keeps its place until it does.
    func testClearingStartsANewGenerationTheRunningJobCannotWriteInto() async throws {
        let probe = CodeSyntaxProbe(holdsFirstLine: true)
        let service = probe.service()
        let signals = service.completions()
        let a = code(lines: 3, tag: "a")
        let b = code(lines: 3, tag: "b")
        XCTAssertEqual(service.tokens(a, language: "js", until: probe.at(0)), .pending)
        probe.gate?.waitUntilHeld()
        _ = service.tokens(b, language: "js", until: probe.at(0))
        XCTAssertEqual(service.queuedUsage.count, 2)

        service.clearCache()
        let cleared: Void? = try await syncPerfNext(signals)
        XCTAssertNotNil(cleared, "pending plans ask again")
        XCTAssertEqual(service.queuedUsage.count, 1, "b dropped; a keeps its place while it runs")
        XCTAssertEqual(service.queuedUsage.bytes, a.utf16.count * 2)
        probe.gate?.open()
        await service.idle()
        XCTAssertEqual(probe.calls, 1, "a stops after the line it was on")
        XCTAssertEqual(service.retainedUsage.count, 0, "and writes nothing")
        XCTAssertEqual(service.queuedUsage.count, 0)
        XCTAssertEqual(service.queuedUsage.bytes, 0)
    }

    /// The same block asked for again after a clear is a new job, not the
    /// old one still running.
    func testABlockQueuedAgainAfterAClearIsNotTheJobStillRunning() async throws {
        let probe = CodeSyntaxProbe(holdsFirstLine: true)
        let service = probe.service()
        let a = code(lines: 3, tag: "a")
        XCTAssertEqual(service.tokens(a, language: "js", until: probe.at(0)), .pending)
        probe.gate?.waitUntilHeld()
        service.clearCache()
        XCTAssertEqual(service.tokens(a, language: "js", until: probe.at(0)), .pending)
        XCTAssertEqual(service.queuedUsage.count, 2)
        XCTAssertEqual(service.queuedUsage.bytes, a.utf16.count * 4)
        probe.gate?.open()
        await service.idle()
        XCTAssertEqual(service.queuedUsage.count, 0)
        XCTAssertEqual(service.queuedUsage.bytes, 0)
        XCTAssertEqual(service.tokens(a, language: "js", until: probe.at(0)), .highlighted(SyntaxHighlighter.tokenize(a, language: "js")))
        XCTAssertEqual(probe.calls, 4, "one line of the old job, three of the new")
    }

    /// A block dropped while a job from before a clear holds the queue is
    /// asked for again when that job ends, though it wrote nothing.
    func testAStaleJobsEndStillSignals() async throws {
        let probe = CodeSyntaxProbe(holdsFirstLine: true)
        let service = probe.service(queueCountLimit: 1)
        let signals = service.completions()
        let a = code(lines: 3, tag: "a")
        let b = code(lines: 3, tag: "b")
        XCTAssertEqual(service.tokens(a, language: "js", until: probe.at(0)), .pending)
        probe.gate?.waitUntilHeld()
        service.clearCache()
        let cleared: Void? = try await syncPerfNext(signals)
        XCTAssertNotNil(cleared)
        XCTAssertEqual(service.tokens(b, language: "js", until: probe.at(0)), .pending)
        XCTAssertEqual(service.queuedUsage.count, 1, "b is dropped: a still runs")
        probe.gate?.open()
        let ended: Void? = try await syncPerfNext(signals)
        XCTAssertNotNil(ended, "a's end tells b's plan to ask again")
        await service.idle()
        XCTAssertEqual(service.tokens(b, language: "js", until: probe.at(0)), .pending)
        await service.idle()
        XCTAssertEqual(service.tokens(b, language: "js", until: probe.at(0)), .highlighted(SyntaxHighlighter.tokenize(b, language: "js")))
    }

    /// Closing empties everything for good: listeners finish, every
    /// answer is plain, and a job running across it writes nothing.
    func testClosingDropsWorkFinishingAfterItAndAnswersPlain() async throws {
        let probe = CodeSyntaxProbe()
        let service = probe.service()
        let signals = service.completions()
        let kept = code(lines: 2, tag: "kept")
        _ = service.tokens(kept, language: "js", until: later)
        XCTAssertEqual(service.retainedUsage.count, 2)
        service.close()
        XCTAssertTrue(service.isClosed)
        XCTAssertEqual(service.retainedUsage.count, 0)
        let ended: Void? = try await syncPerfNext(signals)
        XCTAssertNil(ended, "listeners finish")
        XCTAssertEqual(service.tokens(kept, language: "js", until: later), .plain)
        XCTAssertEqual(probe.calls, 2)
        let late: Void? = try await syncPerfNext(service.completions())
        XCTAssertNil(late)

        let held = CodeSyntaxProbe(holdsFirstLine: true)
        let closing = held.service()
        let a = code(lines: 3, tag: "a")
        XCTAssertEqual(closing.tokens(a, language: "js", until: held.at(0)), .pending)
        held.gate?.waitUntilHeld()
        closing.close()
        held.gate?.open()
        await closing.idle()
        XCTAssertEqual(held.calls, 1, "the line already running, nothing after")
        XCTAssertEqual(closing.retainedUsage.count, 0, "and it is dropped")
        XCTAssertEqual(closing.queuedUsage.count, 0)
        XCTAssertEqual(closing.queuedUsage.bytes, 0)
    }

    func testTheLineCacheEvictsTheLeastRecentlyReadByCountAndWeight() {
        func key(_ text: String) -> CodeLineKey { CodeLineKey(grammar: .base, text: text, stack: .init()) }
        let line = SyntaxHighlighter.Line(tokens: [], stack: .init())
        var cache = CodeLineCache(countLimit: 3, weightLimit: 100)
        for text in ["a", "b", "c"] { cache.set(key(text), line, weight: 10) }
        XCTAssertNotNil(cache.get(key("a")))
        cache.set(key("d"), line, weight: 10)
        XCTAssertNil(cache.get(key("b")), "b was read least recently")
        XCTAssertNotNil(cache.get(key("a")))
        XCTAssertEqual(cache.count, 3)
        XCTAssertEqual(cache.weight, 30)
        cache.set(key("heavy"), line, weight: 85)
        XCTAssertEqual(cache.weight, 95, "c and d go; a was read last")
        XCTAssertEqual(cache.count, 2)
        XCTAssertNil(cache.get(key("c")))
        XCTAssertNil(cache.get(key("d")))
        cache.set(key("too heavy"), line, weight: 101)
        XCTAssertNil(cache.get(key("too heavy")))
        XCTAssertNotNil(cache.get(key("heavy")))
        cache.set(key("heavy"), line, weight: 5)
        XCTAssertEqual(cache.weight, 15, "replacing a line replaces its weight")
        cache.removeAll()
        XCTAssertEqual(cache.count, 0)
        XCTAssertEqual(cache.weight, 0)
        for index in 0..<1000 { cache.set(key("\(index)"), line, weight: 1) }
        XCTAssertEqual(cache.count, 3)
        XCTAssertNotNil(cache.get(key("999")))
    }

    func testTheServiceBoundsWhatItKeeps() {
        let probe = CodeSyntaxProbe()
        let service = probe.service(lineCountLimit: 50)
        _ = service.tokens(code(lines: 80), language: "ts", until: later)
        XCTAssertEqual(service.retainedUsage.count, 50)
        let weighed = probe.service(payloadLimit: 4096)
        _ = weighed.tokens(code(lines: 80), language: "ts", until: later)
        XCTAssertLessThanOrEqual(weighed.retainedUsage.bytes, 4096)
        XCTAssertGreaterThan(weighed.retainedUsage.count, 0)
    }
}

