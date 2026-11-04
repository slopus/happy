package com.slopus.happy.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.call.VoiceGlyph
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.AgentSearchField
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object SidebarTags {
    const val SIDEBAR = "sidebar"
    const val SETTINGS = "sidebar.settings"
    const val COMPOSE = "sidebar.compose"
    const val VOICE = "sidebar.voice"
    const val SEARCH = "sidebar.search"
    const val SEARCH_CANCEL = "sidebar.searchCancel"
}

/**
 * Set around the account's home while it is the tablet's sidebar (iOS
 * `SidebarColumnTrait`): home then wears the sidebar's chrome, not the
 * phone's, and marks [selected], the row of what the main panel's root
 * is ([MainPanelKey]).
 */
@Immutable
data class SidebarHome(val selected: String? = null)

val LocalSidebarHome = compositionLocalOf<SidebarHome?> { null }

/** happy-ios SidebarChromeLayout.swift: SidebarBottomBarLayout and SidebarSearchLayout's metrics. */
object SidebarSpec {
    /** Off the sidebar's sides: the cards' inset. */
    val side = 16.dp
    /** Above its foot and the navigation bar (a tablet's taskbar is a solid bar, not iOS's home indicator). */
    val bottom = 16.dp
    /** Both controls' height; settings is a circle this wide. */
    val barHeight = 48.dp
    /** The least room between settings and the pill. */
    val spacing = 12.dp
    val settingsIcon = 22.dp
    val composeIcon = 20.dp
    val composeIconGap = 8.dp
    val composeStart = 18.dp
    val composeEnd = 20.dp
    val composeText = happyTextStyle(fontSize = 16, weight = FontWeight.SemiBold)
    val shadow = 6.dp

    /** From the bar's foot to the search field at rest. */
    val searchTop = 8.dp
    val searchHeight = 36.dp
    /** From the field to the list. */
    val searchGap = 4.dp
    val searchCancelSpacing = 8.dp
    val searchIcon = 18.dp
    val searchText = happyTextStyle(fontSize = 16, lineHeight = 22)
    val cancelText = happyTextStyle(fontSize = 16, weight = FontWeight.Medium)

    /** The list's room at its end to scroll its last row clear of the bar. */
    @Composable
    fun listClearance(): Dp = footInset() + barHeight + bottom

    @Composable
    internal fun footInset(): Dp = bottom + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
}

/**
 * Home's bar at the sidebar's foot (iOS SidebarBottomBar): settings in a
 * 48 circle at the bottom start, and compose at the bottom end as the
 * column's one prominent action, a 48 pill in the app's primary (the send
 * button's: black, light in dark) that says what it starts,
 * [composeTitle]. Both 16 off the sidebar's sides and 16 above its foot
 * and the navigation bar, 12 apart at least; the pill is held to what is
 * left. Without [composeTitle] (nothing can be started)
 * settings is alone. With [onVoice], an agent connection's home has the
 * voice call's button immediately before the pill, a 48 circle like
 * settings wearing the three bars ([VoiceGlyph]), 12 apart, as the phone's
 * voice button sits beside compose. Put it last in a box over the list.
 */
@Composable
fun BoxScope.SidebarFootBar(composeTitle: String?, onSettings: () -> Unit, onCompose: () -> Unit, onVoice: (() -> Unit)? = null) {
    val colors = HappyTheme.colors
    val settingsLabel = stringResource(R.string.settings_title)
    Row(
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .fillMaxWidth()
            .padding(start = SidebarSpec.side, end = SidebarSpec.side, bottom = SidebarSpec.footInset()),
        horizontalArrangement = Arrangement.spacedBy(SidebarSpec.spacing),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FootCircle(settingsLabel, onSettings, SidebarTags.SETTINGS) {
            Icon(Ionicon.SettingsOutline, SidebarSpec.settingsIcon, colors.header.tint)
        }
        if (composeTitle != null) Row(
            Modifier.weight(1f),
            horizontalArrangement = Arrangement.spacedBy(SidebarSpec.spacing, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onVoice != null) FootCircle(stringResource(R.string.call_start), onVoice, SidebarTags.VOICE) {
                VoiceGlyph(SidebarSpec.settingsIcon, colors.header.tint)
            }
            val fill = if (colors.dark) Color(0xFFF5F5F5) else colors.button.primaryBackground
            val text = if (colors.dark) Color(0xFF111111) else colors.button.primaryTint
            val pill = RoundedCornerShape(percent = 50)
            Row(
                modifier = Modifier
                    .height(SidebarSpec.barHeight)
                    .shadow(SidebarSpec.shadow, pill)
                    .clip(pill)
                    .background(fill)
                    .clickable(role = Role.Button, onClick = onCompose)
                    .testTag(SidebarTags.COMPOSE)
                    .padding(start = SidebarSpec.composeStart, end = SidebarSpec.composeEnd),
                horizontalArrangement = Arrangement.spacedBy(SidebarSpec.composeIconGap),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Ionicon.CreateOutline, SidebarSpec.composeIcon, text)
                Text(composeTitle, style = SidebarSpec.composeText, color = text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** One of the foot's 48 circles: its glyph on the raised surface, shadowed, a hairline in dark. */
@Composable
private fun FootCircle(label: String, onClick: () -> Unit, tag: String, glyph: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    Box(
        modifier = Modifier
            .size(SidebarSpec.barHeight)
            .shadow(SidebarSpec.shadow, CircleShape)
            .clip(CircleShape)
            .background(colors.surfaceHigh)
            // Dark shades no shadow: a hairline keeps the circle's edge.
            .border(hairline(), colors.divider, CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label }
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        glyph()
    }
}

/**
 * Agent home's search as the sidebar has it (iOS SidebarSearchField), 36
 * tall, 16 in from the sides: at rest a field that opens search when
 * tapped; while [open] the field itself, focused, with Cancel 8 after it,
 * which ends the search. Home puts the resting one at the top of its list,
 * so it scrolls with the rows, and holds the open one at that rest.
 */
@Composable
fun SidebarSearchField(
    open: Boolean,
    query: String,
    onQueryChange: (String) -> Unit,
    onOpen: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = HappyTheme.colors
    val placeholder = stringResource(R.string.tools_names_search)
    Row(
        modifier = modifier.fillMaxWidth().padding(horizontal = SidebarSpec.side).height(SidebarSpec.searchHeight),
        horizontalArrangement = Arrangement.spacedBy(SidebarSpec.searchCancelSpacing),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .height(SidebarSpec.searchHeight)
                .clip(RoundedCornerShape(percent = 50))
                .background(colors.surfaceHigh)
                .then(if (open) Modifier else Modifier.clickable(role = Role.Button, onClickLabel = placeholder, onClick = onOpen))
                .testTag(SidebarTags.SEARCH)
                .padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Ionicon.SearchOutline, SidebarSpec.searchIcon, colors.textSecondary)
            if (open) {
                AgentSearchField(query, onQueryChange, placeholder = placeholder)
            } else {
                Text(placeholder, style = SidebarSpec.searchText, color = colors.input.placeholder, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (open) {
            Text(
                stringResource(R.string.common_cancel),
                style = SidebarSpec.cancelText,
                color = colors.header.tint,
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(role = Role.Button, onClick = onCancel)
                    .testTag(SidebarTags.SEARCH_CANCEL)
                    .padding(vertical = 6.dp),
            )
        }
    }
}
