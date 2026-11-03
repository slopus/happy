package com.slopus.happy.ui.conversation

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.AccountUsage
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelMenus
import com.slopus.happy.model.settings.ModeOptions
import com.slopus.happy.ui.components.rememberLastShown
import com.slopus.happy.ui.theme.HappyTheme

object ConversationModeTags {
    /** The composer's model chip. */
    const val MODEL = "conversation.modes.model"
    /** The composer's effort chip. */
    const val EFFORT = "conversation.modes.effort"
    const val PICKER = "conversation.modes.picker"
    const val OPTIONS = "conversation.modes.options"
}

/** Which picker is open: permissions, from the agent page's row. The model and effort chips open [ModelPicker]. */
internal enum class ModePicker { Permission }

/** Each permission mode, least to most trusted, with its name and what it allows. */
private val permissionText = mapOf(
    "read_only" to (R.string.conversation_permission_read_only to R.string.conversation_permission_read_only_description),
    "workspace_write" to (R.string.conversation_permission_workspace_write to R.string.conversation_permission_workspace_write_description),
    "auto" to (R.string.conversation_permission_auto to R.string.conversation_permission_auto_description),
    "full_access" to (R.string.conversation_permission_full_access to R.string.conversation_permission_full_access_description),
)

/** A permission mode's name, as the agent page shows it. */
@Composable
internal fun permissionName(key: String): String = permissionText[key]?.first?.let { stringResource(it) } ?: key

/**
 * The composer's model control as desktop's `ComposerModelControl` and iOS's
 * chips (e2238fdc4): the model, and its effort, each a chip opening its own
 * list ([ModelPicker]). While the selected account runs low a ring before
 * the model's name warns of it, and the chip reads the warning out. Before
 * the computer's models are read it shows what the chat runs with and does
 * nothing; with none, "Models not configured".
 */
@Composable
internal fun ConversationModelChips(
    catalog: ModeCatalog?,
    mode: Mode?,
    onOpen: (PickerList) -> Unit,
    modifier: Modifier = Modifier,
    warning: AccountUsage.Warning? = null,
    anchors: Array<LayoutCoordinates?>? = null,
) {
    val current = mode ?: catalog?.defaults ?: return
    val menus = remember(catalog, current) { catalog?.let { ModelMenus.of(it, current) } }
    val (model, effort) = if (catalog == null) {
        (current.modelId to ModeOptions.effortDisplayName(current.effort))
    } else modelChipLabels(menus)
    val modelLabel = stringResource(R.string.conversation_model_chip, model)
    // The ring and its words while the selected account runs low.
    val spoken = warning?.let { "$modelLabel. ${usageWarningText(it)}." } ?: modelLabel
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier
                .clip(MaterialTheme.shapes.small)
                .clickable(enabled = menus != null && !menus.isEmpty, role = Role.Button) { onOpen(PickerList.Model) }
                .semantics(mergeDescendants = true) { contentDescription = spoken }
                .onPlaced { anchors?.set(0, it) }
                .padding(horizontal = 8.dp, vertical = 12.dp)
                .testTag(ConversationModeTags.MODEL),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (warning != null) {
                UsageRing(warning.left, warning.tone)
                Spacer(Modifier.width(UsageRingSpec.gap))
            }
            Text(model, style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold), color = HappyTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (effort != null) {
            val effortLabel = stringResource(R.string.conversation_effort_chip, effort)
            Text(
                effort,
                style = MaterialTheme.typography.labelLarge,
                color = HappyTheme.colors.text,
                maxLines = 1,
                modifier = Modifier
                    .clip(MaterialTheme.shapes.small)
                    .clickable(enabled = (menus?.current?.efforts?.size ?: 0) > 0, role = Role.Button) { onOpen(PickerList.Effort) }
                    .semantics(mergeDescendants = true) { contentDescription = effortLabel }
                    .onPlaced { anchors?.set(1, it) }
                    .padding(horizontal = 8.dp, vertical = 12.dp)
                    .testTag(ConversationModeTags.EFFORT),
            )
        }
    }
}

/**
 * The open mode picker ([open]), an anchored popup of radio
 * rows: the permission modes, or the models under their provider's name
 * with the chosen model's effort levels after them. A pick closes it.
 */
@Composable
internal fun ConversationModePicker(open: ModePicker?, onClose: () -> Unit, catalog: ModeCatalog?, mode: Mode?, onModeChange: (Mode) -> Unit, anchorCenterY: Int, belowAnchor: Boolean = false) {
    val current = mode ?: catalog?.defaults ?: return
    // The last picker stays drawn while it closes.
    val picker = rememberLastShown(open) ?: return
    val expanded = open != null
    fun pick(next: Mode?) {
        onClose()
        next?.let(onModeChange)
    }
    when (picker) {
        ModePicker.Permission -> ModePanel(expanded, stringResource(R.string.conversation_mode_permission), onClose, anchorCenterY, belowAnchor) {
            ModeCatalog.PERMISSION_MODES.forEach { key ->
                val (name, description) = permissionText.getValue(key)
                item(key) {
                    ModeRow(stringResource(name), stringResource(description), selected = key == current.permissionMode) {
                        pick(current.copy(permissionMode = key).takeIf { it != current })
                    }
                }
            }
        }
    }
}

@Composable
private fun ModePanel(expanded: Boolean, title: String, onDismiss: () -> Unit, anchorCenterY: Int, belowAnchor: Boolean, content: LazyListScope.() -> Unit) {
    ConversationPopup(
        expanded = expanded,
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
