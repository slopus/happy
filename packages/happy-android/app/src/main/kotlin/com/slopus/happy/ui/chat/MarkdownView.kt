package com.slopus.happy.ui.chat

import kotlin.math.roundToInt
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.MarkdownSpan
import com.slopus.happy.chat.markdown.SpanStyle
import com.slopus.happy.chat.markdown.SyntaxTokenType
import com.slopus.happy.chat.markdown.isHttpMarkdownLink
import com.slopus.happy.chat.markdown.tokenizeCode
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MarkdownImage
import com.slopus.happy.ui.components.MermaidView
import com.slopus.happy.ui.browser.LocalLinkOpener
import com.slopus.happy.ui.browser.webLinkGestures
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.delay
import androidx.compose.ui.text.SpanStyle as ComposeSpanStyle

object MarkdownTags {
    const val TEXT = "markdown.text"
    const val HEADER = "markdown.header"
    const val LIST = "markdown.list"
    const val CODE_BLOCK = "markdown.codeBlock"
    const val CODE_COPY = "markdown.codeCopy"
    const val CODE_COPY_GLYPH = "markdown.codeCopy.glyph"
    const val RULE = "markdown.rule"
    const val OPTION = "markdown.option"
    const val TABLE = "markdown.table"
    const val BUTTON = "markdown.button"
    /** A button's link that opens nothing here, shown as its words. */
    const val BUTTON_INERT = "markdown.button.inert"
}

/** MarkdownView.tsx's stylesheet. */
object MarkdownSpec {
    val text = happyTextStyle(fontSize = 16, lineHeight = 25)
    val textMarginTop = 8.dp
    val textMarginBottom = 10.dp
    /** Headers 1–6: size/line height, then top and bottom margins. */
    val headers = listOf(
        happyTextStyle(fontSize = 16, lineHeight = 24, weight = FontWeight.SemiBold) to (16.dp to 8.dp),
        happyTextStyle(fontSize = 20, lineHeight = 24, weight = FontWeight.SemiBold) to (16.dp to 8.dp),
        happyTextStyle(fontSize = 16, lineHeight = 28, weight = FontWeight.SemiBold) to (16.dp to 8.dp),
        happyTextStyle(fontSize = 16, lineHeight = 24, weight = FontWeight.SemiBold) to (8.dp to 8.dp),
        happyTextStyle(fontSize = 16, lineHeight = 24, weight = FontWeight.SemiBold) to (0.dp to 0.dp),
        happyTextStyle(fontSize = 16, lineHeight = 24, weight = FontWeight.SemiBold) to (0.dp to 0.dp),
    )
    /**
     * A document's headings (iOS `DocumentTokens.headingSize`, desktop's
     * ramp brought down to a phone): h1 30 bold, h2 24, h3 20, h4-6 18
     * semibold, each on 1.25 its size, 14 above and 6 below. For a file
     * read as a document (the file viewer, a rendered diff); the chat keeps
     * [headers], RN's and iOS's chat ramp.
     */
    val documentHeaders = listOf(30, 24, 20, 18, 18, 18).mapIndexed { index, size ->
        happyTextStyle(fontSize = size, lineHeight = (size * 1.25f).roundToInt(), weight = if (index == 0) FontWeight.Bold else FontWeight.SemiBold) to (14.dp to 6.dp)
    }
    val listGap = 6.dp
    val listMarginBottom = 8.dp
    val listIndent = 16.dp
    val bulletGap = 8.dp
    val bullets = listOf("•", "◦", "▪")
    val codeRadius = 8.dp
    val codeMarginVertical = 8.dp
    val codePadding = 16.dp
    val codeLanguage = happyTextStyle(fontSize = 12, family = AppMono)
    val codeText = happyTextStyle(fontSize = 14, lineHeight = 20, family = AppMono)
    val copyButtonText = happyTextStyle(fontSize = 12, lineHeight = 16)
    /** [CodeCopy.Icon]: desktop's quiet button (3e08585d), [copyIconBox] in the code's colour [copyIconInset] in from the corner, reached [copyIconReach] around. */
    val copyIcon = 14.dp
    val copyIconBox = 24.dp
    val copyIconInset = 6.dp
    val copyIconReach = 40.dp
    const val COPIED_MILLIS = 1500L
    const val ICON_COPIED_MILLIS = 1600L
    val ruleMargin = 8.dp
    /** Link buttons: 8 above and below their stack, 8 apart. */
    val buttonMargin = 8.dp
    val buttonGap = 8.dp
    val optionGap = 8.dp
    val optionRadius = 12.dp
    val optionText = happyTextStyle(fontSize = 16, lineHeight = 24)
    val tableCellText = happyTextStyle(fontSize = 16, lineHeight = 24)
    val tableHeaderText = happyTextStyle(fontSize = 16, lineHeight = 24, weight = FontWeight.SemiBold)
    const val TABLE_MIN_COL_WIDTH = 80f
    const val TABLE_MAX_COL_WIDTH = 360f
    const val TABLE_CHAR_WIDTH = 8.5f
    const val TABLE_CELL_H_PADDING = 24f
}

