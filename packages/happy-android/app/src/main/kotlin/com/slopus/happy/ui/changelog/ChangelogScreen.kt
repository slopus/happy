package com.slopus.happy.ui.changelog

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderBackButton
import com.slopus.happy.ui.components.ItemGroupSpec
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ChangelogTags {
    const val HEADER_IMAGE = "changelog.headerImage"
    const val TITLE = "changelog.title"
    const val CARD = "changelog.card"
    const val SUMMARY = "changelog.summary"
    const val EMPTY = "changelog.empty"
}

/** changelog.tsx's stylesheet and its header in app/(app)/_layout.tsx. */
object ChangelogSpec {
    val headerTitle = happyTextStyle(fontSize = 16, weight = FontWeight.SemiBold)
    val headerGap = 6.dp
    val headerImage = 40.dp
    val title = happyTextStyle(fontSize = 20, lineHeight = 28, weight = FontWeight.SemiBold)
    val titleGap = 8.dp
    val titleImage = 28.dp
    val contentPaddingHorizontal = 16.dp
    val contentPaddingTop = 14.dp
    val contentPaddingBottom = 6.dp
    val summary = happyTextStyle(fontSize = 16, lineHeight = 23)
    val summaryGap = 16.dp
    val summaryImage = 20.dp
    val summaryImageShift = 3.dp
    val emptyPadding = 40.dp
    val empty = happyTextStyle(fontSize = 16, lineHeight = 24)
}

private val SummaryLinkStyles = TextLinkStyles(style = SpanStyle(textDecoration = TextDecoration.Underline))

/** SummaryLine: 16/23 text, links underlined and opened, bundled images inline at 20, 3 lower. */
@Composable
private fun SummaryLine(summary: String) {
    val density = LocalDensity.current
    val segments = remember(summary) { parseSummary(summary) }
    val images = segments.filterIsInstance<SummarySegment.Image>().mapNotNull { segment -> Changelog.images[segment.path]?.let { segment.path to it } }.toMap()
    val text = buildAnnotatedString {
        for (segment in segments) {
            when (segment) {
                is SummarySegment.Text -> append(segment.text)
                is SummarySegment.Link -> withLink(LinkAnnotation.Url(segment.url, SummaryLinkStyles)) { append(segment.label) }
                is SummarySegment.Image -> if (segment.path in images) appendInlineContent(segment.path)
            }
        }
    }
    val size = with(density) { ChangelogSpec.summaryImage.toSp() }
    val inline = images.mapValues { (_, drawable) ->
        InlineTextContent(Placeholder(size, size, PlaceholderVerticalAlign.AboveBaseline)) {
            Image(
                painterResource(drawable),
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize().offset(y = ChangelogSpec.summaryImageShift),
            )
        }
    }
    Text(
        text,
        style = ChangelogSpec.summary,
        color = HappyTheme.colors.text,
        inlineContent = inline,
        modifier = Modifier.padding(bottom = ChangelogSpec.summaryGap).testTag(ChangelogTags.SUMMARY),
    )
}

/**
 * An ItemGroup whose title is the entry's: 20/28 semibold in the text
 * colour, not uppercased, with its bundled image (28) 8 after it.
 */
@Composable
private fun EntryGroup(entry: ChangelogEntry, content: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(ItemGroupSpec.cardRadius)
    val border = hairline()
    Column(Modifier.fillMaxWidth().padding(horizontal = ItemGroupSpec.paddingHorizontal)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(
                start = ItemGroupSpec.headerPaddingHorizontal,
                end = ItemGroupSpec.headerPaddingHorizontal,
                top = ItemGroupSpec.headerPaddingTop,
                bottom = ItemGroupSpec.headerPaddingBottom,
            ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ChangelogSpec.titleGap),
        ) {
            Text(entry.title, style = ChangelogSpec.title, color = colors.text, modifier = Modifier.testTag(ChangelogTags.TITLE))
            entry.titleImage?.let { Changelog.images[it] }?.let { image ->
                Image(painterResource(image), contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.size(ChangelogSpec.titleImage))
            }
        }
        Column(
            modifier = Modifier
                .padding(horizontal = ItemGroupSpec.cardMarginHorizontal)
                .fillMaxWidth()
                .testTag(ChangelogTags.CARD)
                .clip(shape)
                .background(colors.surface)
                .border(border, colors.divider, shape)
                .padding(border),
        ) { content() }
    }
}

/**
 * What's New (app/(app)/changelog.tsx). The header reads "What's New" (16
 * semibold) with the 40 mouse-on-the-phone picture 6 after it. One group
 * per release, newest first, titled with the release; its card holds the
 * summary line and the release notes as markdown, padded 16 at the sides,
 * 14 above and 6 below. Opening the screen marks the newest release read.
 * With no entries, "No changelog entries available." (16/24, secondary)
 * is centred in 40 of padding.
 */
@Composable
fun ChangelogScreen(changelog: Changelog, onViewed: (String) -> Unit, onBack: () -> Unit) {
    val colors = HappyTheme.colors
    LaunchedEffect(changelog.latestTitle) {
        if (changelog.latestTitle.isNotEmpty()) onViewed(changelog.latestTitle)
    }
    val markdown = remember(changelog) { changelog.entries.map { parseMarkdown(it.markdown) } }
    Screen(
        header = {
            Header(
                left = { HeaderBackButton(onClick = onBack) },
                titleContent = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ChangelogSpec.headerGap)) {
                        Text(stringResource(R.string.navigation_whats_new), style = ChangelogSpec.headerTitle, color = colors.header.tint, maxLines = 1)
                        Image(
                            painterResource(R.drawable.changelog_mouse_on_the_phone),
                            contentDescription = null,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.size(ChangelogSpec.headerImage).testTag(ChangelogTags.HEADER_IMAGE),
                        )
                    }
                },
            )
        },
    ) {
        if (changelog.entries.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(ChangelogSpec.emptyPadding), contentAlignment = Alignment.Center) {
                Text(
                    stringResource(R.string.changelog_no_entries_available),
                    style = ChangelogSpec.empty,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag(ChangelogTags.EMPTY),
                )
            }
            return@Screen
        }
        ItemList {
            changelog.entries.forEachIndexed { index, entry ->
                EntryGroup(entry) {
                    Column(
                        Modifier.padding(
                            start = ChangelogSpec.contentPaddingHorizontal,
                            end = ChangelogSpec.contentPaddingHorizontal,
                            top = ChangelogSpec.contentPaddingTop,
                            bottom = ChangelogSpec.contentPaddingBottom,
                        ),
                    ) {
                        if (entry.summary.isNotEmpty()) SummaryLine(entry.summary)
                        if (entry.markdown.isNotEmpty()) MarkdownView(markdown[index])
                    }
                }
            }
        }
    }
}
