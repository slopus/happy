package com.slopus.happy.ui.autocomplete

import androidx.compose.foundation.text.input.OutputTransformation
import androidx.compose.foundation.text.input.TextFieldBuffer
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontWeight
import com.slopus.happy.autocomplete.draftMentions

/**
 * The composer's draft as the person reads it (desktop's composerDraftParse
 * and mention tint): each person it mentions shows as "@Name" in the strong
 * face, as a sent message draws them, while the draft itself keeps their
 * Markdown (`[Name](happy://users/…)`), which is what is sent and saved.
 * The field treats a shown mention as one piece: the caret steps over it,
 * and a delete that reaches into it takes it whole.
 */
object ComposerMentions : OutputTransformation {
    private val strong = SpanStyle(fontWeight = FontWeight.SemiBold)

    override fun TextFieldBuffer.transformOutput() {
        val mentions = draftMentions(asCharSequence().toString())
        if (mentions.isEmpty()) return
        // From the end, so each mention's offsets still hold as the ones after it change.
        for (mention in mentions.asReversed()) replace(mention.start, mention.end, mention.shown)
        var shift = 0
        for (mention in mentions) {
            val start = mention.start + shift
            addStyle(strong, start, start + mention.shown.length)
            shift += mention.shown.length - (mention.end - mention.start)
        }
    }
}