/**
 * MarkdownView.tsx over blocks parsed off the main thread. Spec:
 * - Text 16/25, margins 8 above and 10 below; bold and semibold are the
 *   semibold face, italic the italic face, inline code mono 16, links
 *   underlined in the text colour (only http(s) links open).
 * - Headers semibold: h1 16/24, h2 20/24, h3 16/28 (16 above, 8 below);
 *   h4 16/24 (8, 8); h5-6 16/24 with no margins. Under
 *   [LocalMarkdownHeadings] a document's ramp instead
 *   ([MarkdownSpec.documentHeaders]).
 * - Lists: rows 6 apart, 8 below the list, 16 indent per depth, the bullet
 *   (• ◦ ▪ by depth) or "n." 8 before the text, in the text style.
 * - Code blocks: surfaceHighest, radius 8, 8 above and below; the language
 *   label mono 12 secondary, 8 from the top and 16 in; the code mono 14/20
 *   with 16 padding, scrolling sideways, highlighted by language. A "Copy"
 *   button (12/16 on surfaceHighest with a divider border, radius 4) sits
 *   8 from the top right; on phones it is always there. It turns success
 *   green and reads "Copied" for 1.5 s (happy-app alerts instead).
 * - Mermaid: a diagram in a WebView (see MermaidView); the code block where
 *   there is no WebView to use.
 * - Rule: 1 high, divider colour, 8 above and below.
 * - Options: a column 8 apart, 8 above and below; each a surfaceHighest row,
 *   radius 12, padding 12/8, 16/24 text; pressing sends it.
 * - Tables: 1 divider border, radius 8, 8 above and below; columns sized
 *   by their longest text (8.5 per char + 24, clamped 80–360), cells padded
 *   12/8, header cells surfaceHigh and semibold; scrolls sideways.
 * - Images: [MarkdownImage].
 * - Buttons (Happy links titled `button`): full-width Normal RoundButtons
 *   under their block, 8 apart, 8 above and below; one whose link opens
 *   nothing here is its words in the text style.
 */
@Composable
fun MarkdownView(
    blocks: List<MarkdownBlock>,
    modifier: Modifier = Modifier,
    onOptionPress: ((String) -> Unit)? = null,
    /** Every link, of any address, goes here instead of the system; for a document that resolves its own (an artifact's). */
    onLink: ((String) -> Unit)? = null,
    /** Draws a picture instead of [MarkdownImage]; for a document that reads its own (an artifact's). */
    image: (@Composable (MarkdownBlock.Image) -> Unit)? = null,
) {
    if (onLink != null) {
        CompositionLocalProvider(LocalMarkdownLinks provides onLink) { MarkdownView(blocks, modifier, onOptionPress, null, image) }
        return
    }
    // An own bubble's time rides up onto its last line when that is a paragraph or a header.
    val trailing = LocalTrailingSlot.current
    val last = blocks.lastOrNull()
    if (trailing != null && last !is MarkdownBlock.Text && last !is MarkdownBlock.Header) trailing.line = null
    Column(modifier = modifier) {
        for (block in blocks) MarkdownBlockView(block, onOptionPress, image, trailing.takeIf { block === last })
    }
}

