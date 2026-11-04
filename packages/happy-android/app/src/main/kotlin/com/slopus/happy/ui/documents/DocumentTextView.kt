package com.slopus.happy.ui.documents

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.text.TextUtils
import android.text.InputFilter
import android.text.InputType
import android.text.Spanned
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import com.slopus.happy.documents.DocumentText

/**
 * The document's text view (iOS's `DocumentTextView`): a plain
 * [EditText], so the keyboard's composing, autocorrect, voice typing,
 * selection handles, the text menu and a hardware keyboard all work as in
 * any field, as Telegram's `EditTextCaption` keeps them. Each line of the
 * document is one paragraph of its text; its marker is drawn by the
 * paragraph's [DocumentLineSpan], not typed.
 *
 * What a line edit means more than a character does comes out here, for
 * the controller: Enter ([onEnter]), Backspace at a line's start
 * ([onBackspaceAtStart]), a tap on a task's box ([onTask]) and the hardware
 * keys ([onKey]). A keyboard's Enter and Delete both arrive as edits of
 * the text, so they are caught as the text is about to change. The other
 * editors' carets ([cursors]) are drawn over the text.
 */
@SuppressLint("ViewConstructor", "AppCompatCustomView")
class DocumentTextView(context: Context) : EditText(context) {
    /** Enter at this offset; the newline is not inserted. */
    var onEnter: ((Int) -> Unit)? = null
    /** Backspace with the caret at the start of the line at this offset; the newline is kept. */
    var onBackspaceAtStart: ((Int) -> Unit)? = null
    /** The task whose box was tapped. */
    var onTask: ((String) -> Unit)? = null
    /** A hardware shortcut; true if taken. */
    var onKey: ((Int, KeyEvent) -> Boolean)? = null
    /** Changes made by the controller, which none of the above should catch. */
    var applying = false
    private var pressedTask: String? = null

    init {
        background = null
        gravity = Gravity.TOP or Gravity.START
        isVerticalScrollBarEnabled = true
        includeFontPadding = false
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
        imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN
        setHorizontallyScrolling(false)
        filters = arrayOf(InputFilter { source, start, end, dest, dstart, dend -> filter(source, start, end, dest, dstart, dend) })
        setEditableFactory(DocumentEditable.factory)
        // Body text's size is the view's (its colour the screen's); the paragraphs only set what differs (DocumentStyle.style).
        textSize = DocumentTokens.BODY_SIZE
    }

