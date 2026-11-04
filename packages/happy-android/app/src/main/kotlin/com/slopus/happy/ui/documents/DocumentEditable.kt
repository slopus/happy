package com.slopus.happy.ui.documents

import android.text.Editable
import android.text.NoCopySpan
import android.text.SpanWatcher
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.TextWatcher
import android.text.style.UpdateLayout

/**
 * The document's text: a [SpannableStringBuilder] whose layout is not laid
 * out again for paragraphs a keystroke only moved.
 *
 * Every paragraph carries a span that changes its metrics (its type size, a
 * heading's weight, an object), and those are [UpdateLayout]. On each edit,
 * `SpannableStringBuilder` reports every span after it as changed, because
 * its offsets moved, and `DynamicLayout` lays out each one's paragraph
 * again, twice. On a 10,000-word document that was hundreds of paragraph
 * layouts a keystroke. The edit itself is laid out from the text change, and
 * `DynamicLayout` shifts the lines after it, so a span that only moved with
 * the text needs nothing. Those reports are held back from the layout's
 * watcher; every other one reaches it as before.
 */
class DocumentEditable(text: CharSequence) : SpannableStringBuilder(text) {
    /** The replace under way: where, how long the old text was, and how much longer the text gets. */
    private var editStart = -1
    private var editEnd = -1
    private var editDelta = 0

    /** `DynamicLayout`'s watchers as set, each with the one that stands in for it. */
    private val layoutWatchers = HashMap<Any, LayoutWatcher>()

    override fun replace(start: Int, end: Int, tb: CharSequence, tbstart: Int, tbend: Int): SpannableStringBuilder {
        val outer = Triple(editStart, editEnd, editDelta)
        editStart = start
        editEnd = start + (tbend - tbstart)
        editDelta = (tbend - tbstart) - (end - start)
        try {
            return super.replace(start, end, tb, tbstart, tbend)
        } finally {
            editStart = outer.first
            editEnd = outer.second
            editDelta = outer.third
        }
    }

    override fun setSpan(what: Any?, start: Int, end: Int, flags: Int) {
        if (what != null && isLayoutWatcher(what.javaClass)) {
            val standIn = layoutWatchers.getOrPut(what) { LayoutWatcher(what as SpanWatcher, what as TextWatcher) }
            super.setSpan(standIn, start, end, flags)
            return
        }
        super.setSpan(what, start, end, flags)
    }

    override fun removeSpan(what: Any?) {
        val standIn = what?.let(layoutWatchers::remove)
        super.removeSpan(standIn ?: what)
    }

    override fun getSpanStart(what: Any?): Int = super.getSpanStart(what?.let { layoutWatchers[it] } ?: what)
    override fun getSpanEnd(what: Any?): Int = super.getSpanEnd(what?.let { layoutWatchers[it] } ?: what)
    override fun getSpanFlags(what: Any?): Int = super.getSpanFlags(what?.let { layoutWatchers[it] } ?: what)

    /** Asked for `DynamicLayout`'s own watchers (it strips other layouts' before adding its own), it gets them, not their stand-ins. */
    override fun <T : Any?> getSpans(queryStart: Int, queryEnd: Int, kind: Class<T>?): Array<T> {
        if (kind == null || !isLayoutWatcher(kind)) return super.getSpans(queryStart, queryEnd, kind)
        val found = super.getSpans(queryStart, queryEnd, LayoutWatcher::class.java).map { it.layout }
        @Suppress("UNCHECKED_CAST")
        val out = java.lang.reflect.Array.newInstance(kind, found.size) as Array<T>
        found.forEachIndexed { i, watcher -> out[i] = kind.cast(watcher) as T }
        return out
    }

    /** A span that only moved with the edit: the edit's own layout covers it. */
    private fun movedOnly(what: Any?, oldStart: Int, oldEnd: Int, newStart: Int, newEnd: Int): Boolean =
        editStart >= 0 && editDelta != 0 && what is UpdateLayout &&
            newStart >= editEnd && newStart - oldStart == editDelta && newEnd - oldEnd == editDelta

    /** Stands in for a `DynamicLayout`'s watcher, passing it all but the moves of [movedOnly]. */
    private inner class LayoutWatcher(val layout: SpanWatcher, private val text: TextWatcher) : SpanWatcher, TextWatcher, NoCopySpan {
        override fun onSpanAdded(s: Spannable, what: Any, start: Int, end: Int) = layout.onSpanAdded(s, what, start, end)
        override fun onSpanRemoved(s: Spannable, what: Any, start: Int, end: Int) = layout.onSpanRemoved(s, what, start, end)
        override fun onSpanChanged(s: Spannable, what: Any, ostart: Int, oend: Int, nstart: Int, nend: Int) {
            if (movedOnly(what, ostart, oend, nstart, nend)) return
            layout.onSpanChanged(s, what, ostart, oend, nstart, nend)
        }
        override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) = text.beforeTextChanged(s, start, count, after)
        override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) = text.onTextChanged(s, start, before, count)
        override fun afterTextChanged(s: Editable) = text.afterTextChanged(s)
    }

    companion object {
        private const val LAYOUT_WATCHER = "android.text.DynamicLayout\$ChangeWatcher"

        private fun isLayoutWatcher(kind: Class<*>): Boolean = kind.name == LAYOUT_WATCHER

        /** For [android.widget.TextView.setEditableFactory]. */
        val factory = object : Editable.Factory() {
            override fun newEditable(source: CharSequence): Editable = DocumentEditable(source)
        }
    }
}
