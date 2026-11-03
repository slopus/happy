package com.slopus.happy.ui.artifacts

import com.slopus.happy.ui.tablet.BackOrSidebarToggle
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.GlassBarScreen
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.connection.AgentTopBar
import com.slopus.happy.ui.conversation.ConversationScreenTags
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object PlaceTags {
    const val BAR = "place.bar"
    const val LOADER = "place.loader"
    const val MESSAGE = "place.message"
    const val SUBTITLE = "place.subtitle"
}

/**
 * The bar of an agent's place (artifacts, an artifact, a Surface, a page):
 * back (or, [closes], a close: the in-app browser, whose system back walks
 * its history first), the title on one line with [subtitle] under it, and
 * [actions]; glass over the page's own surface ([GlassBarScreen]), as
 * home's bar is, the content held below it. [bar] takes the bar's place
 * while given (a search field).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PlaceScaffold(
    title: String,
    onBack: () -> Unit,
    tag: String,
    actions: @Composable RowScope.() -> Unit = {},
    subtitle: String? = null,
    closes: Boolean = false,
    bar: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val colors = HappyTheme.colors
    GlassBarScreen(
        modifier = Modifier.fillMaxSize().background(colors.surface).testTag(tag),
        ground = colors.surface,
        bar = bar ?: {
            AgentTopBar(
                tag = PlaceTags.BAR,
                container = colors.surface,
                navigationIcon = {
                    BackOrSidebarToggle {
                        IconButton(onClick = onBack, modifier = Modifier.testTag(ConversationScreenTags.BACK)) {
                            if (closes) Icon(MaterialSymbols.Close, stringResource(R.string.browser_close))
                            else Icon(MaterialSymbols.ArrowBack, stringResource(R.string.common_back))
                        }
                    }
                },
                title = {
                    Column {
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (subtitle != null) {
                            Text(
                                subtitle,
                                style = happyTextStyle(fontSize = 12, lineHeight = 16),
                                color = colors.textSecondary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.testTag(PlaceTags.SUBTITLE),
                            )
                        }
                    }
                },
                actions = actions,
            )
        },
    ) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) { content() }
    }
}

/** iOS's message label on these screens: 15pt in the row grey, centred, 16 in from the sides, 8 down. */
@Composable
internal fun PlaceMessage(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = happyTextStyle(fontSize = 15, lineHeight = 20),
        color = HappyTheme.colors.textSecondary,
        textAlign = TextAlign.Center,
        modifier = modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp).testTag(PlaceTags.MESSAGE),
    )
}
