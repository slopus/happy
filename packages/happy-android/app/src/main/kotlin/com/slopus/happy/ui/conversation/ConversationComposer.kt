package com.slopus.happy.ui.conversation

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.InlinePictures
import com.slopus.happy.conversation.Mode
import com.slopus.happy.ui.attachments.rememberComposerImages
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.chat.SessionStatusColors
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.StatusDot
import com.slopus.happy.ui.theme.HappyTheme
import java.io.File

object ConversationComposerTags {
    const val COMPOSER = "conversation.composer"
    const val INPUT = "conversation.composer.input"
    const val PRIMARY = "conversation.composer.primary"
    const val ATTACH = "conversation.composer.attach"
    const val PICTURES = "conversation.composer.pictures"
    const val PICTURE_REMOVE = "conversation.composer.pictures.remove"
    const val STATUS = "conversation.composer.status"
}

/**
 * The conversation's composer as an Android bottom bar: what the agent is
 * doing (a pulsing dot and a label) over the pictures waiting to go
 * (64 dp thumbnails, each with a remove button), then add-picture (the
 * system photo picker), a filled text field in the extra-large shape
 * growing to six lines, and the filled send button, which becomes Stop
 * while the agent works and nothing is typed; then the mode chips.
 * Pictures that together pass what one message carries
 * ([InlinePictures]) are refused with an alert, keeping text and pictures.
 */
@Composable
internal fun ConversationComposer(
    state: ConversationState,
    text: String,
    onTextChange: (String) -> Unit,
    onSend: (String, List<File>) -> Boolean,
    onSent: () -> Unit,
    onStop: () -> Unit,
    onModeChange: (Mode) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = HappyTheme.colors
    val pictures = rememberComposerImages(enabled = true)
    var tooLarge by remember { mutableStateOf(false) }
    val attached = pictures?.images.orEmpty()
    val hasContent = text.isNotBlank() || attached.isNotEmpty()
    val primary = primaryActionOf(hasContent, state)

    Surface(color = colors.surface, modifier = modifier.fillMaxWidth().testTag(ConversationComposerTags.COMPOSER)) {
        Column(Modifier.padding(bottom = 8.dp)) {
            state.activity?.let { ActivityLine(it) }
            if (attached.isNotEmpty()) {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(top = 8.dp).testTag(ConversationComposerTags.PICTURES),
                ) {
                    items(attached, key = { it.id }) { picture ->
                        Box(Modifier.size(64.dp)) {
                            RemoteImage(
                                picture.uri,
                                contentDescription = picture.name,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.size(64.dp).clip(MaterialTheme.shapes.medium),
                            )
                            FilledTonalIconButton(
                                onClick = { pictures?.remove(picture.id) },
                                modifier = Modifier.align(Alignment.TopEnd).padding(2.dp).size(24.dp).testTag(ConversationComposerTags.PICTURE_REMOVE),
                            ) {
                                Icon(MaterialSymbols.Close, stringResource(R.string.conversation_remove_picture), Modifier.size(16.dp))
                            }
                        }
                    }
                }
            }
            Row(
                verticalAlignment = Alignment.Bottom,
                modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 8.dp),
            ) {
                IconButton(
                    onClick = { pictures?.pick() },
                    modifier = Modifier.padding(bottom = 4.dp).testTag(ConversationComposerTags.ATTACH),
                ) {
                    Icon(MaterialSymbols.Image, stringResource(R.string.conversation_attach_picture), tint = colors.textSecondary)
                }
                TextField(
                    value = text,
                    onValueChange = onTextChange,
                    placeholder = { Text(stringResource(R.string.conversation_message_placeholder)) },
                    shape = MaterialTheme.shapes.extraLarge,
                    maxLines = 6,
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = colors.surfaceHigh,
                        unfocusedContainerColor = colors.surfaceHigh,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        focusedTextColor = colors.text,
                        unfocusedTextColor = colors.text,
                        focusedPlaceholderColor = colors.textSecondary,
                        unfocusedPlaceholderColor = colors.textSecondary,
                        cursorColor = colors.text,
                    ),
                    modifier = Modifier.weight(1f).heightIn(min = 56.dp).testTag(ConversationComposerTags.INPUT),
                )
                val sendLabel = stringResource(if (primary == PrimaryAction.Stop) R.string.conversation_stop else R.string.conversation_send)
                FilledIconButton(
                    onClick = {
                        when (primary) {
                            PrimaryAction.Send -> {
                                if (!InlinePictures.fit(attached.map { it.size })) {
                                    tooLarge = true
                                } else if (onSend(text, attached.mapNotNull { Uri.parse(it.uri).path?.let(::File) })) {
                                    pictures?.clear()
                                    onSent()
                                }
                            }
                            PrimaryAction.Stop -> if (!state.stopping) onStop()
                            else -> Unit
                        }
                    },
                    enabled = primary == PrimaryAction.Send || primary == PrimaryAction.Stop,
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = colors.text, contentColor = colors.surface),
                    modifier = Modifier.padding(start = 8.dp, bottom = 4.dp).size(48.dp).testTag(ConversationComposerTags.PRIMARY),
                ) {
                    if (state.stopping) {
                        CircularProgressIndicator(Modifier.size(20.dp), color = colors.surface, strokeWidth = 2.dp)
                    } else {
                        Icon(if (primary == PrimaryAction.Stop) MaterialSymbols.Stop else MaterialSymbols.Send, sendLabel)
                    }
                }
            }
            ConversationModeChips(
                catalog = state.catalog,
                mode = state.mode,
                onModeChange = onModeChange,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 4.dp),
            )
        }
    }
    if (tooLarge) {
        HappyAlert(
            Alert(
                stringResource(R.string.conversation_pictures_too_large_title),
                stringResource(R.string.conversation_pictures_too_large_message),
                listOf(AlertButton(stringResource(R.string.common_ok))),
            ),
            onDismiss = { tooLarge = false },
        )
    }
}

@Composable
private fun ActivityLine(activity: Activity) {
    val label = stringResource(
        when (activity) {
            Activity.AwaitingAnswer -> R.string.conversation_activity_awaiting_answer
            Activity.WaitingForModel -> R.string.conversation_activity_waiting_for_model
            Activity.Thinking -> R.string.conversation_activity_thinking
            Activity.PreparingTools -> R.string.conversation_activity_preparing_tools
            Activity.RunningTools -> R.string.conversation_activity_running_tools
            Activity.Working -> R.string.conversation_activity_working
            Activity.Delegating -> R.string.conversation_activity_delegating
        },
    )
    val color = if (activity == Activity.AwaitingAnswer) SessionStatusColors.attention else SessionStatusColors.thinking
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(horizontal = 20.dp).padding(top = 8.dp).testTag(ConversationComposerTags.STATUS),
    ) {
        StatusDot(color, pulsing = true)
        Text(label, style = MaterialTheme.typography.labelMedium, color = HappyTheme.colors.textSecondary)
    }
}
