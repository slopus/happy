package com.slopus.happy.ui.components

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.theme.HappyTheme

object SwitchTags {
    const val SWITCH = "switch"
    const val THUMB = "switch.thumb"
}

/** RN's Android Switch (AppCompat's SwitchCompat): a 48x48 target, a 34x14 track and a 20 thumb. */
object SwitchSpec {
    val target = 48.dp
    val trackWidth = 34.dp
    val trackHeight = 14.dp
    val thumb = 20.dp
}

/**
 * Switch.tsx on Android: RN's platform switch with the theme's colours, the
 * active track in `switch.track.active`, the inactive one in
 * `switch.track.inactive`, and the thumb in `switch.thumb.active` either
 * way (happy-app sets one thumb colour). Disabled is drawn at 50%.
 * [label] is what TalkBack reads with the state: RN's platform switch reads
 * none, so a row passes its title rather than leave the switch unnamed.
 */
@Composable
fun HappySwitch(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    label: String? = null,
) {
    val colors = HappyTheme.colors.switch
    val track by animateColorAsState(if (checked) colors.trackActive else colors.trackInactive, label = "track")
    val travel = SwitchSpec.trackWidth - SwitchSpec.thumb + 6.dp
    val thumbOffset by animateDpAsState(if (checked) travel / 2 else -travel / 2, label = "thumb")
    Box(
        modifier = modifier
            .size(SwitchSpec.target)
            .alpha(if (enabled) 1f else 0.5f)
            .then(
                if (onCheckedChange != null) {
                    Modifier.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
                } else {
                    Modifier
                },
            )
            .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier)
            .testTag(SwitchTags.SWITCH),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(SwitchSpec.trackWidth, SwitchSpec.trackHeight)
                .background(track, RoundedCornerShape(SwitchSpec.trackHeight / 2)),
        )
        Box(
            Modifier
                // Read at placement, so the slide neither recomposes nor remeasures.
                .offset { IntOffset(thumbOffset.roundToPx(), 0) }
                .size(SwitchSpec.thumb)
                .shadow(2.dp, CircleShape)
                .background(colors.thumbActive, CircleShape)
                .testTag(SwitchTags.THUMB),
        )
    }
}
