package com.slopus.happy.ui.conversation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon as MaterialIcon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
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
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.theme.HappyTheme

private enum class HeaderMenu { Actions, Permissions }

/**
 * Two 48 dp header targets: compose (the square-and-pencil glyph, same as
 * Home), then three dots. Compose starts a new empty chat; the menu holds
 * permissions and, once a chat exists, its details. Menus open below the
 * three-dot button and keep the composer/IME active, including selections.
 */
@Composable
internal fun ConversationHeaderActions(state: ConversationState, actions: ConversationScreenActions) {
    val colors = HappyTheme.colors
    val current = state.mode ?: state.catalog?.defaults
    var menu by rememberSaveable { mutableStateOf<HeaderMenu?>(null) }
    IconButton(onClick = actions.onCompose, modifier = Modifier.testTag(ConversationScreenTags.COMPOSE)) {
        GlyphIcon(Ionicon.CreateOutline, 24.dp, colors.text, Modifier.testTag(ConversationScreenTags.COMPOSE_ICON), stringResource(R.string.conversation_compose))
    }
    Box {
        IconButton(
            onClick = { menu = HeaderMenu.Actions },
            enabled = current != null || state.created,
            modifier = Modifier.testTag(ConversationScreenTags.MORE),
        ) {
            GlyphIcon(Ionicon.EllipsisVertical, 24.dp, colors.text, contentDescription = stringResource(R.string.conversation_composer_more))
        }
        when (menu) {
            HeaderMenu.Actions -> ConversationPopup(
                title = stringResource(R.string.conversation_composer_more),
                onDismiss = { menu = null },
                alignEnd = true,
                width = 280.dp,
                belowAnchor = true,
                modifier = Modifier.testTag(ConversationScreenTags.MENU),
            ) {
                LazyColumn {
                    if (current != null) {
                        item {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.conversation_mode_permission_item, permissionName(current.permissionMode))) },
                                leadingIcon = { MaterialIcon(MaterialSymbols.Lock, null) },
                                onClick = { menu = HeaderMenu.Permissions },
                                modifier = Modifier.testTag(ConversationModeTags.PERMISSION),
                            )
                        }
                    }
                    if (state.created) {
                        item {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.conversation_details)) },
                                leadingIcon = { MaterialIcon(MaterialSymbols.Info, null) },
                                onClick = { menu = null; actions.onDetails() },
                                modifier = Modifier.testTag(ConversationScreenTags.DETAILS),
                            )
                        }
                    }
                }
            }
            HeaderMenu.Permissions -> ConversationModePicker(
                open = ModePicker.Permission,
                onClose = { menu = null },
                catalog = state.catalog,
                mode = state.mode,
                onModeChange = actions.onModeChange,
                anchorCenterY = 0,
                belowAnchor = true,
            )
            null -> Unit
        }
    }
}