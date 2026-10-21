package com.slopus.happy.ui.components

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ItemGroupTags {
    const val HEADER = "itemGroup.header"
    const val CARD = "itemGroup.card"
    const val FOOTER = "itemGroup.footer"
}

/** ItemGroup.tsx and ItemList.tsx, Android branch. */
object ItemGroupSpec {
    val paddingHorizontal = 4.dp
    val headerPaddingTop = 16.dp
    val headerPaddingBottom = 8.dp
    val headerPaddingHorizontal = 24.dp
    val noTitleSpacer = 16.dp
    val cardMarginHorizontal = 12.dp
    val cardRadius = 14.dp
    val footerPaddingTop = 8.dp
    val footerPaddingBottom = 16.dp
    val footerPaddingHorizontal = 24.dp
    val listPaddingBottom = 16.dp
    val header = happyTextStyle(fontSize = 14, lineHeight = 20, letterSpacing = 0.1f, weight = FontWeight.Medium)
    val footer = happyTextStyle(fontSize = 14, lineHeight = 20)
}

/** StyleSheet.hairlineWidth on Android: one physical pixel. */
@Composable
fun hairline(): Dp = with(LocalDensity.current) { 1f.toDp() }

/**
 * A titled card of [Item]s.
 *
 * Spec (Android): 4 side padding. With a title: header 16 top, 8 bottom, 24
 * sides, text 14/20 uppercase (tracking 0.1, weight 500), section-title
 * colour. Without: a 16 spacer. The card is inset 12 more per side, radius
 * 14, surface colour, a hairline divider-coloured border that, as in Yoga,
 * also insets the content. Footer 8 top, 16 bottom, 24 sides, 14/20.
 */
@Composable
fun ItemGroup(
    modifier: Modifier = Modifier,
    title: String? = null,
    footer: String? = null,
    /** The space above an untitled card (`headerStyle` paddingTop). */
    noTitleSpacer: Dp = ItemGroupSpec.noTitleSpacer,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(ItemGroupSpec.cardRadius)
    val border = hairline()
    // ItemGroup.tsx: centred, held to layout.maxWidth with the 4 padding inside it.
    val layout = LocalWindowLayout.current
    Column(modifier = modifier.fillMaxWidth().contentMaxWidth(layout).padding(horizontal = ItemGroupSpec.paddingHorizontal)) {
        if (title != null) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(ItemGroupTags.HEADER)
                    .padding(
                        start = ItemGroupSpec.headerPaddingHorizontal,
                        end = ItemGroupSpec.headerPaddingHorizontal,
                        top = ItemGroupSpec.headerPaddingTop,
                        bottom = ItemGroupSpec.headerPaddingBottom,
                    ),
            ) {
                Text(text = title.uppercase(), style = ItemGroupSpec.header, color = colors.grouped.sectionTitle)
            }
        } else {
            Spacer(modifier = Modifier.height(noTitleSpacer))
        }

        Column(
            modifier = Modifier
                .padding(horizontal = ItemGroupSpec.cardMarginHorizontal)
                .fillMaxWidth()
                .testTag(ItemGroupTags.CARD)
                .clip(shape)
                .background(colors.surface)
                .border(border, colors.divider, shape)
                .padding(border),
            content = content,
        )

        if (footer != null) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(ItemGroupTags.FOOTER)
                    .padding(
                        start = ItemGroupSpec.footerPaddingHorizontal,
                        end = ItemGroupSpec.footerPaddingHorizontal,
                        top = ItemGroupSpec.footerPaddingTop,
                        bottom = ItemGroupSpec.footerPaddingBottom,
                    ),
            ) {
                Text(text = footer, style = ItemGroupSpec.footer, color = colors.grouped.sectionTitle)
            }
        }
    }
}

/** ItemList: the grouped-background scroll view, 16 of bottom padding. */
@Composable
fun ItemList(
    modifier: Modifier = Modifier,
    scrollState: ScrollState = rememberScrollState(),
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(HappyTheme.colors.grouped.background)
            .verticalScroll(scrollState),
    ) {
        content()
        Spacer(modifier = Modifier.height(ItemGroupSpec.listPaddingBottom))
    }
}
