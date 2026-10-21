package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.chat.tools.PatchEntry
import com.slopus.happy.chat.tools.PatchInput
import com.slopus.happy.chat.tools.materializeUnifiedDiffPatch
import com.slopus.happy.chat.tools.patchChanges
import com.slopus.happy.chat.tools.patchInput
import com.slopus.happy.chat.tools.resolvePath
import com.slopus.happy.chat.tools.resultText
import com.slopus.happy.chat.tools.unifiedDiffFileName
import com.slopus.happy.diff.DiffStats
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Octicon
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.serialization.json.JsonElement

/**
 * CodexPatchView.tsx: per file, a full-width section on the surface colour
 * with the diff header (path relative to the session, NEW / DELETED /
 * RENAMED, +/− counts; the destination of a move under it in mono 12
 * textSecondary, 12 in, 9 below) and the file's diff; the permission
 * footer after the last file, 12 in and 8 down. A patch whose files cannot
 * be read shows "Update file" over the raw patch. With [onFilePress] a
 * file's header opens that file's diff: chevron-right 14 textSecondary at
 * its end, 0.6 while pressed; without it the header is inert.
 */
@Composable
internal fun CodexPatchView(
    message: ChatMessage.ToolCallMessage,
    env: ToolEnvironment,
    footer: (@Composable () -> Unit)?,
    onFilePress: ((String) -> Unit)?,
) {
    val tool = message.tool
    val changes = remember(tool.input) { patchChanges(tool.input)?.entries?.toList().orEmpty() }
    val error = resultText(tool.result)?.takeIf { tool.state == ToolState.Error }
    if (changes.isEmpty()) {
        val input = tool.input.obj
        val raw = input?.get("patch").str ?: input?.get("input").str ?: resultText(tool.input)
        ToolSection(title = stringResource(R.string.tools_names_apply_changes)) {
            if (error != null) ToolError(error)
            if (raw != null) CodeView(raw)
            footer?.invoke()
        }
        return
    }
    if (error != null) ToolError(error)
    changes.forEachIndexed { index, (file, change) ->
        PatchFile(file, change, env, if (index == changes.lastIndex) footer else null, onFilePress?.let { press -> { press(file) } })
    }
}

@Composable
private fun PatchFile(file: String, change: PatchEntry, env: ToolEnvironment, footer: (@Composable () -> Unit)?, onPress: (() -> Unit)?) {
    val palette = if (HappyTheme.colors.dark) DarkDiffPalette else LightDiffPalette
    val path = resolvePath(file, env.path)
    val movePath = change.movePath?.let { resolvePath(it, env.path) }
    val fileName = file.substringAfterLast('/')
    val diff = remember(change, file) {
        when (val input = patchInput(change)) {
            is PatchInput.Patch -> {
                val patch = materializeUnifiedDiffPatch(input.patch, file, change.kindType)
                DiffSource.Patch(patch) to DiffStats.countPatch(patch)
            }
            is PatchInput.Pair -> (if (input.oldText.isEmpty() && input.newText.isEmpty()) null else DiffSource.Contents(fileName, input.oldText, input.newText)) to
                DiffStats.countContents(input.oldText, input.newText)
            null -> null to null
        }
    }
    ToolSection(fullWidth = true) {
        Column(modifier = Modifier.fillMaxWidth().background(HappyTheme.colors.surface).testTag(ToolTags.FILE)) {
            val interaction = remember { MutableInteractionSource() }
            Column(
                modifier = Modifier
                    .then(
                        if (onPress != null) {
                            Modifier
                                .testTag(ToolTags.FILE_HEADER)
                                .alpha(pressedAlpha(interaction, ToolSpec.FILE_PRESSED_OPACITY))
                                .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onPress)
                        } else {
                            Modifier.testTag(ToolTags.FILE_HEADER)
                        },
                    )
                    .background(palette.hunkBg),
            ) {
                DiffFileHeader(
                    path = path,
                    kind = when {
                        movePath != null -> FileChangeKind.Renamed
                        change.kindType == "add" -> FileChangeKind.Added
                        change.kindType == "delete" -> FileChangeKind.Deleted
                        else -> FileChangeKind.Modified
                    },
                    additions = diff.second?.additions ?: 0,
                    deletions = diff.second?.deletions ?: 0,
                    right = if (onPress != null) {
                        { Icon(Octicon.ChevronRight, ToolSpec.fileChevron, HappyTheme.colors.textSecondary, Modifier.testTag(ToolTags.FILE_CHEVRON)) }
                    } else {
                        null
                    },
                )
                if (movePath != null) {
                    Text(
                        movePath,
                        style = ToolSpec.movePath,
                        color = HappyTheme.colors.textSecondary,
                        modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 9.dp),
                    )
                }
            }
            diff.first?.let { DiffChunk(it, env.showLineNumbers) }
            if (footer != null) {
                Box(modifier = Modifier.padding(start = ToolSpec.patchFooterPaddingHorizontal, end = ToolSpec.patchFooterPaddingHorizontal, top = ToolSpec.patchFooterPaddingTop)) {
                    footer()
                }
            }
        }
    }
}

/** CodexDiffView.tsx: the `unified_diff` under a header naming the file; nothing without a diff. */
@Composable
internal fun CodexDiffView(input: Map<String, JsonElement>?, env: ToolEnvironment) {
    if (input == null) return
    val patch = input["unified_diff"].str ?: return
    val fileName = (input["path"] ?: input["filePath"]).str ?: unifiedDiffFileName(patch)
    val stats = remember(patch) { DiffStats.countPatch(patch) }
    ToolSection(fullWidth = true) {
        if (fileName != null) DiffFileHeader(fileName, FileChangeKind.Modified, stats.additions, stats.deletions)
        DiffChunk(DiffSource.Patch(patch), env.showLineNumbers)
    }
}
