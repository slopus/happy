#if canImport(UIKit)
import HappyCore
import HappyLayout
import os
import UIKit

/// Keeps a `DocumentTextView` and a `DocumentEditor` saying the same thing
/// (docs/DOCUMENT-EDITOR.md).
///
/// Typing goes into the text view as UIKit puts it there (so autocorrect,
/// dictation and marked text work as they do anywhere), then the paragraphs
/// it touched are read back into the editor, which writes the difference
/// to the document. Enter, Backspace at a line's start, the formatting bar
/// and Markdown shortcuts are edits on the lines (`DocumentEdits`) instead.
/// Whatever changes the lines (those edits, or a change from elsewhere)
/// comes back as a `DocumentLinesChange`, and only those paragraphs are
/// built again and replaced. A change from elsewhere holds the selection
/// in place by relative positions, as y-prosemirror does.
@MainActor
final class DocumentTextController: NSObject, UITextViewDelegate, @preconcurrency NSTextStorageDelegate, UIGestureRecognizerDelegate {
    let textView: DocumentTextView
    private(set) var editor: DocumentEditor
    private var style: DocumentStyle
    /// The lines as the text view shows them, where each starts, and by ID.
    private(set) var lines: [DocumentLine] = []
    private var starts: [Int] = [0]
    private var index: [String: Int] = [:]
    /// Storage changes made here, not by the person.
    private var applying = false
    /// The person's changes since the last read back: the edited range in
    /// the text as it is now, and how much longer it got.
    private var edited: (range: NSRange, delta: Int)?
    /// Reading the person's typing back: the echo needs no new paragraphs.
    private var readingBack = false
    /// What the last change typed, for the shortcuts.
    private var typed: String?
    private var heldRemote: [[UInt8]] = []
    var editable = true { didSet { textView.isEditable = editable } }
    /// The selection changed, or the text under it: the toolbar and presence follow.
    var onSelection: (() -> Void)?
    /// Something to ask the person: a link's address.
    var onLink: ((String?, @escaping (String?) -> Void) -> Void)?
    /// Main-thread time spent per change, for the latency numbers.
    private(set) var lastApply: Duration = .zero
    /// The editor's own share of a keystroke: reading it back and writing it to the document.
    private(set) var lastTyping: Duration = .zero
    static let signposts = OSSignposter(subsystem: "engineering.happy", category: "Document")

    init(textView: DocumentTextView, editor: DocumentEditor, style: DocumentStyle) {
        self.textView = textView
        self.editor = editor
        self.style = style
        super.init()
        textView.delegate = self
        textView.textStorage.delegate = self
        textView.numberFont = style.numberFont
        textView.onBackspace = { [weak self] in self?.backspace() ?? false }
        textView.onTool = { [weak self] in self?.run($0) }
        textView.onStyle = { [weak self] in self?.setStyle($0) }
        textView.onHardBreak = { [weak self] in self?.textView.insertText(String(DocumentText.lineBreak)) }
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.delegate = self
        textView.addGestureRecognizer(tap)
    }

    /// The editor and its text, built off the main thread (`DocumentStyle.document`).
    func install(_ editor: DocumentEditor, text: NSAttributedString) {
        let selection = textView.selectedRange
        self.editor = editor
        editor.onLinesChange = { [weak self] change in self?.linesChanged(change) }
        applying = true
        textView.textStorage.setAttributedString(text)
        applying = false
        mirror(editor.lines)
        if textView.textStorage.length == 0 { ensureALine() }
        let length = textView.textStorage.length
        textView.selectedRange = NSRange(location: min(selection.location, max(0, length - 1)), length: 0)
        loadPictures(in: 0..<lines.count)
    }

    func restyle(_ style: DocumentStyle) {
        self.style = style
        textView.numberFont = style.numberFont
        install(editor, text: style.document(editor.lines))
    }

    private func mirror(_ next: [DocumentLine]) {
        lines = next
        starts = DocumentText.starts(next)
        var byID: [String: Int] = [:]
        byID.reserveCapacity(next.count)
        for (i, line) in next.enumerated() { byID[line.id] = i }
        index = byID
    }

