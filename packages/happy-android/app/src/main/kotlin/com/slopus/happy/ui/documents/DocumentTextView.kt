package com.slopus.happy.ui.documents

import android.annotation.SuppressLint
import android.content.Context
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
 * the text, so they are caught as the text is about to change.
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
