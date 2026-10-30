package com.slopus.happy.ui.conversation

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.ui.theme.HappyTheme

object ConversationModeTags {
    /** The composer's one "model effort" label. */
    const val MODEL = "conversation.modes.model"
    /** The header menu's permissions row. */
    const val PERMISSION = "conversation.modes.permission"
    /** The effort rows' heading in the model picker. */
    const val EFFORT = "conversation.modes.effort"
    const val PICKER = "conversation.modes.picker"
    const val OPTIONS = "conversation.modes.options"
}

/** Which picker is open: permissions (from the header), or model and effort (from the label). */
internal enum class ModePicker { Permission, Model }

/** Each permission mode, least to most trusted, with its name and what it allows. */
private val permissionText = mapOf(
    "read_only" to (R.string.conversation_permission_read_only to R.string.conversation_permission_read_only_description),
    "workspace_write" to (R.string.conversation_permission_workspace_write to R.string.conversation_permission_workspace_write_description),
    "auto" to (R.string.conversation_permission_auto to R.string.conversation_permission_auto_description),
    "full_access" to (R.string.conversation_permission_full_access to R.string.conversation_permission_full_access_description),
)

/** The mode after picking another model: [ModeCatalog.pick], null when nothing changes. */
internal fun conversationModelPick(catalog: ModeCatalog, current: Mode, choice: ModelChoice): Mode? =
    catalog.pick(current, choice.providerId, choice.modelId).takeIf { it != current }

/** A permission mode's name, as the header menu shows it. */
@Composable
internal fun permissionName(key: String): String = permissionText[key]?.first?.let { stringResource(it) } ?: key

/**
 * The model and effort a message runs with as one label, ChatGPT's way: the
 * model in bold, the effort after it in regular weight. One button for
 * TalkBack ("Model Opus 5 1M, effort High") that opens the model picker,
 * where effort is picked too. Before the computer's models are read it shows
 * what the chat runs with and does nothing.
 */
@Composable
internal fun ConversationModeLabel(catalog: ModeCatalog?, mode: Mode?, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val current = mode ?: catalog?.defaults ?: return
    val choice = catalog?.model(current.providerId, current.modelId)
    val model = choice?.name ?: current.modelId
    val showsEffort = choice == null || choice.efforts.isNotEmpty()
    val effort = ModeOptions.effortDisplayName(current.effort)
    val enabled = catalog != null && (catalog.models.isNotEmpty() || (choice?.efforts?.size ?: 0) > 1)
    val spoken = if (showsEffort) {
        stringResource(R.string.conversation_mode_label, model, effort)
    } else {
        stringResource(R.string.conversation_mode_label_model_only, model)
    }
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(model) }
            if (showsEffort) {
                withStyle(SpanStyle(fontWeight = FontWeight.Normal)) { append(" $effort") }
            }
        },
        style = MaterialTheme.typography.labelLarge,
        color = HappyTheme.colors.text,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .clip(MaterialTheme.shapes.small)
            .clickable(enabled = enabled, role = Role.Button, onClick = onOpen)
            .semantics(mergeDescendants = true) { contentDescription = spoken }
            .padding(horizontal = 8.dp, vertical = 12.dp)
            .testTag(ConversationModeTags.MODEL),
    )
}

/**
 * The open mode picker ([open]), an anchored popup of radio
 * rows: the permission modes, or the models under their provider's name
 * with the chosen model's effort levels after them. A pick closes it.
 */
@Composable
internal fun ConversationModePicker(open: ModePicker?, onClose: () -> Unit, catalog: ModeCatalog?, mode: Mode?, onModeChange: (Mode) -> Unit, anchorCenterY: Int, belowAnchor: Boolean = false) {
    val current = mode ?: catalog?.defaults ?: return
    val picker = open ?: return
    val efforts = catalog?.model(current.providerId, current.modelId)?.efforts.orEmpty()
    fun pick(next: Mode?) {
        onClose()
        next?.let(onModeChange)
    }
    when (picker) {
        ModePicker.Permission -> ModePanel(stringResource(R.string.conversation_mode_permission), onClose, anchorCenterY, belowAnchor) {
            ModeCatalog.PERMISSION_MODES.forEach { key ->
                val (name, description) = permissionText.getValue(key)
                item(key) {
                    ModeRow(stringResource(name), stringResource(description), selected = key == current.permissionMode) {
                        pick(current.copy(permissionMode = key).takeIf { it != current })
                    }
                }
            }
        }
        ModePicker.Model -> ModePanel(stringResource(R.string.conversation_mode_model), onClose, anchorCenterY, belowAnchor) {
            catalog?.models.orEmpty().groupBy { it.providerId }.values.forEachIndexed { index, models ->
                item("provider:${models[0].providerId}") {
                    if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    PickerHeading(models[0].providerName)
                }
                models.forEach { model ->
                    item("${model.providerId}/${model.modelId}") {
                        ModeRow(model.name, null, selected = model.providerId == current.providerId && model.modelId == current.modelId) {
                            pick(catalog?.let { conversationModelPick(it, current, model) })
                        }
                    }
                }
            }
            if (efforts.size > 1) {
                item("effort") {
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    PickerHeading(stringResource(R.string.conversation_mode_effort), Modifier.testTag(ConversationModeTags.EFFORT))
                }
                efforts.forEach { level ->
                    item("effort:$level") {
                        ModeRow(ModeOptions.effortDisplayName(level), null, selected = level == current.effort) {
                            pick(current.copy(effort = level).takeIf { it != current })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PickerHeading(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = HappyTheme.colors.textSecondary,
        modifier = modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp),
    )
}

@Composable
private fun ModePanel(title: String, onDismiss: () -> Unit, anchorCenterY: Int, belowAnchor: Boolean, content: LazyListScope.() -> Unit) {
    ConversationPopup(
        title = title,
        onDismiss = onDismiss,
        anchorCenterY = anchorCenterY,
        alignEnd = true,
        width = 360.dp,
        belowAnchor = belowAnchor,
        modifier = Modifier.testTag(ConversationModeTags.PICKER),
    ) {
        LazyColumn(Modifier.fillMaxWidth().testTag(ConversationModeTags.OPTIONS)) {
            item("title") {
                Text(
                    title,
                    style = MaterialTheme.typography.titleLarge,
                    color = HappyTheme.colors.text,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
                )
            }
            content()
            item { Spacer(Modifier.height(16.dp)) }
        }
    }
}

@Composable
private fun ModeRow(name: String, description: String?, selected: Boolean, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(name) },
        supportingContent = description?.let { { Text(it) } },
        leadingContent = { RadioButton(selected = selected, onClick = null) },
        colors = ListItemDefaults.colors(containerColor = HappyTheme.colors.surface),
        modifier = Modifier.selectable(selected = selected, role = Role.RadioButton, onClick = onClick),
    )
}
