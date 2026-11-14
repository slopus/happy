package com.slopus.happy.ui.chat

import androidx.compose.runtime.Stable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLayoutResult

/**
 * Which links drawn under it name something at work right now: a link to a
 * conversation whose turn runs, on the screen's own connection. Its label
 * shimmers as desktop's MessageReferenceLink does (`data-busy`), read from
 * the link's own address as it is drawn, so the words never change with it.
 */
@Stable
fun interface BusyLinks {
    fun busy(url: String): Boolean
}

/** The screen's [BusyLinks]; null where no link shimmers. */
val LocalBusyLinks = compositionLocalOf<BusyLinks?> { null }

/** What is behind the text drawn under it (a bubble's colour), for the sheen to fade into; null for the page's surface. */
val LocalLinkGround = staticCompositionLocalOf<Color?> { null }

/**
 * Where [text]'s links that [busy] names are drawn by [layout], a box per
 * line each covers, moved by [origin]: the boxes [shimmerBoxes][com.slopus.happy.ui.components.shimmerBoxes]
 * sweeps. Empty when none is busy.
 */
fun busyLinkBoxes(text: AnnotatedString, layout: TextLayoutResult, busy: BusyLinks, origin: Offset = Offset.Zero): List<Rect> {
    if (!text.hasLinkAnnotations(0, text.length)) return emptyList()
    val boxes = ArrayList<Rect>()
    for (range in text.getLinkAnnotations(0, text.length)) {
        val url = when (val link = range.item) {
            is LinkAnnotation.Url -> link.url
            is LinkAnnotation.Clickable -> link.tag
            else -> null
        } ?: continue
        if (!busy.busy(url)) continue
        val end = range.end.coerceAtMost(layout.layoutInput.text.length)
        var line = -1
        var box: Rect? = null
        for (offset in range.start until end) {
            val at = layout.getLineForOffset(offset)
            val glyph = layout.getBoundingBox(offset)
            if (at != line) {
                box?.let(boxes::add)
                line = at
                box = glyph
            } else {
                box = box?.let { Rect(minOf(it.left, glyph.left), minOf(it.top, glyph.top), maxOf(it.right, glyph.right), maxOf(it.bottom, glyph.bottom)) }
            }
        }
        box?.let(boxes::add)
    }
    return if (origin == Offset.Zero) boxes else boxes.map { it.translate(origin) }
}