/**
 * One of [MarkdownView]'s blocks, as it draws it in its column. A drawn
 * transcript row ([com.slopus.happy.ui.conversation.ProseColumn]) composes
 * its code, tables, options, pictures and diagrams with it.
 */
@Composable
internal fun MarkdownBlockView(
    block: MarkdownBlock,
    onOptionPress: ((String) -> Unit)? = null,
    image: (@Composable (MarkdownBlock.Image) -> Unit)? = null,
    /** This is an own bubble's last block: report its last line ([TrailingSlot.report]). */
    trailing: TrailingSlot? = null,
) {
    val density = LocalDensity.current
    when (block) {
        is MarkdownBlock.Text -> SpansText(
            spans = block.content,
            style = MarkdownSpec.text,
            color = HappyTheme.colors.text,
            modifier = Modifier
                .padding(top = MarkdownSpec.textMarginTop, bottom = MarkdownSpec.textMarginBottom)
                .testTag(MarkdownTags.TEXT),
            onLayout = trailing?.let { slot -> { slot.report(it, with(density) { MarkdownSpec.textMarginBottom.toPx() }) } },
        )
        is MarkdownBlock.Header -> {
            val (style, margins) = LocalMarkdownHeadings.current[(block.level - 1).coerceIn(0, 5)]
            SpansText(
                spans = block.content,
                style = style,
                color = HappyTheme.colors.text,
                modifier = Modifier.padding(top = margins.first, bottom = margins.second).testTag(MarkdownTags.HEADER),
                onLayout = trailing?.let { slot -> { slot.report(it, with(density) { margins.second.toPx() }) } },
            )
        }
        is MarkdownBlock.BulletList -> ListBlock(
            block.items.map { Triple(MarkdownSpec.bullets[it.depth.coerceAtMost(2)], it.depth, it.spans) },
        )
        is MarkdownBlock.NumberedList -> ListBlock(block.items.map { Triple("${it.number}.", it.depth, it.spans) })
        is MarkdownBlock.CodeBlock -> CodeBlock(block.content, block.language)
        is MarkdownBlock.Mermaid -> MermaidView(block.content) { CodeBlock(block.content, "mermaid") }
        MarkdownBlock.HorizontalRule -> Box(
            Modifier
                .padding(vertical = MarkdownSpec.ruleMargin)
                .testTag(MarkdownTags.RULE)
                .fillMaxWidth()
                .height(1.dp)
                .background(HappyTheme.colors.divider),
        )
        is MarkdownBlock.Options -> OptionsBlock(block.items, onOptionPress)
        is MarkdownBlock.Table -> TableBlock(block)
        is MarkdownBlock.Image -> image?.invoke(block) ?: MarkdownImage(block.alt, block.url)
        is MarkdownBlock.Buttons -> LinkButtons(block.links)
    }
}

/**
 * Happy links shown as buttons (API.md, "Buttons"), stacked in order, each
 * opening what its link names as the link would. Where the link opens
 * nothing (a settings page this connection hasn't, or a screen that opens
 * no Happy links) it is its label as inert text.
 */
@Composable
private fun LinkButtons(links: List<MarkdownSpan>) {
    val onLink = LocalMarkdownLinks.current
    val opener = LocalLinkOpener.current
    val handler = LocalUriHandler.current
    Column(
        modifier = Modifier.padding(vertical = MarkdownSpec.buttonMargin).fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(MarkdownSpec.buttonGap),
    ) {
        for (link in links) {
            val url = link.url ?: continue
            if (onLink == null && opener?.opens(url) != true) {
                Text(link.text, style = MarkdownSpec.text, color = HappyTheme.colors.text, modifier = Modifier.testTag(MarkdownTags.BUTTON_INERT))
            } else {
                Box(Modifier.testTag(MarkdownTags.BUTTON)) {
                    RoundButton(link.text, onClick = { if (onLink != null) onLink(url) else handler.openUri(url) }, size = RoundButtonSize.Normal)
                }
            }
        }
    }
}

@Composable
private fun rememberSpans(spans: List<MarkdownSpan>): AnnotatedString {
    val text = HappyTheme.colors.text
    val links = LocalMarkdownLinks.current
    return remember(spans, text, links) { spansToAnnotatedString(spans, links) }
}

