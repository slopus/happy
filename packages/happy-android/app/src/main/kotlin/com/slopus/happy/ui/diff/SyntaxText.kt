package com.slopus.happy.ui.diff

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import com.slopus.happy.diff.SpanKind
import com.slopus.happy.diff.syntax.DiffSyntax
import kotlinx.coroutines.withTimeoutOrNull

/** theme.ts dark `diff.syntax`: the terminal stays dark in both themes. */
val DarkSyntaxColors: Map<SpanKind, Color> = mapOf(
    SpanKind.Plain to Color(0xFFE6EDF3), SpanKind.Keyword to Color(0xFFFF7B72), SpanKind.Str to Color(0xFFA5D6FF),
    SpanKind.Comment to Color(0xFF8B949E), SpanKind.Number to Color(0xFF79C0FF), SpanKind.Function to Color(0xFFD2A8FF),
    SpanKind.Operator to Color(0xFF79C0FF), SpanKind.Punctuation to Color(0xFFE6EDF3), SpanKind.Type to Color(0xFFFFA657),
    SpanKind.Variable to Color(0xFFFFA657), SpanKind.Tag to Color(0xFF7EE787), SpanKind.Attr to Color(0xFF79C0FF),
)

/**
 * SyntaxText.tsx: [code] coloured by Prism through the same queue, cache
 * and one-second reveal gate as diffs ([LocalDiffSyntax]). Plain runs keep
 * [color]; classified ones take [colors]. Invisible, and hidden from
 * TalkBack, while pending.
 */
@Composable
fun SyntaxText(
    code: String,
    language: String,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    colors: Map<SpanKind, Color>? = null,
) {
    val service = LocalDiffSyntax.current
    val palette = colors ?: diffPalette().syntax
    val input = remember(code, language, service) { if (service == null) null else DiffSyntax.planCode(code, language) }
    var result by remember(input) { mutableStateOf(input?.let { service?.peek(it) }) }
    var pending by remember(input) { mutableStateOf(input != null && result == null) }
    LaunchedEffect(input) {
        if (input == null || service == null || result != null) return@LaunchedEffect
        result = withTimeoutOrNull(DiffSyntax.REVEAL_MS) { service.highlight(input) }
        pending = false
    }
    val text = remember(input, result, palette) {
        val spans = input?.let { DiffSyntax.codeSpans(it, result) }
        if (spans == null) AnnotatedString(code) else buildAnnotatedString {
            for (span in spans) {
                if (span.kind == SpanKind.Plain) append(span.text)
                else withStyle(SpanStyle(color = palette.getValue(span.kind))) { append(span.text) }
            }
        }
    }
    Text(
        text,
        style = style,
        color = color,
        modifier = modifier
            .alpha(if (pending) 0f else 1f)
            .then(if (pending) Modifier.semantics { hideFromAccessibility() } else Modifier)
            .testTag(if (pending) DiffTags.SYNTAX_PENDING else DiffTags.SYNTAX_READY),
    )
}
