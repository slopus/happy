package com.slopus.happy.ui.documents

import android.os.SystemClock
import android.text.Editable
import android.text.Selection
import android.text.Spanned
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.InputMethodManager
import com.slopus.happy.documents.DocumentBlock
import com.slopus.happy.documents.DocumentCaret
import com.slopus.happy.documents.DocumentEditor
import com.slopus.happy.documents.DocumentEdits
import com.slopus.happy.documents.DocumentLine
import com.slopus.happy.documents.DocumentLinesChange
import com.slopus.happy.documents.DocumentPeer
import com.slopus.happy.documents.DocumentRun
import com.slopus.happy.documents.DocumentShortcuts
import com.slopus.happy.documents.DocumentText
import com.slopus.happy.documents.yjs.YAny

/** The formatting bar's tools (iOS's `DocumentTool`). */
enum class DocumentTool { Bold, Italic, Strike, Code, Link, Bullets, Numbers, Checklist, Quote, CodeBlock, Outdent, Indent, Divider }

/**
 * Keeps a [DocumentTextView] and a [DocumentEditor] saying the same thing
 * (iOS's `DocumentTextController`, docs/DOCUMENT-EDITOR.md).
 *
 * Typing goes into the text view as the keyboard puts it there (so
 * composing, autocorrect and voice typing work as they do anywhere), then
 * the paragraphs it touched are read back into the editor, which writes
 * the difference to the document. Only their spans are set again: the
 * characters, and the word the keyboard is composing, stay. Enter,
 * Backspace at a line's start, the formatting bar and Markdown shortcuts
 * are edits on the lines ([DocumentEdits]) instead. Whatever changes the
 * lines (those edits, or a change from elsewhere) comes back as a
 * [DocumentLinesChange], and only those paragraphs are built again and
 * replaced. A change from elsewhere holds the selection in place by
 * relative positions, as y-prosemirror does. Main thread only.
 */