/**
 * Rendered spans as text; its web links tap and long-press through the
 * screen's [LinkOpener][com.slopus.happy.ui.browser.LinkOpener] where there is one.
 */
@Composable
private fun SpansText(spans: List<MarkdownSpan>, style: TextStyle, color: Color, modifier: Modifier = Modifier, onLayout: ((TextLayoutResult) -> Unit)? = null) {
    val text = rememberSpans(spans)
    val layout = remember { mutableStateOf<TextLayoutResult?>(null) }
    Text(
        text = text,
        style = style,
        color = color,
        onTextLayout = {
            layout.value = it
            onLayout?.invoke(it)
        },
        modifier = modifier.webLinkGestures(text, layout).revealText(layout),
    )
}

/**
 * The heading ramp MarkdownView draws with, h1 to h6, each a style and its
 * margins above and below: the chat's [MarkdownSpec.headers] unless a
 * document's ([MarkdownSpec.documentHeaders]) is provided, as iOS passes
 * `header:` to its MarkdownPiece.
 */
val LocalMarkdownHeadings = staticCompositionLocalOf { MarkdownSpec.headers }

/** Where MarkdownView's links go when its caller handles them; null for the system's (http(s) only). */
private val LocalMarkdownLinks = staticCompositionLocalOf<((String) -> Unit)?> { null }

private val LinkStyles = TextLinkStyles(style = ComposeSpanStyle(textDecoration = TextDecoration.Underline))

/** RenderSpans: each span's styles over the block's, http(s) links tappable. */
fun spansToAnnotatedString(spans: List<MarkdownSpan>, onLink: ((String) -> Unit)? = null): AnnotatedString = buildAnnotatedString {
    for (span in spans) {
        val style = ComposeSpanStyle(
            fontWeight = if (SpanStyle.Bold in span.styles || SpanStyle.Semibold in span.styles) FontWeight.SemiBold else null,
            fontStyle = if (SpanStyle.Italic in span.styles) FontStyle.Italic else null,
            fontFamily = if (SpanStyle.Code in span.styles) AppMono else null,
        )
        val url = span.url
        if (url != null && onLink != null) {
            withLink(LinkAnnotation.Clickable(url, LinkStyles) { onLink(url) }) { withStyle(style) { append(span.text) } }
        } else if (url != null && isHttpMarkdownLink(url)) {
            withLink(LinkAnnotation.Url(url, LinkStyles)) { withStyle(style) { append(span.text) } }
        } else {
            withStyle(style) { append(span.text) }
        }
    }
}

