package com.slopus.happy.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.MachineChoice
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object EmptySessionsTabletTags {
    const val ROOT = "emptySessionsTablet"
    const val ICON = "emptySessionsTablet.icon"
    const val TITLE = "emptySessionsTablet.title"
    const val DESCRIPTION = "emptySessionsTablet.description"
    const val BUTTON = "emptySessionsTablet.button"
}

/** EmptySessionsTablet.tsx. */
object EmptySessionsTabletSpec {
    val paddingHorizontal = 48.dp
    val icon = 64.dp
    val iconGap = 24.dp
    val titleGap = 8.dp
    val descriptionGap = 24.dp
    val buttonPaddingHorizontal = 24.dp
    val buttonPaddingVertical = 12.dp
    val buttonRadius = 12.dp
    val buttonIcon = 20.dp
    val buttonIconGap = 8.dp
    val title = happyTextStyle(fontSize = 20)
    val description = happyTextStyle(fontSize = 16)
    val button = happyTextStyle(fontSize = 16, weight = FontWeight.SemiBold)
}

/**
 * The sidebar with no sessions to list, centred, 48 in from the sides: a 64
 * glyph 24 above a 20 title, 8 above a 16 description, 24 above a button
 * padded 12/24 and rounded 12 with a 20 glyph 8 before its 16 semibold label.
 * - A reachable computer: terminal, "No sessions yet", start a new session.
 * - Computers, none reachable: cloud-offline, the one computer's name (or
 *   "No machines are reachable"), troubleshoot.
 * - None linked: terminal, "No sessions yet", install Happy; no button.
 */
@Composable
fun EmptySessionsTablet(
    machines: List<MachineChoice>,
    onNewSession: () -> Unit,
    onTroubleshoot: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = HappyTheme.colors
    val hasOnline = machines.any { it.online }
    val hasOffline = machines.isNotEmpty() && !hasOnline
    val title = when {
        !hasOffline -> stringResource(R.string.tablet_no_sessions_title)
        machines.size == 1 -> stringResource(R.string.tablet_machine_unreachable, machines[0].name)
        else -> stringResource(R.string.tablet_no_machines_reachable)
    }
    Column(
        modifier = modifier
            .fillMaxSize()
            .testTag(EmptySessionsTabletTags.ROOT)
            .padding(horizontal = EmptySessionsTabletSpec.paddingHorizontal),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            icon = if (hasOffline) Ionicon.CloudOfflineOutline else Ionicon.TerminalOutline,
            size = EmptySessionsTabletSpec.icon,
            color = colors.textSecondary,
            modifier = Modifier.testTag(EmptySessionsTabletTags.ICON),
        )
        Spacer(Modifier.height(EmptySessionsTabletSpec.iconGap))
        Text(
            text = title,
            style = EmptySessionsTabletSpec.title,
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.testTag(EmptySessionsTabletTags.TITLE),
        )
        Spacer(Modifier.height(EmptySessionsTabletSpec.titleGap))
        Text(
            text = stringResource(
                when {
                    hasOnline -> R.string.tablet_start_description
                    hasOffline -> R.string.tablet_offline_description
                    else -> R.string.tablet_install_description
                },
            ),
            style = EmptySessionsTabletSpec.description,
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.testTag(EmptySessionsTabletTags.DESCRIPTION),
        )
        // The description's 24 margin stays without a button, so the block centres the same way.
        Spacer(Modifier.height(EmptySessionsTabletSpec.descriptionGap))
        when {
            hasOnline -> EmptyButton(Ionicon.Add, stringResource(R.string.tablet_start_new_session), onNewSession)
            hasOffline -> EmptyButton(Ionicon.HelpCircleOutline, stringResource(R.string.tablet_troubleshoot), onTroubleshoot)
            else -> Unit
        }
    }
}

@Composable
private fun EmptyButton(icon: Ionicon, label: String, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier
            .testTag(EmptySessionsTabletTags.BUTTON)
            .clip(RoundedCornerShape(EmptySessionsTabletSpec.buttonRadius))
            .background(colors.button.primaryBackground)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = EmptySessionsTabletSpec.buttonPaddingHorizontal, vertical = EmptySessionsTabletSpec.buttonPaddingVertical),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon = icon, size = EmptySessionsTabletSpec.buttonIcon, color = colors.button.primaryTint)
        Box(Modifier.width(EmptySessionsTabletSpec.buttonIconGap))
        Text(text = label, style = EmptySessionsTabletSpec.button, color = colors.button.primaryTint)
    }
}
