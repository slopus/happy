package com.slopus.happy.ui.conversation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon as MaterialIcon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.ui.components.Icon as GlyphIcon
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MenuSpec
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.theme.HappyTheme

private enum class HeaderMenu { Actions, Permissions }

/** The header of a chat that doesn't exist yet (iOS 323fb2e9f, ConversationHeader). */
object ConversationHeaderSpec {
    /** Its name, status and compose fade in with the first send, ease-out, mostly over early. */
    const val FADE_MILLIS = 250
    val easing = CubicBezierEasing(0f, 0f, 0.58f, 1f)
}

/**
 * Two 48 dp header targets: compose (the square-and-pencil glyph, same as
 * Home), then three dots. Compose starts a new empty chat, so a chat that
 * doesn't exist yet has none until its first send; the menu holds
 * permissions (here, unlike iOS, for new work too) and, once a chat
 * exists, its details. Menus open below the
 * three-dot button and keep the composer/IME active, including selections.
 */
@Composable
internal fun ConversationHeaderActions(state: ConversationState, actions: ConversationScreenActions) {
    val colors = HappyTheme.colors
    val current = state.mode ?: state.catalog?.defaults
    var menu by rememberSaveable { mutableStateOf<HeaderMenu?>(null) }
    // Composing another from the empty chat has nothing to leave: compose comes with the first send.
    AnimatedVisibility(
        visible = state.created,
        enter = fadeIn(tween(ConversationHeaderSpec.FADE_MILLIS, easing = ConversationHeaderSpec.easing)),
        exit = ExitTransition.None,
    ) {
        IconButton(onClick = actions.onCompose, modifier = Modifier.testTag(ConversationScreenTags.COMPOSE)) {
            GlyphIcon(Ionicon.CreateOutline, 24.dp, colors.text, Modifier.testTag(ConversationScreenTags.COMPOSE_ICON), stringResource(R.string.session_new_chat))
        }
    }
    Box {
        IconButton(
            onClick = { menu = HeaderMenu.Actions },
            enabled = current != null || state.created,
            modifier = Modifier.testTag(ConversationScreenTags.MORE),
        ) {
            GlyphIcon(Ionicon.EllipsisVertical, 24.dp, colors.text, contentDescription = stringResource(R.string.conversation_composer_more))
        }
        // Both stay composed so each can play its exit; only the open one shows.
        ConversationPopup(
            expanded = menu == HeaderMenu.Actions,
            title = stringResource(R.string.conversation_composer_more),
            onDismiss = { menu = null },
            alignEnd = true,
            width = 280.dp,
            belowAnchor = true,
            modifier = Modifier.testTag(ConversationScreenTags.MENU),
        ) {
            LazyColumn(contentPadding = PaddingValues(vertical = 8.dp)) {
                if (current != null) {
                    item {
                        HappyMenuItem(
                            label = stringResource(R.string.conversation_mode_permission_item, permissionName(current.permissionMode)),
                            leading = { MaterialIcon(MaterialSymbols.Lock, null, Modifier.size(MenuSpec.icon)) },
                            onClick = { menu = HeaderMenu.Permissions },
                            modifier = Modifier.testTag(ConversationModeTags.PERMISSION),
                        )
                    }
                }
                if (state.created) {
                    item {
                        HappyMenuItem(
                            label = stringResource(R.string.conversation_details),
                            leading = { MaterialIcon(MaterialSymbols.Info, null, Modifier.size(MenuSpec.icon)) },
                            onClick = { menu = null; actions.onDetails() },
                            modifier = Modifier.testTag(ConversationScreenTags.DETAILS),
                        )
                    }
                }
            }
        }
        ConversationModePicker(
            open = if (menu == HeaderMenu.Permissions) ModePicker.Permission else null,
            onClose = { menu = null },
            catalog = state.catalog,
            mode = state.mode,
            onModeChange = actions.onModeChange,
            anchorCenterY = 0,
            belowAnchor = true,
        )
    }
}