@Composable
private fun ListBlock(items: List<Triple<String, Int, List<MarkdownSpan>>>) {
    val color = HappyTheme.colors.text
    Column(
        modifier = Modifier.padding(bottom = MarkdownSpec.listMarginBottom).testTag(MarkdownTags.LIST),
        verticalArrangement = Arrangement.spacedBy(MarkdownSpec.listGap),
    ) {
        for ((marker, depth, spans) in items) {
            Row(modifier = Modifier.padding(start = MarkdownSpec.listIndent * depth)) {
                Text(
                    text = marker,
                    style = MarkdownSpec.text,
                    color = color,
                    modifier = Modifier.padding(end = MarkdownSpec.bulletGap, top = 1.dp),
                )
                SpansText(spans = spans, style = MarkdownSpec.text, color = color, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun CodeBlock(content: String, language: String?) {
    val colors = HappyTheme.colors
    val chat = ChatTheme.colors
    val copy = rememberCopyText()
    var copied by remember { mutableStateOf(false) }
    val style = LocalCodeCopy.current
    LaunchedEffect(copied) {
        if (copied) {
            delay(if (style == CodeCopy.Icon) MarkdownSpec.ICON_COPIED_MILLIS else MarkdownSpec.COPIED_MILLIS)
            copied = false
        }
    }
    // A row scrolled away loses its `remember`; the cache spares the tokenizer when it comes back.
    val highlighted = remember(content, language, chat) { HighlightCache.get(content, language, chat) }
    Box(
        modifier = Modifier
            .padding(vertical = MarkdownSpec.codeMarginVertical)
            .testTag(MarkdownTags.CODE_BLOCK)
            .fillMaxWidth()
            .clip(RoundedCornerShape(MarkdownSpec.codeRadius))
            .background(colors.surfaceHighest),
    ) {
        Column {
            if (language != null) {
                Text(
                    text = language,
                    style = MarkdownSpec.codeLanguage,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 8.dp, start = MarkdownSpec.codePadding, end = MarkdownSpec.codePadding),
                )
            }
            Box(modifier = Modifier.horizontalScroll(rememberScrollState())) {
                val layout = remember { mutableStateOf<TextLayoutResult?>(null) }
                Text(
                    text = highlighted,
                    style = MarkdownSpec.codeText,
                    softWrap = false,
                    onTextLayout = { layout.value = it },
                    modifier = Modifier.padding(MarkdownSpec.codePadding).revealText(layout),
                )
            }
        }
        if (style == CodeCopy.Icon) {
            val label = stringResource(if (copied) R.string.common_copied else R.string.markdown_copy_code)
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .size(MarkdownSpec.copyIconReach)
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                        copy(content)
                        copied = true
                    }
                    .clearAndSetSemantics {
                        contentDescription = label
                        role = Role.Button
                        testTag = MarkdownTags.CODE_COPY
                    },
            ) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = MarkdownSpec.copyIconInset, end = MarkdownSpec.copyIconInset)
                        .size(MarkdownSpec.copyIconBox)
                        .clip(RoundedCornerShape(6.dp))
                        .background(colors.surfaceHighest),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        if (copied) Ionicon.CheckmarkOutline else Ionicon.CopyOutline,
                        MarkdownSpec.copyIcon,
                        if (copied) colors.success else colors.textSecondary,
                        Modifier.testTag(MarkdownTags.CODE_COPY_GLYPH),
                    )
                }
            }
        } else {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 8.dp, end = 8.dp)
                    .testTag(MarkdownTags.CODE_COPY)
                    .clip(RoundedCornerShape(4.dp))
                    .background(if (copied) colors.success else colors.surfaceHighest)
                    .border(1.dp, if (copied) colors.success else colors.divider, RoundedCornerShape(4.dp))
                    .clickable(role = Role.Button) {
                        copy(content)
                        copied = true
                    }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                Text(
                    text = stringResource(if (copied) R.string.common_copied else R.string.common_copy),
                    style = MarkdownSpec.copyButtonText,
                    color = colors.text,
                )
            }
        }
    }
}

/**
 * How a code block offers its copy: happy-app's always-shown "Copy" pill
 * (the relay chat), or desktop's icon (3365ef9f, 3e08585d) that turns into
 * a check for 1.6 s, which a Happy Agent chat provides.
 */
enum class CodeCopy { Pill, Icon }

val LocalCodeCopy = staticCompositionLocalOf { CodeCopy.Pill }

/**
 * Highlighted code blocks by (code, language, palette), most recent first,
 * so a block scrolling back into view isn't tokenized again. Bounded by
 * count; blocks are capped by size elsewhere.
 */
internal object HighlightCache {
    private const val MAX_ENTRIES = 64
    private data class Key(val code: String, val language: String?, val colors: ChatColors)
    private val entries = object : LinkedHashMap<Key, AnnotatedString>(MAX_ENTRIES, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Key, AnnotatedString>?) = size > MAX_ENTRIES
    }

    /** How many blocks were tokenized; tests read it. */
    @Volatile
    var misses = 0
        private set

    @Synchronized
    fun get(code: String, language: String?, colors: ChatColors): AnnotatedString =
        entries.getOrPut(Key(code, language, colors)) {
            misses++
            highlight(code, language, colors)
        }

    @Synchronized
    fun clear() {
        entries.clear()
        misses = 0
    }
}