    /// A document with no blocks still has a line to type in.
    private func ensureALine() {
        let line = DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "paragraph", content: .inline([])))
        editor.replaceLines(0..<lines.count, with: [line])
    }

    // MARK: Carets

    func caret(at offset: Int) -> DocumentCaret? {
        guard !lines.isEmpty else { return nil }
        let (line, inside) = DocumentText.locate(offset, starts: starts)
        return DocumentCaret(id: lines[line].id, offset: inside)
    }

    func offset(_ caret: DocumentCaret) -> Int? {
        guard let i = index[caret.id] else { return nil }
        return starts[i] + min(caret.offset, lines[i].length)
    }

    var selectionCarets: (anchor: DocumentCaret, head: DocumentCaret)? {
        let range = textView.selectedRange
        guard let anchor = caret(at: range.location), let head = caret(at: range.location + range.length) else { return nil }
        return (anchor, head)
    }

    /// The lines the selection touches.
    var selectedLines: Range<Int> {
        guard !lines.isEmpty else { return 0..<0 }
        let range = textView.selectedRange
        let first = DocumentText.locate(range.location, starts: starts).line
        let last = DocumentText.locate(max(range.location, range.location + range.length - (range.length > 0 ? 1 : 0)), starts: starts).line
        return first..<(last + 1)
    }

    private func place(line: Int, offset: Int) {
        guard lines.indices.contains(line) else { return }
        textView.selectedRange = NSRange(location: starts[line] + min(offset, lines[line].length), length: 0)
    }

    // MARK: Changes from the lines

    private func linesChanged(_ change: DocumentLinesChange) {
        let state = Self.signposts.beginInterval("apply", "\(change.lines.count) lines")
        let clock = ContinuousClock.now
        defer {
            lastApply = ContinuousClock.now - clock
            Self.signposts.endInterval("apply", state)
        }
        let storage = textView.textStorage
        let selection = textView.selectedRange
        applying = true
        storage.beginEditing()
        if readingBack {
            // The text view already holds the typing; only what it can't
            // know (a new ID, a number, a neighbour's spacing) is built again.
            mirror(editor.lines)
            let upper = min(lines.count, change.range.lowerBound + change.lines.count + 1)
            for i in change.range.lowerBound..<upper { refresh(i) }
        } else {
            let old = NSRange(location: starts[change.range.lowerBound], length: starts[change.range.upperBound] - starts[change.range.lowerBound])
            let previous = change.range.lowerBound > 0 ? lines[change.range.lowerBound - 1] : nil
            let built = NSMutableAttributedString()
            var before = previous
            for line in change.lines {
                built.append(style.paragraph(line, previous: before))
                before = line
            }
            storage.replaceCharacters(in: old, with: built)
            mirror(editor.lines)
            let next = change.range.lowerBound + change.lines.count
            if next < lines.count { refresh(next) }
        }
        storage.endEditing()
        applying = false
        if readingBack { textView.selectedRange = selection }
        loadPictures(in: change.range.lowerBound..<min(lines.count, change.range.lowerBound + change.lines.count))
        onSelection?()
    }

    /// Builds one line again and puts it in only if it differs from what shows.
    private func refresh(_ i: Int) {
        let storage = textView.textStorage
        let range = NSRange(location: starts[i], length: starts[i + 1] - starts[i])
        guard range.upperBound <= storage.length else { return }
        let built = style.paragraph(lines[i], previous: i > 0 ? lines[i - 1] : nil)
        if !storage.attributedSubstring(from: range).isEqual(to: built) {
            storage.replaceCharacters(in: range, with: built)
        }
    }

    /// A change from elsewhere: merged, the selection held where it was.
    func applyRemote(_ update: [UInt8]) {
        dispatchPrecondition(condition: .onQueue(.main))
        // Never under the person's composing: it waits for the word to land.
        if textView.markedTextRange != nil || edited != nil {
            heldRemote.append(update)
            return
        }
        let carets = selectionCarets
        let anchor = carets.flatMap { editor.relativePosition($0.anchor) }
        let head = carets.flatMap { editor.relativePosition($0.head) }
        try? editor.apply(remote: update)
        if let anchor, let head, let a = editor.caret(anchor).flatMap(offset), let h = editor.caret(head).flatMap(offset) {
            textView.selectedRange = NSRange(location: min(a, h), length: abs(h - a))
        }
    }

    private func releaseHeld() {
        guard !heldRemote.isEmpty, textView.markedTextRange == nil, edited == nil else { return }
        let held = heldRemote
        heldRemote = []
        for update in held { applyRemote(update) }
    }

    // MARK: The person's typing

    func textStorage(_ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorage.EditActions, range editedRange: NSRange, changeInLength delta: Int) {
        guard !applying, editedMask.contains(.editedCharacters) else { return }
        if let previous = edited {
            // Old edits shift with this one; the union covers both.
            let start = min(previous.range.location, editedRange.location)
            let previousEnd = previous.range.upperBound + (previous.range.upperBound > editedRange.location ? delta : 0)
            let end = max(previousEnd, editedRange.upperBound)
            edited = (NSRange(location: start, length: end - start), previous.delta + delta)
        } else {
            edited = (editedRange, delta)
        }
    }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        guard editable else { return false }
        typed = text
        guard textView.markedTextRange == nil, !lines.isEmpty else { return true }
        if text == "\n", range.length == 0 {
            let (line, offset) = DocumentText.locate(range.location, starts: starts)
            if lines[line].block.type == "codeBlock" {
                // A code block keeps its newlines; three Enters at its end leave it, as in BlockNote.
                let text = lines[line].block.plainText
                if offset == lines[line].length, text.hasSuffix("\n\n") {
                    var trimmed = lines[line]
                    trimmed.block.content = .inline(DocumentEdits.slice(trimmed.block.runs, 0..<(trimmed.length - 2)))
                    let next = DocumentEdits.Result(range: line..<(line + 1), lines: [trimmed, DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "paragraph", content: .inline([])), depth: trimmed.depth)], caretLine: line + 1, caretOffset: 0)
                    perform(next)
                    return false
                }
                textView.insertText(String(DocumentText.lineBreak))
                return false
            }
            if let result = DocumentEdits.enter(lines, at: line, offset: offset) { perform(result) }
            return false
        }
        return true
    }

    func textViewDidChange(_ textView: UITextView) {
        guard textView.markedTextRange == nil else { return }
        let state = Self.signposts.beginInterval("typing")
        let clock = ContinuousClock.now
        readBack()
        releaseHeld()
        lastTyping = ContinuousClock.now - clock
        Self.signposts.endInterval("typing", state)
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        onSelection?()
    }

    /// The paragraphs the person changed, read back into the lines.
    private func readBack() {
        guard let (range, delta) = edited else { return }
        edited = nil
        let storage = textView.textStorage
        let string = storage.string as NSString
        // A text whose last "\n" was removed gets it back.
        if storage.length == 0 || string.character(at: storage.length - 1) != 0x0A {
            applying = true
            let attributes = storage.length > 0 ? storage.attributes(at: storage.length - 1, effectiveRange: nil) : [:]
            storage.append(NSAttributedString(string: "\n", attributes: attributes))
            applying = false
        }
        let oldEnd = range.upperBound - delta
        let first = DocumentText.locate(min(range.location, max(0, starts.last! - 1)), starts: starts).line
        let last = DocumentText.locate(max(range.location, min(oldEnd, starts.last! - 1)), starts: starts).line
        let newStart = starts[first]
        let newEnd = min(storage.length, starts[last + 1] + delta)
        guard newEnd >= newStart else { return }
        var read: [DocumentLine] = []
        var seen = Set<String>()
        var position = newStart
        while position < newEnd {
            let paragraph = string.paragraphRange(for: NSRange(location: position, length: 0))
            let body = NSRange(location: paragraph.location, length: max(0, paragraph.length - 1))
            // Which line this is: its first character's, unless that came
            // from outside the edited lines (typing into an empty line takes
            // the attributes of the line before), then its "\n"'s. The
            // attribute can be older than the line, so the line as it is now wins.
            let infos = [paragraph.location, paragraph.upperBound - 1].map { storage.attribute(.documentLine, at: $0, effectiveRange: nil) as? DocumentLineInfo }
            let info = infos.compactMap { $0 }.first { info in index[info.line.id].map { (first...last).contains($0) } == true && !seen.contains(info.line.id) } ?? infos.last ?? nil
            var line = info.map { info in index[info.line.id].map { lines[$0] } ?? info.line } ?? DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "paragraph", content: .inline([])))
            let text = string.substring(with: body)
            if !line.block.isInline {
                if text != String(DocumentText.object) {
                    // Typed beside a divider or picture: the text is a paragraph of its own.
                    let runs = DocumentStyle.runs(storage, body).compactMap { run -> DocumentRun? in
                        let kept = run.text.replacingOccurrences(of: String(DocumentText.object), with: "")
                        return kept.isEmpty ? nil : DocumentRun(kept, marks: run.marks)
                    }
                    if text.contains(DocumentText.object) { read.append(line); seen.insert(line.id) }
                    line = DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "paragraph", content: .inline(runs)), depth: line.depth)
                }
            } else {
                line.block.content = .inline(DocumentStyle.runs(storage, body).map {
                    DocumentRun($0.text.replacingOccurrences(of: String(DocumentText.object), with: ""), marks: $0.marks)
                }.filter { !$0.text.isEmpty })
            }
            if seen.contains(line.id) || index[line.id].map({ !(first...last).contains($0) }) == true {
                // A paragraph split by pasted text: the second half is a new block.
                line.block.id = DocumentEditor.newID()
                line.block.props = line.block.props.filter { $0.key != "checked" }
            }
            seen.insert(line.id)
            read.append(line)
            position = paragraph.upperBound
        }
        readingBack = true
        let replaced = first..<(last + 1)
        if replaced.count == 1, read.count == 1, read[0].id == lines[first].id, read[0].block.type == lines[first].block.type {
            editor.setRuns(read[0].id, read[0].block.runs)
        } else {
            editor.replaceLines(replaced, with: read)
        }
        readingBack = false
        if lines.isEmpty { ensureALine() }
        shortcuts()
    }

    /// Markdown typed, made what it means.
    private func shortcuts() {
        guard let typed, typed.utf16.count == 1, textView.selectedRange.length == 0 else { return }
        self.typed = nil
        let offset = textView.selectedRange.location
        let (i, caret) = DocumentText.locate(offset, starts: starts)
        let line = lines[i]
        if let block = DocumentShortcuts.block(line, caret: caret) {
            switch block {
            case .divider:
                perform(DocumentEdits.divider(lines, replacing: i))
            case let .type(type, props, remove):
                var made = DocumentEdits.retype(line, type, props: props)
                made.block.content = .inline(DocumentEdits.slice(line.block.runs, remove..<line.length))
                perform(DocumentEdits.Result(range: i..<(i + 1), lines: [made], caretLine: i, caretOffset: max(0, caret - remove)))
            }
            return
        }
        if ["*", "_", "~", "`"].contains(typed), line.block.type != "codeBlock", let inline = DocumentShortcuts.inline(line.block.runs, caret: caret) {
            editor.setRuns(line.id, inline.runs)
            place(line: i, offset: inline.caret)
            // The next character typed doesn't continue the format.
            setTyping(DocumentEdits.marks(inline.runs, at: inline.caret).filter { $0.key == "textColor" || $0.key == "backgroundColor" }, line: i)
        }
    }

    /// An edit on the lines, and the caret where it says.
    func perform(_ result: DocumentEdits.Result) {
        editor.replaceLines(result.range, with: result.lines)
        if lines.isEmpty { ensureALine() }
        let i = min(result.caretLine, lines.count - 1)
        place(line: i, offset: result.caretOffset)
        // What's typed next is drawn as this line is, not as the one the caret came from.
        if lines[i].block.isInline { setTyping(DocumentEdits.marks(lines[i].block.runs, at: result.caretOffset), line: i) }
    }

    private func backspace() -> Bool {
        guard editable, !lines.isEmpty else { return false }
        readBack()
        let (i, offset) = DocumentText.locate(textView.selectedRange.location, starts: starts)
        guard offset == 0, let result = DocumentEdits.backspaceAtStart(lines, at: i) else { return false }
        perform(result)
        return true
    }

    // MARK: Tasks

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        guard let id = textView.task(at: recognizer.location(in: textView)) else { return }
        toggle(id)
    }

    func toggle(_ id: String) {
        guard editable else { return }
        readBack()
        let selection = textView.selectedRange
        editor.toggleChecked(id)
        textView.selectedRange = selection
        UIAccessibility.post(notification: .announcement, argument: editor.line(id)?.block.checked == true ? Strings.Documents.taskDone : Strings.Documents.notDone)
    }

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        editable && textView.task(at: recognizer.location(in: textView)) != nil
    }

    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        true
    }

    // MARK: The formatting bar

    /// What the selection has, for the bar's lit buttons.
    var activeTools: Set<DocumentTool> {
        guard !lines.isEmpty else { return [] }
        var out: Set<DocumentTool> = []
        let range = textView.selectedRange
        let picked = selectedLines
        let line = lines[picked.lowerBound]
        if range.length == 0 {
            let marks = (textView.typingAttributes[.documentMarks] as? DocumentMarks)?.marks ?? [:]
            for (tool, mark) in Self.markTools where marks[mark] != nil { out.insert(tool) }
        } else {
            for (tool, mark) in Self.markTools where picked.allSatisfy({ i in
                let local = localRange(i)
                return local.isEmpty || DocumentEdits.has(lines[i].block.runs, mark, in: local)
            }) { out.insert(tool) }
        }
        for (tool, type) in Self.blockTools where line.block.type == type { out.insert(tool) }
        return out
    }

    static let markTools: [(DocumentTool, String)] = [(.bold, "bold"), (.italic, "italic"), (.strike, "strike"), (.code, "code"), (.link, "link")]
    static let blockTools: [(DocumentTool, String)] = [(.bullets, "bulletListItem"), (.numbers, "numberedListItem"), (.checklist, "checkListItem"), (.quote, "quote"), (.codeBlock, "codeBlock")]

    /// The selection within line `i`, in its own offsets.
    private func localRange(_ i: Int) -> Range<Int> {
        let range = textView.selectedRange
        let lower = max(range.location, starts[i]) - starts[i]
        let upper = min(range.location + range.length, starts[i] + lines[i].length) - starts[i]
        return lower..<max(lower, upper)
    }

    func run(_ tool: DocumentTool) {
        guard editable, !lines.isEmpty else { return }
        readBack()
        switch tool {
        case .style: break
        case .bold: toggleMark("bold")
        case .italic: toggleMark("italic")
        case .strike: toggleMark("strike")
        case .code: toggleMark("code")
        case .link: link()
        case .bullets: toggleBlock("bulletListItem")
        case .numbers: toggleBlock("numberedListItem")
        case .checklist: toggleBlock("checkListItem")
        case .quote: toggleBlock("quote")
        case .codeBlock: toggleBlock("codeBlock")
        case .indent, .outdent:
            let picked = selectedLines
            let caret = localRange(picked.lowerBound).lowerBound
            let result = tool == .indent ? DocumentEdits.indent(lines, picked, caret: caret) : DocumentEdits.outdent(lines, picked, caret: caret)
            if let result {
                let selection = textView.selectedRange
                let before = starts[picked.lowerBound]
                editor.replaceLines(result.range, with: result.lines)
                textView.selectedRange = NSRange(location: selection.location - before + starts[picked.lowerBound], length: selection.length)
            }
        case .divider:
            let i = selectedLines.lowerBound
            if lines[i].block.isInline, lines[i].length == 0 {
                perform(DocumentEdits.divider(lines, replacing: i))
            } else {
                let divider = DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "divider", content: .none), depth: lines[i].depth)
                let next = DocumentLine(block: DocumentBlock(id: DocumentEditor.newID(), type: "paragraph", content: .inline([])), depth: lines[i].depth)
                perform(DocumentEdits.Result(range: (i + 1)..<(i + 1), lines: [divider, next], caretLine: i + 2, caretOffset: 0))
            }
        }
        onSelection?()
    }

    /// What the next character typed carries: these formats, drawn as line `i` draws them.
    private func setTyping(_ marks: [String: YAny], line i: Int) {
        let sample = style.paragraph(DocumentLine(block: DocumentBlock(id: lines[i].id, type: lines[i].block.type, props: lines[i].block.props, content: .inline([DocumentRun("x", marks: marks)])), depth: lines[i].depth), previous: i > 0 ? lines[i - 1] : nil)
        var attributes = sample.attributes(at: 0, effectiveRange: nil)
        if starts[i] < textView.textStorage.length { attributes[.documentLine] = textView.textStorage.attribute(.documentLine, at: starts[i], effectiveRange: nil) }
        textView.typingAttributes = attributes
    }

    private func toggleMark(_ mark: String) {
        let range = textView.selectedRange
        if range.length == 0 {
            var marks = (textView.typingAttributes[.documentMarks] as? DocumentMarks)?.marks ?? [:]
            marks[mark] = marks[mark] == nil ? .object([]) : nil
            setTyping(marks, line: selectedLines.lowerBound)
            return
        }
        let picked = selectedLines
        let on = !picked.allSatisfy { i in
            let local = localRange(i)
            return local.isEmpty || DocumentEdits.has(lines[i].block.runs, mark, in: local)
        }
        editor.doc.transact { _ in
            for i in picked where lines[i].block.isInline && lines[i].block.type != "codeBlock" {
                let local = localRange(i)
                guard !local.isEmpty else { continue }
                editor.setRuns(lines[i].id, DocumentEdits.setting(lines[i].block.runs, mark, on ? .object([]) : nil, in: local))
            }
        }
        textView.selectedRange = range
    }

    private func toggleBlock(_ type: String, props: [String: YAny] = [:]) {
        let picked = selectedLines
        let selection = textView.selectedRange
        let first = starts[picked.lowerBound]
        let all = picked.allSatisfy { i in lines[i].block.type == type && (props.isEmpty || props.allSatisfy { key, value in lines[i].block.props[key] == value }) }
        let next = picked.map { i -> DocumentLine in
            guard lines[i].block.isInline || type == "paragraph" else { return lines[i] }
            return DocumentEdits.retype(lines[i], all ? "paragraph" : type, props: all ? [:] : props)
        }
        editor.replaceLines(picked, with: next)
        textView.selectedRange = NSRange(location: selection.location - first + starts[picked.lowerBound], length: selection.length)
    }

    func setStyle(_ level: Int) {
        guard editable, !lines.isEmpty else { return }
        readBack()
        if level == 0 { toggleBlock("paragraph") } else { toggleBlock("heading", props: ["level": .number(Double(level))]) }
        onSelection?()
    }

    private func link() {
        let range = textView.selectedRange
        let i = selectedLines.lowerBound
        let local = localRange(i)
        let current = DocumentEdits.slice(lines[i].block.runs, local.isEmpty ? max(0, local.lowerBound - 1)..<local.lowerBound : local).first?.marks["link"]?["href"]?.stringValue
        onLink?(current) { [weak self] href in
            guard let self, self.lines.indices.contains(i) else { return }
            let value: YAny? = href.flatMap { $0.isEmpty ? nil : .object([("href", .string($0))]) }
            if local.isEmpty {
                guard let href, !href.isEmpty, value != nil else { return }
                var marks = DocumentEdits.marks(self.lines[i].block.runs, at: local.lowerBound)
                marks["link"] = value
                self.editor.setRuns(self.lines[i].id, DocumentEdits.typing(self.lines[i].block.runs, href, replacing: local, marks: marks))
                self.place(line: i, offset: local.lowerBound + href.utf16.count)
            } else {
                self.editor.setRuns(self.lines[i].id, DocumentEdits.setting(self.lines[i].block.runs, "link", value, in: local))
                self.textView.selectedRange = range
            }
        }
    }

    // MARK: Pictures

    var loadPicture: ((String) async -> UIImage?)?
    private var picturesLoading: Set<String> = []

    private func loadPictures(in range: Range<Int>) {
        guard let loadPicture else { return }
        for i in range where lines.indices.contains(i) && lines[i].block.type == "image" {
            guard let url = lines[i].block.props["url"]?.stringValue, !url.isEmpty,
                  DocumentObjectAttachment.pictures.object(forKey: url as NSString) == nil, !picturesLoading.contains(url) else { continue }
            picturesLoading.insert(url)
            Task { [weak self] in
                let image = await loadPicture(url)
                guard let self else { return }
                self.picturesLoading.remove(url)
                guard let image else { return }
                DocumentObjectAttachment.pictures.setObject(image, forKey: url as NSString)
                for (j, line) in self.lines.enumerated() where line.block.props["url"]?.stringValue == url {
                    self.applying = true
                    self.refresh(j)
                    self.applying = false
                }
            }
        }
    }
}
#endif
