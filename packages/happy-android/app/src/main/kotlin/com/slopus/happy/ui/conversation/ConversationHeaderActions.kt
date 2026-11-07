package com.slopus.happy.ui.conversation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.ui.components.Icon as GlyphIcon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme

/** The header of a chat that doesn't exist yet (iOS 323fb2e9f, ConversationHeader). */
object ConversationHeaderSpec {
    /** Its name, status and compose fade in with the first send, ease-out, mostly over early. */
    const val FADE_MILLIS = 250
    val easing = CubicBezierEasing(0f, 0f, 0.58f, 1f)
}

/**
 * The header's one action, compose (the square-and-pencil glyph, same as
 * Home): it starts a new empty chat, so a chat that doesn't exist yet has
 * none until its first send. The More menu is gone, as iOS da5fda505 took
 * it: the details open from the name, and the permission mode is a row on
 * them ([AgentPageScreen]).
 */
@Composable
internal fun ConversationHeaderActions(state: ConversationState, actions: ConversationScreenActions, composes: Boolean = true) {
    val colors = HappyTheme.colors
    // Composing another from the empty chat has nothing to leave: compose comes with the first send.
    AnimatedVisibility(
        visible = state.created && composes,
        enter = fadeIn(tween(ConversationHeaderSpec.FADE_MILLIS, easing = ConversationHeaderSpec.easing)),
        exit = ExitTransition.None,
    ) {
        IconButton(onClick = actions.onCompose, modifier = Modifier.testTag(ConversationScreenTags.COMPOSE)) {
            GlyphIcon(Ionicon.CreateOutline, 24.dp, colors.text, Modifier.testTag(ConversationScreenTags.COMPOSE_ICON), stringResource(R.string.session_new_chat))
        }
    }
}