/** SimpleSyntaxHighlighter's colours by token type. */
internal fun highlight(code: String, language: String?, colors: ChatColors): AnnotatedString = buildAnnotatedString {
    for (token in tokenizeCode(code, language)) {
        val color = when (token.type) {
            SyntaxTokenType.Keyword, SyntaxTokenType.ControlFlow, SyntaxTokenType.Type, SyntaxTokenType.Modifier,
            SyntaxTokenType.Assignment, SyntaxTokenType.Comparison, SyntaxTokenType.Logical, SyntaxTokenType.Decorator,
            SyntaxTokenType.Import,
            -> colors.syntaxKeyword
            SyntaxTokenType.String, SyntaxTokenType.Regex -> colors.syntaxString
            SyntaxTokenType.Number, SyntaxTokenType.Boolean -> colors.syntaxNumber
            SyntaxTokenType.Function, SyntaxTokenType.Method -> colors.syntaxFunction
            SyntaxTokenType.Comment, SyntaxTokenType.Docstring -> colors.syntaxComment
            SyntaxTokenType.Bracket -> colors.syntaxBrackets[(token.nestLevel.coerceAtLeast(1) - 1) % 5]
            else -> colors.syntaxDefault
        }
        withStyle(ComposeSpanStyle(color = color, fontWeight = if (token.type.emphasized) FontWeight.SemiBold else FontWeight.Normal)) {
            append(token.text)
        }
    }
}

@Composable
private fun OptionsBlock(items: List<String>, onOptionPress: ((String) -> Unit)?) {
    val colors = HappyTheme.colors
    Column(
        modifier = Modifier.padding(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(MarkdownSpec.optionGap),
    ) {
        for (item in items) {
            Box(
                modifier = Modifier
                    .testTag(MarkdownTags.OPTION)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(MarkdownSpec.optionRadius))
                    .background(colors.surfaceHighest)
                    .then(if (onOptionPress != null) Modifier.clickable(role = Role.Button) { onOptionPress(item) } else Modifier)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Text(text = item, style = MarkdownSpec.optionText, color = colors.text)
            }
        }
    }
}

private fun columnWidth(chars: Int): Dp = (chars * MarkdownSpec.TABLE_CHAR_WIDTH + MarkdownSpec.TABLE_CELL_H_PADDING)
    .coerceIn(MarkdownSpec.TABLE_MIN_COL_WIDTH, MarkdownSpec.TABLE_MAX_COL_WIDTH).dp

@Composable
private fun TableBlock(table: MarkdownBlock.Table) {
    val colors = HappyTheme.colors
    val widths = remember(table) {
        table.headers.indices.map { c ->
            val longest = maxOf(
                table.headers[c].sumOf { it.text.length },
                table.rows.maxOfOrNull { row -> row.getOrNull(c)?.sumOf { it.text.length } ?: 0 } ?: 0,
            )
            columnWidth(longest)
        }
    }
    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier = Modifier
            .padding(vertical = 8.dp)
            .testTag(MarkdownTags.TABLE)
            .clip(shape)
            .border(1.dp, colors.divider, shape),
    ) {
        Column(modifier = Modifier.horizontalScroll(rememberScrollState())) {
            TableRow(table.headers, widths, header = true, divider = true)
            table.rows.forEachIndexed { index, row ->
                TableRow(table.headers.indices.map { row.getOrNull(it).orEmpty() }, widths, header = false, divider = index < table.rows.lastIndex)
            }
        }
    }
}

@Composable
private fun TableRow(cells: List<List<MarkdownSpan>>, widths: List<Dp>, header: Boolean, divider: Boolean) {
    val colors = HappyTheme.colors
    Column {
        Row(modifier = Modifier.height(IntrinsicSize.Min)) {
            cells.forEachIndexed { index, spans ->
                Box(
                    modifier = Modifier
                        .width(widths[index])
                        .fillMaxHeight()
                        .background(if (header) colors.surfaceHigh else Color.Transparent)
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    SpansText(
                        spans = spans,
                        style = if (header) MarkdownSpec.tableHeaderText else MarkdownSpec.tableCellText,
                        color = colors.text,
                    )
                }
                if (index < cells.lastIndex) Box(Modifier.width(1.dp).fillMaxHeight().background(colors.divider))
            }
        }
        if (divider) Box(Modifier.height(1.dp).width(widths.fold(0.dp) { a, b -> a + b } + (widths.size - 1).coerceAtLeast(0).dp).background(colors.divider))
    }
}
