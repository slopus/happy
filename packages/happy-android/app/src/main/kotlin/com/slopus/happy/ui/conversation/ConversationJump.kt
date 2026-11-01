package com.slopus.happy.ui.conversation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.Activity
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.ShimmerSpec
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.components.shimmer
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.launch

object ConversationJumpTags {
    const val JUMP = "conversation.jump"
    /** The arrow, which wears the shimmer while the agent works. */
    const val ARROW = "conversation.jump.arrow"
}

/**
 * Desktop's way back to the newest message (`.happy-message-list__jump`)
 * as iOS's ChatJumpButton and ChatFootLayout draw it: a 32 circle on
 * surfaceHigh with a 1 divider ring and a soft shadow, the 16 arrow-down
 * in the text colour, centred 12 above where the list ends (the list keeps
 * 8 over the dock). It comes and goes as Telegram's page-down button does
 * (ChatActivity, ChatActivitySideControlsButtonsLayout): once the reader is
 * more than [threshold] from the newest message ([showsJump]), over [MOTION_MS]
 * decelerating, fading, growing from [HIDDEN_SCALE] and rising [slide]. While
 * the agent works ([jumpShimmers]) the arrow carries the sheen every working
 * thing does. A press dims the arrow to 0.6.
 */
object ConversationJumpSpec {
    val size = 32.dp
    val icon = 16.dp
    /** Above the list's end, which is [listGap] over the dock. */
    val gap = 12.dp
    val listGap = 8.dp
    val shadow = 4.dp
    val threshold = 100.dp
    const val MOTION_MS = 280
    const val HIDDEN_SCALE = 0.7f
    val slide = 80.dp

    /** Android's DecelerateInterpolator, which Telegram's button moves on. */
    val decelerate = Easing { 1f - (1f - it) * (1f - it) }
    const val PRESSED_ALPHA = 0.6f
}

/** Telegram shows the way back once the reader is more than [threshold] pixels from the newest message, and hides it inside them. */
internal fun showsJump(distanceFromEnd: Float, viewport: Float, threshold: Float): Boolean = viewport > 0f && distanceFromEnd > threshold

/**
 * Desktop's rule (iOS's `ChatJumpButton.spins`): the arrow shimmers while
 * the working line's loader runs, not on a question waiting on the person,
 * which the line shows still. The same rule as the bar's ([activityShimmers]).
 */
internal fun jumpShimmers(activity: Activity?): Boolean = activityShimmers(activity)

/**
 * How far an inverted [state] is from its newest row: exact while that row
 * is laid out, and past it (as far as can be) once it has scrolled away,
 * which is further than the dock's padding and the row itself.
 */
internal fun distanceFromNewest(state: LazyListState): Float {
    val info = state.layoutInfo
    val newest = info.visibleItemsInfo.firstOrNull { it.index == 0 } ?: return if (info.totalItemsCount == 0) 0f else Float.MAX_VALUE
    return (-newest.offset).coerceAtLeast(0).toFloat()
}

/** [ConversationJumpSpec]'s button over the transcript, [dock] being the dock's height under the list. */
@Composable
internal fun BoxScope.ConversationJump(state: LazyListState, activity: Activity?, dock: Dp) {
    val threshold = with(LocalDensity.current) { ConversationJumpSpec.threshold.toPx() }
    val shown by remember(state, threshold) {
        derivedStateOf {
            val info = state.layoutInfo
            val viewport = (info.viewportSize.height - info.beforeContentPadding - info.afterContentPadding).toFloat()
            showsJump(distanceFromNewest(state), viewport, threshold)
        }
    }
    val slide = with(LocalDensity.current) { ConversationJumpSpec.slide.roundToPx() }
    val still = rememberReduceMotion()
    val motion = if (still) snap<Float>() else tween(ConversationJumpSpec.MOTION_MS, easing = ConversationJumpSpec.decelerate)
    val moves = if (still) snap<IntOffset>() else tween(ConversationJumpSpec.MOTION_MS, easing = ConversationJumpSpec.decelerate)
    AnimatedVisibility(
        visible = shown,
        enter = fadeIn(motion) + scaleIn(motion, ConversationJumpSpec.HIDDEN_SCALE) + slideInVertically(moves) { slide },
        exit = fadeOut(motion) + scaleOut(motion, ConversationJumpSpec.HIDDEN_SCALE) + slideOutVertically(moves) { slide },
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .padding(bottom = dock + ConversationJumpSpec.listGap + ConversationJumpSpec.gap),
    ) {
        // Hidden, it isn't composed, so it doesn't sweep.
        val scope = rememberCoroutineScope()
        JumpButton(working = jumpShimmers(activity)) { scope.launch { state.animateScrollToItem(0) } }
    }
}

/** The circle and its arrow; [working] sweeps the arrow. */
@Composable
internal fun JumpButton(working: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val label = stringResource(R.string.conversation_jump_to_latest)
    val workingState = stringResource(R.string.conversation_jump_working)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val sweeps = working && !rememberReduceMotion()
    Box(
        modifier = modifier
            .testTag(ConversationJumpTags.JUMP)
            .size(ConversationJumpSpec.size)
            .shadow(ConversationJumpSpec.shadow, CircleShape)
            .clip(CircleShape)
            .background(colors.surfaceHigh)
            .border(1.dp, colors.divider, CircleShape)
            .clickable(interaction, indication = null, role = Role.Button, onClick = onClick)
            .semantics {
                contentDescription = label
                if (working) stateDescription = workingState
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Ionicon.ArrowDownOutline,
            ConversationJumpSpec.icon,
            colors.text,
            modifier = Modifier
                .alpha(if (pressed) ConversationJumpSpec.PRESSED_ALPHA else 1f)
                .testTag(ConversationJumpTags.ARROW)
                .then(if (sweeps) Modifier.shimmer(ShimmerSpec.sheen(colors.text, colors.surface)) else Modifier),
        )
    }
}