class DocumentTextController(
    val textView: DocumentTextView,
    editor: DocumentEditor,
    private var style: DocumentStyle,
) : TextWatcher {
    var editor: DocumentEditor = editor
        private set
    /** The lines as the text view shows them, where each starts, and by ID. */
    var lines: List<DocumentLine> = emptyList()
        private set
    private var starts = intArrayOf(0)
    private val index = HashMap<String, Int>()
    /** The person's changes since the last read back: the edited range in the text as it is now, and how much longer it got. */
    private var edited: Pair<IntRange, Int>? = null
    private var readingBack = false
    /** What the last change typed, for the shortcuts. */
    private var typed: String? = null
    /** Formats toggled with nothing selected, for what is typed next at [pendingAt]. */
    private var pending: Map<String, YAny>? = null
    private var pendingAt = -1
    var editable = true
        set(value) {
            field = value
            textView.isFocusableInTouchMode = value
            textView.isCursorVisible = value
            textView.showSoftInputOnFocus = value
        }

    /** The selection changed, or the text under it: the bar and presence follow. */
    var onSelection: (() -> Unit)? = null
    /** Something to ask the person: a link's address, then what they said (null to remove it). */
    var onLink: ((String?, (String?) -> Unit) -> Unit)? = null
    /** Main-thread nanoseconds the last change took to show, and the editor's share of the last keystroke. */
    var lastApply = 0L
        private set
    var lastTyping = 0L
        private set

    private val text: Editable get() = textView.text

    /** The other editors, and until when each one's name shows (3 s after they last moved). */
    private var peers: List<DocumentPeer> = emptyList()
    private val labelUntil = HashMap<String, Long>()
    private val hideLabels = Runnable { drawCursors() }

    init {
        textView.addTextChangedListener(this)
        textView.onEnter = { enter(it) }
        textView.onBackspaceAtStart = { backspace(it) }
        textView.onTask = { toggle(it) }
        textView.onKey = { code, event -> key(code, event) }
        textView.onSelectionChange = { onSelection?.invoke() }
        textView.onWidth = { width ->
            style.textWidth = width
        }
        textView.accessibilityDelegate = null
    }

    /** The editor and its text, built off the main thread ([DocumentStyle.document]). */
    fun install(editor: DocumentEditor, built: CharSequence, style: DocumentStyle = this.style) {
        val selection = textView.selectionStart.coerceAtLeast(0)
        if (style !== this.style) {
            style.textWidth = this.style.textWidth
            this.style = style
        }
        this.editor.onLinesChange = null
        this.editor = editor
        editor.onLinesChange = { linesChanged(it) }
        apply { textView.setText(built, android.widget.TextView.BufferType.EDITABLE) }
        mirror(editor.lines)
        if (text.isEmpty()) ensureALine()
        textView.setSelection(minOf(selection, maxOf(0, text.length - 1)))
        drawCursors()
        loadPictures(lines.indices)
    }

    fun restyle(style: DocumentStyle) {
        style.textWidth = this.style.textWidth
        this.style = style
        install(editor, style.document(editor.lines))
    }

    private inline fun apply(block: () -> Unit) {
        val was = textView.applying
        textView.applying = true
        try {
            block()
        } finally {
            textView.applying = was
        }
    }

    private fun mirror(next: List<DocumentLine>) {
        lines = next
        starts = DocumentText.starts(next)
        index.clear()
        next.forEachIndexed { i, line -> index[line.id] = i }
    }

    /** A document with no blocks still has a line to type in. */
    private fun ensureALine() {
        val line = DocumentLine(DocumentBlock(DocumentEditor.newID(), "paragraph", content = DocumentBlock.Content.Inline(emptyList())))
        editor.replaceLines(0 until lines.size, listOf(line))
    }

    // Others' carets

    /** Who else is editing: their carets drawn where their relative positions are, a name for 3 s after its editor moves. */
    fun showPeers(next: List<DocumentPeer>) {
        if (next == peers) return
        val now = SystemClock.uptimeMillis()
        for (peer in next) if (peers.firstOrNull { it.key == peer.key } != peer) labelUntil[peer.key] = now + DocumentPeersSpec.LABEL_MILLIS
        labelUntil.keys.retainAll(next.mapTo(HashSet()) { it.key })
        peers = next
        drawCursors()
        textView.removeCallbacks(hideLabels)
        textView.postDelayed(hideLabels, DocumentPeersSpec.LABEL_MILLIS + 100)
    }

    /** The carets again, for the text as it is now. */
    private fun drawCursors() {
        if (peers.isEmpty() && textView.cursors.isEmpty()) return
        val now = SystemClock.uptimeMillis()
        textView.cursors = peers.mapNotNull { peer ->
            val at = peer.head?.let(editor::caret)?.let(::offset) ?: return@mapNotNull null
            DocumentCursor(peer.key, at, peerColorInt(peer.color), peer.name, (labelUntil[peer.key] ?: 0L) > now)
        }
    }

    // Pictures

    /** Reads a picture's address into [DocumentPictures], then calls back on the main thread if it could. */
    var loadPicture: ((url: String, done: () -> Unit) -> Unit)? = null
    private val picturesLoading = HashSet<String>()

    /** The pictures among [range] not read yet are asked for; each line showing one is built again once it is. */
    private fun loadPictures(range: IntRange) {
        val load = loadPicture ?: return
        for (i in range) {
            val line = lines.getOrNull(i) ?: continue
            if (line.block.type != "image") continue
            val url = line.block.props["url"]?.stringValue?.takeIf { it.isNotEmpty() } ?: continue
            if (DocumentPictures.cached(url) != null || !picturesLoading.add(url)) continue
            load(url) {
                picturesLoading.remove(url)
                for ((j, shown) in lines.withIndex()) if (shown.block.props["url"]?.stringValue == url) refresh(j)
            }
        }
    }

    /** One line's paragraph styled again in place: its characters stay. */
    private fun refresh(i: Int) {
        if (i !in lines.indices || starts[i + 1] > text.length) return
        apply {
            style.clear(text, starts[i], starts[i + 1])
            style.style(text, starts[i], lines[i], lines.getOrNull(i - 1))
        }
    }

    // Carets

    fun caret(offset: Int): DocumentCaret? {
        if (lines.isEmpty()) return null
        val (line, inside) = DocumentText.locate(offset, starts)
        return DocumentCaret(lines[line].id, inside)
    }

    fun offset(caret: DocumentCaret): Int? {
        val i = index[caret.id] ?: return null
        return starts[i] + minOf(caret.offset, lines[i].length)
    }

    val selectionCarets: Pair<DocumentCaret, DocumentCaret>?
        get() {
            val a = textView.selectionStart
            val b = textView.selectionEnd
            if (a < 0 || b < 0) return null
            val anchor = caret(a) ?: return null
            val head = caret(b) ?: return null
            return anchor to head
        }

    /** The lines the selection touches. */
    val selectedLines: IntRange
        get() {
            if (lines.isEmpty()) return IntRange.EMPTY
            val a = textView.selectionStart.coerceAtLeast(0)
            val b = textView.selectionEnd.coerceAtLeast(a)
            val first = DocumentText.locate(a, starts).first
            val last = DocumentText.locate(maxOf(a, b - if (b > a) 1 else 0), starts).first
            return first..last
        }

    private fun place(line: Int, offset: Int) {
        if (line !in lines.indices) return
        textView.setSelection((starts[line] + minOf(offset, lines[line].length)).coerceAtMost(text.length))
    }

    // Changes from the lines

    private fun linesChanged(change: DocumentLinesChange) {
        val clock = System.nanoTime()
        val selection = textView.selectionStart to textView.selectionEnd
        apply {
            if (readingBack) {
                // The text view already holds the typing; only its spans are set again.
                mirror(editor.lines)
                val upper = minOf(lines.size, change.range.first + change.lines.size + 1)
                for (i in change.range.first until upper) style.style(text, starts[i], lines[i], lines.getOrNull(i - 1))
            } else {
                val from = starts[change.range.first]
                val to = starts[change.range.last + 1]
                val previous = lines.getOrNull(change.range.first - 1)
                val built = style.paragraphs(change.lines, previous)
                val composing = BaseInputConnection.getComposingSpanStart(text) to BaseInputConnection.getComposingSpanEnd(text)
                // The old paragraphs' spans go first: a paragraph span emptied by the replace would stay, empty, at its edge.
                style.clear(text, from, to)
                text.replace(from, to, built)
                mirror(editor.lines)
                val next = change.range.first + change.lines.size
                if (next < lines.size) style.style(text, starts[next], lines[next], lines[next - 1])
                // The line before keeps its paragraph to itself, whatever the replace did at its end.
                val before = change.range.first - 1
                if (before in lines.indices) style.style(text, starts[before], lines[before], lines.getOrNull(before - 1))
                // The keyboard's composing word was in what changed: it is done, as the text it is.
                if (composing.first >= 0 && composing.first < to && composing.second > from) {
                    BaseInputConnection.removeComposingSpans(text)
                    (textView.context.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.restartInput(textView)
                }
            }
        }
        if (readingBack && selection.first >= 0) Selection.setSelection(text, selection.first.coerceAtMost(text.length), selection.second.coerceAtMost(text.length))
        lastApply = System.nanoTime() - clock
        drawCursors()
        loadPictures(change.range.first until minOf(lines.size, change.range.first + change.lines.size))
        onSelection?.invoke()
    }

    /** A change from elsewhere: merged, the selection held where it was. */
    fun applyRemote(update: ByteArray) {
        val carets = selectionCarets
        val anchor = carets?.let { editor.relativePosition(it.first) }
        val head = carets?.let { editor.relativePosition(it.second) }
        runCatching { editor.applyRemote(update) }
        if (anchor != null && head != null) {
            val a = editor.caret(anchor)?.let(::offset)
            val h = editor.caret(head)?.let(::offset)
            if (a != null && h != null) Selection.setSelection(text, minOf(a, h).coerceAtMost(text.length), maxOf(a, h).coerceAtMost(text.length))
        }
    }

    // The person's typing

    override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) {}

    override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) {
        if (textView.applying) return
        typed = s.subSequence(start, start + count).toString().takeIf { before == 0 }
        val delta = count - before
        val range = start until start + count
        val previous = edited
        edited = if (previous == null) {
            range to delta
        } else {
            // Old edits shift with this one; the union covers both.
            val (old, oldDelta) = previous
            val oldEnd = old.last + 1 + if (old.last + 1 > start) delta else 0
            val from = minOf(old.first, start)
            val to = maxOf(oldEnd, start + count)
            (from until to) to (oldDelta + delta)
        }
    }

    override fun afterTextChanged(s: Editable) {
        if (textView.applying) return
        val clock = System.nanoTime()
        readBack()
        lastTyping = System.nanoTime() - clock
    }

    /** The paragraphs the person changed, read back into the lines. */
    private fun readBack() {
        val (range, delta) = edited ?: return
        edited = null
        if (lines.isEmpty()) return
        val string = text
        // A text whose last "\n" was removed gets it back.
        if (string.isEmpty() || string[string.length - 1] != '\n') apply { string.append('\n') }
        val total = starts.last()
        val rangeEnd = range.last + 1
        val oldEnd = rangeEnd - delta
        val first = DocumentText.locate(minOf(range.first, maxOf(0, total - 1)), starts).first
        val last = DocumentText.locate(maxOf(range.first, minOf(oldEnd, total - 1)), starts).first
        val newStart = starts[first]
        val newEnd = minOf(string.length, starts[last + 1] + delta)
        if (newEnd < newStart) return
        val read = ArrayList<DocumentLine>()
        val seen = HashSet<String>()
        var position = newStart
        while (position < newEnd) {
            var paragraphEnd = string.indexOf('\n', position)
            if (paragraphEnd < 0) paragraphEnd = string.length - 1
            val bodyEnd = paragraphEnd
            // Which line this is: its first character's, unless that came from
            // outside the edited lines, then its "\n"'s. The span can be older
            // than the line, so the line as it is now wins.
            val infos = listOf(position, paragraphEnd).map { at -> string.getSpans(at, at + 1, DocumentLineSpan::class.java).firstOrNull() }
            val info = infos.filterNotNull().firstOrNull { span -> index[span.id]?.let { it in first..last } == true && span.id !in seen } ?: infos.last()
            var line = info?.let { span -> index[span.id]?.let { lines[it] } ?: span.line }
                ?: DocumentLine(DocumentBlock(DocumentEditor.newID(), "paragraph", content = DocumentBlock.Content.Inline(emptyList())))
            val body = string.subSequence(position, bodyEnd).toString()
            if (!line.block.isInline) {
                if (body != DocumentText.OBJECT.toString()) {
                    // Typed beside a divider or picture: the text is a paragraph of its own.
                    val runs = runs(position, bodyEnd).mapNotNull { run ->
                        val kept = run.text.replace(DocumentText.OBJECT.toString(), "")
                        if (kept.isEmpty()) null else DocumentRun(kept, run.marks)
                    }
                    if (DocumentText.OBJECT in body) {
                        read += line
                        seen += line.id
                    }
                    line = DocumentLine(DocumentBlock(DocumentEditor.newID(), "paragraph", content = DocumentBlock.Content.Inline(runs)), line.depth)
                }
            } else {
                val runs = runs(position, bodyEnd).map { DocumentRun(it.text.replace(DocumentText.OBJECT.toString(), ""), it.marks) }.filter { it.text.isNotEmpty() }
                line = line.copy(block = line.block.copy(content = DocumentBlock.Content.Inline(runs)))
            }
            if (line.id in seen || index[line.id]?.let { it !in first..last } == true) {
                // A paragraph split by pasted text: the second half is a new block.
                line = line.copy(block = line.block.copy(id = DocumentEditor.newID(), props = line.block.props - "checked"))
            }
            seen += line.id
            read += line
            position = paragraphEnd + 1
        }
        readingBack = true
        try {
            val single = first == last && read.size == 1 && read[0].id == lines[first].id && read[0].block.type == lines[first].block.type
            if (single) editor.setRuns(read[0].id, read[0].block.runs) else editor.replaceLines(first..last, read)
        } finally {
            readingBack = false
        }
        if (lines.isEmpty()) ensureALine()
        shortcuts()
    }

    /** Runs of the text between two offsets, with formats toggled for what was just typed. */
    private fun runs(from: Int, to: Int): List<DocumentRun> {
        val runs = DocumentStyle.runs(text, from, to)
        val marks = pending ?: return runs
        val typedNow = typed ?: return runs
        val at = pendingAt
        pending = null
        if (at < from || at + typedNow.length > to) return runs
        // The typed characters take the toggled formats in place of the ones they were typed into.
        val local = at - from
        var out = runs
        for (key in DocumentEdits.slice(runs, local, local + typedNow.length).flatMap { it.marks.keys }.toSet() + marks.keys) {
            out = DocumentEdits.setting(out, key, marks[key], local, local + typedNow.length)
        }
        return out
    }

    /** Markdown typed, made what it means. */
    private fun shortcuts() {
        val typed = typed ?: return
        this.typed = null
        if (typed.length != 1 || textView.selectionStart != textView.selectionEnd) return
        val offset = textView.selectionStart
        if (offset < 0 || lines.isEmpty()) return
        val (i, caret) = DocumentText.locate(offset, starts)
        val line = lines[i]
        val block = DocumentShortcuts.block(line, caret)
        if (block != null) {
            when (block) {
                DocumentShortcuts.Block.Divider -> perform(DocumentEdits.divider(lines, i))
                is DocumentShortcuts.Block.Type -> {
                    val made = DocumentEdits.retype(line, block.type, block.props).let {
                        it.copy(block = it.block.copy(content = DocumentBlock.Content.Inline(DocumentEdits.slice(line.block.runs, block.remove, line.length))))
                    }
                    perform(DocumentEdits.Result(i..i, listOf(made), i, maxOf(0, caret - block.remove)))
                }
            }
            return
        }
        if (typed in setOf("*", "_", "~", "`") && line.block.type != "codeBlock") {
            val inline = DocumentShortcuts.inline(line.block.runs, caret) ?: return
            editor.setRuns(line.id, inline.runs)
            place(i, inline.caret)
            // The next character typed doesn't continue the format.
            setPending(DocumentEdits.marks(inline.runs, inline.caret).filterKeys { it == "textColor" || it == "backgroundColor" })
        }
    }

    /** An edit on the lines, and the caret where it says. */
    fun perform(result: DocumentEdits.Result) {
        editor.replaceLines(result.range, result.lines)
        if (lines.isEmpty()) ensureALine()
        val i = minOf(result.caretLine, lines.size - 1)
        place(i, result.caretOffset)
        // What's typed next is drawn as this line is, not as the one the caret came from.
        if (lines[i].block.isInline && lines[i].block.runs.isNotEmpty()) setPending(DocumentEdits.marks(lines[i].block.runs, result.caretOffset))
    }

    private fun enter(at: Int) {
        if (!editable || lines.isEmpty()) return
        val (line, offset) = DocumentText.locate(at, starts)
        if (lines[line].block.type == "codeBlock") {
            // A code block keeps its newlines; three Enters at its end leave it, as in BlockNote.
            val plain = lines[line].block.plainText
            if (offset == lines[line].length && plain.endsWith("\n\n")) {
                val trimmed = lines[line].let { it.copy(block = it.block.copy(content = DocumentBlock.Content.Inline(DocumentEdits.slice(it.block.runs, 0, it.length - 2)))) }
                val after = DocumentLine(DocumentBlock(DocumentEditor.newID(), "paragraph", content = DocumentBlock.Content.Inline(emptyList())), trimmed.depth)
                perform(DocumentEdits.Result(line..line, listOf(trimmed, after), line + 1, 0))
                return
            }
            text.replace(at, maxOf(at, textView.selectionEnd), DocumentText.LINE_BREAK.toString())
            return
        }
        // A selection is typed over first.
        if (textView.selectionEnd > at) {
            text.delete(at, textView.selectionEnd)
            return enter(at)
        }
        DocumentEdits.enter(lines, line, offset)?.let(::perform)
    }

    private fun backspace(at: Int) {
        if (!editable || lines.isEmpty()) return
        val (i, offset) = DocumentText.locate(at, starts)
        if (offset != 0) return
        DocumentEdits.backspaceAtStart(lines, i)?.let(::perform)
    }

    // Tasks

    fun toggle(id: String) {
        if (!editable) return
        val selection = textView.selectionStart to textView.selectionEnd
        editor.toggleChecked(id)
        if (selection.first >= 0) Selection.setSelection(text, selection.first.coerceAtMost(text.length), selection.second.coerceAtMost(text.length))
        val done = editor.line(id)?.block?.checked == true
        // The box isn't a view of its own to carry a state description, so its new state is said.
        @Suppress("DEPRECATION")
        textView.announceForAccessibility(textView.context.getString(if (done) com.slopus.happy.R.string.document_task_done else com.slopus.happy.R.string.document_task_not_done))
    }

    // The formatting bar

    /** What the selection has, for the bar's lit buttons. */
    val activeTools: Set<DocumentTool>
        get() {
            if (lines.isEmpty()) return emptySet()
            val out = HashSet<DocumentTool>()
            val picked = selectedLines
            if (picked.isEmpty()) return out
            val line = lines[picked.first]
            if (textView.selectionStart == textView.selectionEnd) {
                val marks = pending.takeIf { pendingAt == textView.selectionStart } ?: caretMarks()
                for ((tool, mark) in MARK_TOOLS) if (mark in marks) out += tool
            } else {
                for ((tool, mark) in MARK_TOOLS) {
                    if (picked.all { i -> localRange(i).let { it.isEmpty() || DocumentEdits.has(lines[i].block.runs, mark, it.first, it.last + 1) } }) out += tool
                }
            }
            for ((tool, type) in BLOCK_TOOLS) if (line.block.type == type) out += tool
            return out
        }

    /** The formats the next character typed at the caret takes: the character before's, as typing extends them. */
    private fun caretMarks(): Map<String, YAny> {
        val at = textView.selectionStart
        if (at < 0 || lines.isEmpty()) return emptyMap()
        val (i, offset) = DocumentText.locate(at, starts)
        val runs = lines[i].block.runs
        if (offset == 0) return emptyMap()
        return DocumentEdits.slice(runs, offset - 1, offset).firstOrNull()?.marks.orEmpty().filterKeys { it != "link" && it != "code" }
    }

    /** The selection within line [i], in its own offsets. */
    private fun localRange(i: Int): IntRange {
        val a = textView.selectionStart.coerceAtLeast(0)
        val b = textView.selectionEnd.coerceAtLeast(a)
        val lower = maxOf(a, starts[i]) - starts[i]
        val upper = minOf(b, starts[i] + lines[i].length) - starts[i]
        return lower until maxOf(lower, upper)
    }

    fun run(tool: DocumentTool) {
        if (!editable || lines.isEmpty()) return
        when (tool) {
            DocumentTool.Bold -> toggleMark("bold")
            DocumentTool.Italic -> toggleMark("italic")
            DocumentTool.Strike -> toggleMark("strike")
            DocumentTool.Code -> toggleMark("code")
            DocumentTool.Link -> link()
            DocumentTool.Bullets -> toggleBlock("bulletListItem")
            DocumentTool.Numbers -> toggleBlock("numberedListItem")
            DocumentTool.Checklist -> toggleBlock("checkListItem")
            DocumentTool.Quote -> toggleBlock("quote")
            DocumentTool.CodeBlock -> toggleBlock("codeBlock")
            DocumentTool.Indent, DocumentTool.Outdent -> {
                val picked = selectedLines
                val caret = localRange(picked.first).first
                val result = if (tool == DocumentTool.Indent) DocumentEdits.indent(lines, picked, caret) else DocumentEdits.outdent(lines, picked, caret)
                if (result != null) keepingSelection(picked.first) { editor.replaceLines(result.range, result.lines) }
            }
            DocumentTool.Divider -> {
                val i = selectedLines.first
                if (lines[i].block.isInline && lines[i].length == 0) {
                    perform(DocumentEdits.divider(lines, i))
                } else {
                    val divider = DocumentLine(DocumentBlock(DocumentEditor.newID(), "divider", content = DocumentBlock.Content.None), lines[i].depth)
                    val next = DocumentLine(DocumentBlock(DocumentEditor.newID(), "paragraph", content = DocumentBlock.Content.Inline(emptyList())), lines[i].depth)
                    perform(DocumentEdits.Result((i + 1) until (i + 1), listOf(divider, next), i + 2, 0))
                }
            }
        }
        onSelection?.invoke()
    }

    /** The selection where it was within line [first], after the lines from it change. */
    private inline fun keepingSelection(first: Int, change: () -> Unit) {
        val a = textView.selectionStart
        val b = textView.selectionEnd
        val before = starts[first]
        change()
        val now = starts.getOrElse(first) { before }
        Selection.setSelection(text, (a - before + now).coerceIn(0, text.length), (b - before + now).coerceIn(0, text.length))
    }

    private fun setPending(marks: Map<String, YAny>) {
        pending = marks
        pendingAt = textView.selectionStart
    }

    private fun toggleMark(mark: String) {
        val a = textView.selectionStart
        val b = textView.selectionEnd
        if (a == b) {
            val marks = (pending.takeIf { pendingAt == a } ?: caretMarks()).toMutableMap()
            if (mark in marks) marks -= mark else marks[mark] = YAny.Object(emptyList())
            setPending(marks)
            onSelection?.invoke()
            return
        }
        val picked = selectedLines
        val on = !picked.all { i -> localRange(i).let { it.isEmpty() || DocumentEdits.has(lines[i].block.runs, mark, it.first, it.last + 1) } }
        val ranges = picked.associateWith { localRange(it) }
        editor.doc.transact {
            for (i in picked) {
                val line = lines[i]
                if (!line.block.isInline || line.block.type == "codeBlock") continue
                val local = ranges.getValue(i)
                if (local.isEmpty()) continue
                editor.setRuns(line.id, DocumentEdits.setting(line.block.runs, mark, if (on) YAny.Object(emptyList()) else null, local.first, local.last + 1))
            }
        }
        Selection.setSelection(text, a.coerceAtMost(text.length), b.coerceAtMost(text.length))
    }

    private fun toggleBlock(type: String, props: Map<String, YAny> = emptyMap()) {
        val picked = selectedLines
        val all = picked.all { i -> lines[i].block.type == type && props.all { (key, value) -> lines[i].block.props[key] == value } }
        val next = picked.map { i ->
            if (!lines[i].block.isInline && type != "paragraph") lines[i]
            else DocumentEdits.retype(lines[i], if (all) "paragraph" else type, if (all) emptyMap() else props)
        }
        keepingSelection(picked.first) { editor.replaceLines(picked, next) }
    }

    /** Text (0) or a heading level. */
    fun setStyle(level: Int) {
        if (!editable || lines.isEmpty()) return
        if (level == 0) toggleBlock("paragraph") else toggleBlock("heading", mapOf("level" to YAny.Number(level.toDouble())))
        onSelection?.invoke()
    }

    private fun link() {
        val a = textView.selectionStart
        val b = textView.selectionEnd
        val i = selectedLines.first
        val local = localRange(i)
        val runs = lines[i].block.runs
        val current = (if (local.isEmpty()) DocumentEdits.slice(runs, maxOf(0, local.first - 1), local.first) else DocumentEdits.slice(runs, local.first, local.last + 1))
            .firstOrNull()?.marks?.get("link")?.get("href")?.stringValue
        val id = lines[i].id
        onLink?.invoke(current) { href ->
            val at = index[id] ?: return@invoke
            val line = lines[at]
            val value = href?.takeIf { it.isNotEmpty() }?.let { YAny.Object(listOf("href" to YAny.Str(it))) }
            if (local.isEmpty()) {
                if (href.isNullOrEmpty() || value == null) return@invoke
                val marks = DocumentEdits.marks(line.block.runs, local.first) + ("link" to value)
                editor.setRuns(id, DocumentEdits.typing(line.block.runs, href, local.first, local.first, marks))
                place(at, local.first + href.length)
            } else {
                editor.setRuns(id, DocumentEdits.setting(line.block.runs, "link", value, local.first, local.last + 1))
                Selection.setSelection(text, a.coerceAtMost(text.length), b.coerceAtMost(text.length))
            }
        }
    }

    // Hardware keys

    private fun key(code: Int, event: KeyEvent): Boolean {
        if (code == KeyEvent.KEYCODE_TAB) {
            run(if (event.isShiftPressed) DocumentTool.Outdent else DocumentTool.Indent)
            return true
        }
        if (!event.isCtrlPressed && !event.isMetaPressed) return false
        val shift = event.isShiftPressed
        val alt = event.isAltPressed
        when {
            alt && code in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_3 -> setStyle(code - KeyEvent.KEYCODE_0)
            !shift && code == KeyEvent.KEYCODE_B -> run(DocumentTool.Bold)
            !shift && code == KeyEvent.KEYCODE_I -> run(DocumentTool.Italic)
            !shift && code == KeyEvent.KEYCODE_K -> run(DocumentTool.Link)
            !shift && code == KeyEvent.KEYCODE_E -> run(DocumentTool.Code)
            shift && (code == KeyEvent.KEYCODE_S || code == KeyEvent.KEYCODE_X) -> run(DocumentTool.Strike)
            shift && code == KeyEvent.KEYCODE_7 -> run(DocumentTool.Numbers)
            shift && code == KeyEvent.KEYCODE_8 -> run(DocumentTool.Bullets)
            shift && code == KeyEvent.KEYCODE_9 -> run(DocumentTool.Checklist)
            else -> return false
        }
        return true
    }

    fun detach() {
        textView.removeCallbacks(hideLabels)
        textView.removeTextChangedListener(this)
        editor.onLinesChange = null
    }

    companion object {
            val MARK_TOOLS = listOf(DocumentTool.Bold to "bold", DocumentTool.Italic to "italic", DocumentTool.Strike to "strike", DocumentTool.Code to "code", DocumentTool.Link to "link")
        val BLOCK_TOOLS = listOf(DocumentTool.Bullets to "bulletListItem", DocumentTool.Numbers to "numberedListItem", DocumentTool.Checklist to "checkListItem", DocumentTool.Quote to "quote", DocumentTool.CodeBlock to "codeBlock")
    }
}