    private fun filter(source: CharSequence, start: Int, end: Int, dest: Spanned, dstart: Int, dend: Int): CharSequence? {
        if (applying) return null
        if (end - start == 1 && source[start] == '\n' && dstart == dend) {
            post { onEnter?.invoke(dstart) }
            return ""
        }
        // Backspace at a line's start deletes the "\n" before it, the caret just after it.
        if (end == start && dend - dstart == 1 && dest[dstart] == '\n' && selectionStart == dend && selectionEnd == dend) {
            post { onBackspaceAtStart?.invoke(dend) }
            return dest.subSequence(dstart, dend)
        }
        return null
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_ENTER && event.isShiftPressed) {
            // ⇧Return: a hard break, so the line stays one paragraph.
            val text = text ?: return true
            text.replace(selectionStart.coerceAtLeast(0), selectionEnd.coerceAtLeast(0), DocumentText.LINE_BREAK.toString())
            return true
        }
        if (onKey?.invoke(keyCode, event) == true) return true
        return super.onKeyDown(keyCode, event)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        onWidth?.invoke(w - totalPaddingLeft - totalPaddingRight)
    }

    /** The text's width changed: objects take it. */
    var onWidth: ((Int) -> Unit)? = null

    /** The caret or the selection moved. */
    var onSelectionChange: (() -> Unit)? = null

    // Called from TextView's own constructor too, before this class's fields are set.
    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        @Suppress("UNNECESSARY_SAFE_CALL") onSelectionChange?.invoke()
    }

    /** The other editors' carets, at offsets in this text. */
    var cursors: List<DocumentCursor> = emptyList()
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }
    private val cursorPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val cursorLabelPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.BLACK
        typeface = if (android.os.Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, 600, false) else Typeface.DEFAULT_BOLD
    }
    private val cursorRect = RectF()

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (cursors.isNotEmpty()) drawCursors(canvas)
    }

    /**
     * Each caret as a bar in its editor's colour, and their name on a tag
     * above it while [DocumentCursor.labelled] (iOS's `DocumentCursorsView`,
     * desktop's `showCursorLabels: "activity"`); the tag stays inside the view.
     */
    private fun drawCursors(canvas: Canvas) {
        val layout = layout ?: return
        val length = text?.length ?: return
        val density = resources.displayMetrics.density
        val bar = DocumentPeersSpec.bar.value * density
        val tag = DocumentPeersSpec.label.value * density
        val padding = DocumentPeersSpec.labelPadding.value * density
        val corner = DocumentPeersSpec.labelCorner.value * density
        cursorLabelPaint.textSize = DocumentPeersSpec.LABEL_SIZE * resources.displayMetrics.scaledDensity
        for (cursor in cursors) {
            if (cursor.offset !in 0..length) continue
            val line = layout.getLineForOffset(cursor.offset)
            val x = totalPaddingLeft + layout.getPrimaryHorizontal(cursor.offset)
            val top = (totalPaddingTop + layout.getLineTop(line)).toFloat()
            val bottom = (totalPaddingTop + layout.getLineBottom(line)).toFloat()
            cursorPaint.color = cursor.color
            cursorRect.set(x - bar / 2, top, x + bar / 2, bottom)
            canvas.drawRoundRect(cursorRect, bar / 2, bar / 2, cursorPaint)
            if (!cursor.labelled) continue
            val most = DocumentPeersSpec.labelMost.value * density
            val name = TextUtils.ellipsize(cursor.name, cursorLabelPaint, most, TextUtils.TruncateAt.END).toString()
            val tagWidth = minOf(cursorLabelPaint.measureText(name) + padding * 2, width.toFloat())
            val left = minOf(x - bar / 2, maxOf(0f, width - tagWidth))
            cursorRect.set(left, top - tag, left + tagWidth, top)
            canvas.drawRoundRect(cursorRect, corner, corner, cursorPaint)
            val metrics = cursorLabelPaint.fontMetrics
            val baseline = top - tag / 2 - (metrics.ascent + metrics.descent) / 2
            canvas.drawText(name, left + padding, baseline, cursorLabelPaint)
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pressedTask = task(event.x, event.y)
                if (pressedTask != null) return true
            }
            MotionEvent.ACTION_UP -> pressedTask?.let { id ->
                pressedTask = null
                if (task(event.x, event.y) == id) onTask?.invoke(id)
                return true
            }
            MotionEvent.ACTION_CANCEL -> if (pressedTask != null) {
                pressedTask = null
                return true
            }
            MotionEvent.ACTION_MOVE -> if (pressedTask != null) return true
        }
        return super.onTouchEvent(event)
    }

    /** The task whose 44 dp box target is under this point, in the view's coordinates. */
    fun task(x: Float, y: Float): String? {
        val layout = layout ?: return null
        val text = text ?: return null
        val contentY = (y - totalPaddingTop + scrollY).toInt()
        val contentX = x - totalPaddingLeft + scrollX
        val lineNumber = layout.getLineForVertical(contentY)
        // The box sits on its paragraph's first line; a 44 dp target may reach a line either side.
        for (candidate in maxOf(0, lineNumber - 1)..minOf(layout.lineCount - 1, lineNumber + 1)) {
            val offset = layout.getLineStart(candidate)
            val span = text.getSpans(offset, offset, DocumentLineSpan::class.java).firstOrNull { text.getSpanStart(it) == offset } ?: continue
            val rtl = layout.getParagraphDirection(candidate) == android.text.Layout.DIR_RIGHT_TO_LEFT
            val target = span.taskTarget(0, layout.getLineTop(candidate), layout.getLineBottom(candidate), rtl, layout.width) ?: continue
            if (target.contains(contentX, contentY.toFloat())) return span.id
        }
        return null
    }
}

/** Another editor's caret: where it is in the text, their colour and name, and whether the name shows. */
data class DocumentCursor(val key: String, val offset: Int, val color: Int, val name: String, val labelled: Boolean)
