package com.slopus.happy.ui.conversation

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.theme.HappyTheme

object ConversationModeTags {
    const val CHIPS = "conversation.modes"
    const val PERMISSION = "conversation.modes.permission"
    const val MODEL = "conversation.modes.model"
    const val EFFORT = "conversation.modes.effort"
    const val SHEET = "conversation.modes.sheet"
}

private enum class ModeSheet { Permission, Model, Effort }

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

/**
 * The permission, model and effort a message runs with, as Material 3 assist
 * chips under the composer's field, scrolling sideways when they don't fit;
 * each opens a modal bottom sheet of radio rows (models under their
 * provider's name), and a pick closes it. Before the computer's models are
 * read the model and effort chips show what the chat runs with, disabled;
 * effort is there only when the model has levels.
 */
@Composable
internal fun ConversationModeChips(catalog: ModeCatalog?, mode: Mode?, onModeChange: (Mode) -> Unit, modifier: Modifier = Modifier) {
    val current = mode ?: catalog?.defaults ?: return
    val focus = LocalFocusManager.current
    var open by rememberSaveable { mutableStateOf<ModeSheet?>(null) }
    val choice = catalog?.model(current.providerId, current.modelId)
    val efforts = choice?.efforts.orEmpty()
    val chipColors = AssistChipDefaults.assistChipColors(
        labelColor = HappyTheme.colors.text,
        trailingIconContentColor = HappyTheme.colors.textSecondary,
    )
    fun show(sheet: ModeSheet) {
        // The sheet takes the keyboard's place.
        focus.clearFocus()
        open = sheet
    }
    Row(
        modifier = modifier.testTag(ConversationModeTags.CHIPS).horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val permission = permissionText[current.permissionMode]?.first?.let { stringResource(it) } ?: current.permissionMode
        ModeChip(permission, ConversationModeTags.PERMISSION, enabled = true, chipColors) { show(ModeSheet.Permission) }
        ModeChip(choice?.name ?: current.modelId, ConversationModeTags.MODEL, enabled = catalog != null && catalog.models.isNotEmpty(), chipColors) {
            show(ModeSheet.Model)
        }
        if (efforts.isNotEmpty() || choice == null) {
            ModeChip(ModeOptions.effortDisplayName(current.effort), ConversationModeTags.EFFORT, enabled = efforts.size > 1, chipColors) {
                show(ModeSheet.Effort)
            }
        }
    }

    val sheet = open ?: return
    val close = { open = null }
    fun pick(next: Mode?) {
        close()
        next?.let(onModeChange)
    }
    when (sheet) {
        ModeSheet.Permission -> ModeSheet(stringResource(R.string.conversation_mode_permission), close) {
            ModeCatalog.PERMISSION_MODES.forEach { key ->
                val (name, description) = permissionText.getValue(key)
                item(key) {
                    ModeRow(stringResource(name), stringResource(description), selected = key == current.permissionMode) {
                        pick(current.copy(permissionMode = key).takeIf { it != current })
                    }
                }
            }
        }
        ModeSheet.Model -> ModeSheet(stringResource(R.string.conversation_mode_model), close) {
            catalog?.models.orEmpty().groupBy { it.providerId }.values.forEachIndexed { index, models ->
                item("provider:${models[0].providerId}") {
                    if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Text(
                        models[0].providerName,
                        style = MaterialTheme.typography.titleSmall,
                        color = HappyTheme.colors.textSecondary,
                        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp),
                    )
                }
                models.forEach { model ->
                    item("${model.providerId}/${model.modelId}") {
                        ModeRow(model.name, null, selected = model.providerId == current.providerId && model.modelId == current.modelId) {
                            pick(catalog?.let { conversationModelPick(it, current, model) })
                        }
                    }
                }
            }
        }
        ModeSheet.Effort -> ModeSheet(stringResource(R.string.conversation_mode_effort), close) {
            efforts.forEach { level ->
                item(level) {
                    ModeRow(ModeOptions.effortDisplayName(level), null, selected = level == current.effort) {
                        pick(current.copy(effort = level).takeIf { it != current })
                    }
                }
            }
        }
    }
}

@Composable
private fun ModeChip(label: String, tag: String, enabled: Boolean, colors: androidx.compose.material3.ChipColors, onClick: () -> Unit) {
    AssistChip(
        onClick = onClick,
        enabled = enabled,
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailingIcon = { Icon(MaterialSymbols.ExpandMore, contentDescription = null, modifier = Modifier.size(AssistChipDefaults.IconSize)) },
        colors = colors,
        modifier = Modifier.testTag(tag),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModeSheet(title: String, onDismiss: () -> Unit, content: LazyListScope.() -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = HappyTheme.colors.surface,
        modifier = Modifier.testTag(ConversationModeTags.SHEET),
    ) {
        Text(
            title,
            style = MaterialTheme.typography.titleLarge,
            color = HappyTheme.colors.text,
            modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 8.dp),
        )
        LazyColumn(Modifier.fillMaxWidth()) {
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
