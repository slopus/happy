package com.slopus.happy.ui.migration

import android.content.SharedPreferences
import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.components.LineIcon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Where the Happy CLI home's migration card points (iOS ea1a0902f
 * `MigrationPath`): to Happy Desktop, or, when a Happy Agent already
 * reaches the account through the Happy server, to a direct connection.
 */
enum class MigrationPath(val wire: String, @param:StringRes val title: Int, @param:StringRes val body: Int, val icon: LineIcon) {
    Desktop("desktop", R.string.desktop_migration_desktop_title, R.string.desktop_migration_desktop_body, LineIcon.Monitor),
    AgentConnection("agentConnection", R.string.desktop_migration_agent_connection_title, R.string.desktop_migration_agent_connection_body, LineIcon.Zap),
    ;

    companion object {
        fun of(wire: String): MigrationPath? = entries.firstOrNull { it.wire == wire }

        /**
         * The card home shows, if any (iOS `DesktopMigrationCard.path`):
         * none until PostHog's flag is on for the account ([noteOn]), none
         * once this phone has an agent connection that isn't revoked, nor
         * once that path's card was closed here.
         */
        fun shown(noteOn: Boolean, agents: List<AgentConnection>, serverAgent: Boolean, closed: Set<MigrationPath>): MigrationPath? {
            if (!noteOn || agents.any { !it.revoked }) return null
            val path = if (serverAgent) AgentConnection else Desktop
            return path.takeUnless { it in closed }
        }
    }
}

/**
 * The paths whose card was closed on this phone; it holds for every account
 * here, as iOS's standard defaults do (`<path>-migration-card-closed`).
 */
class DesktopMigrationCards(private val prefs: SharedPreferences) {
    private val state = MutableStateFlow(MigrationPath.entries.filter { prefs.getBoolean(key(it), false) }.toSet())
    val closed: StateFlow<Set<MigrationPath>> = state.asStateFlow()

    fun close(path: MigrationPath) {
        prefs.edit().putBoolean(key(path), true).apply()
        state.value += path
    }

    companion object {
        const val PREFS_NAME = "desktop-migration"
        fun key(path: MigrationPath) = "${path.wire}-migration-card-closed"
    }
}

object DesktopCardTags {
    const val CARD = "desktopCard"
    const val ICON = "desktopCard.icon"
    const val TITLE = "desktopCard.title"
    const val BODY = "desktopCard.body"
    const val CLOSE = "desktopCard.close"
}

/** iOS `DesktopCardLayout.Metrics`, with Android's Item icon slot. */
object DesktopCardSpec {
    val padding = 16.dp
    val icon = ItemSpec.iconSize
    val iconGap = 12.dp
    /** The title's first line, which the icon is level with. */
    val titleLine = 22.dp
    val bodyGap = 2.dp
    val close = 44.dp
    val closeGlyph = 17.dp
    val closeInset = 4.dp
    val title = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold)
    val body = happyTextStyle(fontSize = 15, lineHeight = 21)
}

/**
 * The Happy CLI home's migration card, the first notice over the list, in
 * its group's card (iOS `DesktopCardView`):
 *
 *     |16| icon 32 |12| title            |  × 44 |4|
 *                       2
 *                       body, any lines
 *     16
 *
 * The path's line icon is level with the title's first line; the words
 * stop short of the close target in the top end corner. A tap anywhere
 * opens the migration screen; × closes the card for good. TalkBack reads it
 * as one button, its title then its words, with Close among its actions.
 */
@Composable
fun DesktopMigrationCard(path: MigrationPath, onOpen: () -> Unit, onClose: () -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val closeLabel = stringResource(R.string.desktop_migration_close)
    val iconTop = DesktopCardSpec.padding + (DesktopCardSpec.titleLine - DesktopCardSpec.icon) / 2
    Box(
        modifier
            .fillMaxWidth()
            .testTag(DesktopCardTags.CARD)
            .clickable(role = Role.Button, onClick = onOpen)
            .semantics(mergeDescendants = true) {
                customActions = listOf(CustomAccessibilityAction(closeLabel) { onClose(); true })
            },
    ) {
        Row(
            Modifier.padding(
                start = DesktopCardSpec.padding,
                top = minOf(iconTop, DesktopCardSpec.padding),
                end = DesktopCardSpec.closeInset + DesktopCardSpec.close,
                bottom = DesktopCardSpec.padding,
            ),
        ) {
            LineIcon(
                path.icon,
                DesktopCardSpec.icon,
                colors.text,
                Modifier.padding(top = (iconTop - DesktopCardSpec.padding).coerceAtLeast(0.dp)).testTag(DesktopCardTags.ICON),
            )
            Spacer(Modifier.width(DesktopCardSpec.iconGap))
            Column(Modifier.padding(top = (DesktopCardSpec.padding - iconTop).coerceAtLeast(0.dp))) {
                Text(stringResource(path.title), style = DesktopCardSpec.title, color = colors.text, modifier = Modifier.testTag(DesktopCardTags.TITLE))
                Spacer(Modifier.height(DesktopCardSpec.bodyGap))
                Text(stringResource(path.body), style = DesktopCardSpec.body, color = colors.textSecondary, modifier = Modifier.testTag(DesktopCardTags.BODY))
            }
        }
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .padding(top = DesktopCardSpec.closeInset, end = DesktopCardSpec.closeInset)
                .testTag(DesktopCardTags.CLOSE)
                .size(DesktopCardSpec.close)
                // TalkBack closes it through the card's action, so the card stays one button.
                .clearAndSetSemantics { }
                .clip(CircleShape)
                .clickable(onClick = onClose),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Ionicon.Close, DesktopCardSpec.closeGlyph, colors.textSecondary)
        }
    }
}
