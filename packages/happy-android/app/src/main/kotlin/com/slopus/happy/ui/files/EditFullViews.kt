package com.slopus.happy.ui.files

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ToolCall
import com.slopus.happy.chat.arr
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
import com.slopus.happy.diff.DiffSource
import com.slopus.happy.diff.DiffStats
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.ui.chat.CodeView
import com.slopus.happy.ui.chat.ToolSection
import com.slopus.happy.ui.diff.DiffChunk
import com.slopus.happy.ui.diff.DiffFileHeader
import com.slopus.happy.ui.diff.DiffFileSummary
import com.slopus.happy.ui.diff.diffPalette
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** MultiEditViewFull.tsx: each edit under "Edit i of n" (14 semibold #5856D6, a "Replace All" pill 8 after), 16 rules between. */
@Composable
internal fun MultiEditFullView(input: Map<String, JsonElement>?) {
    val edits = input?.get("edits").arr?.mapNotNull { it.obj }.orEmpty()
    if (edits.isEmpty()) return
    val path = input?.get("file_path").str
    Column(Modifier.padding(bottom = 28.dp)) {
        edits.forEachIndexed { index, edit ->
            Row(Modifier.padding(bottom = 8.dp).testTag(MessageDetailTags.EDIT_HEADER), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.tools_multi_edit_edit_number, index + 1, edits.size),
                    style = happyTextStyle(fontSize = 14, weight = FontWeight.SemiBold),
                    color = FullViewSpec.accent,
                )
                if ((edit["replace_all"] as? JsonPrimitive)?.content == "true") {
                    Text(
                        stringResource(R.string.tools_multi_edit_replace_all),
                        style = happyTextStyle(fontSize = 12, weight = FontWeight.SemiBold),
                        color = Color.White,
                        modifier = Modifier.padding(start = 8.dp).clip(RoundedCornerShape(12.dp)).background(FullViewSpec.accent).padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
            }
            DiffChunk(DiffSource.Contents(path ?: "file.txt", edit["old_string"].str.orEmpty(), edit["new_string"].str.orEmpty()), showLineNumbers = true)
            if (index < edits.lastIndex) Spacer(Modifier.padding(vertical = 16.dp).fillMaxWidth().height(1.dp).background(Color(0xFFE5E5EA)))
        }
    }
}

/**
 * CodexPatchViewFull: 12 in, 16 apart, 28 below; each file a card on the
 * surface colour (radius 8, 1 divider border) with its header (and the
 * destination of a move) over its diff. [focusFile] narrows it to the
 * file that was tapped, when it is still there. A patch with no readable
 * files shows "Update file" over the raw patch.
 */
@Composable
internal fun PatchFullView(tool: ToolCall, env: MessageDetailEnvironment, focusFile: String?) {
    val all = remember(tool.input) { patchChanges(tool.input)?.entries?.map { it.key to it.value }.orEmpty() }
    val focused = focusFile?.let { f -> all.filter { it.first == f } }.orEmpty()
    val entries = focused.ifEmpty { all }
    if (entries.isEmpty()) {
        val raw = tool.input.obj?.get("patch").str ?: tool.input.obj?.get("input").str ?: tool.input?.let(::resultText)
        ToolSection(title = stringResource(R.string.tools_names_apply_changes)) { if (raw != null) CodeView(raw) }
        return
    }
    Column(Modifier.padding(horizontal = 12.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        for ((file, change) in entries) PatchFileCard(file, change, env)
    }
}

@Composable
private fun PatchFileCard(file: String, change: PatchEntry, env: MessageDetailEnvironment) {
    val colors = HappyTheme.colors
    val palette = diffPalette()
    val path = resolvePath(file, env.path)
    val movePath = change.movePath?.let { resolvePath(it, env.path) }
    val fileName = file.substringAfterLast('/')
    val diff = remember(change, file) {
        when (val input = patchInput(change)) {
            is PatchInput.Patch -> materializeUnifiedDiffPatch(input.patch, file, change.kindType).let { DiffSource.Patch(it) to DiffStats.countPatch(it) }
            is PatchInput.Pair -> (if (input.oldText.isEmpty() && input.newText.isEmpty()) null else DiffSource.Contents(fileName, input.oldText, input.newText)) to
                DiffStats.countContents(input.oldText, input.newText)
            null -> null to null
        }
    }
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.fillMaxWidth().testTag(MessageDetailTags.PATCH_FILE).clip(shape).background(colors.surface).border(1.dp, colors.divider, shape)) {
        Column(Modifier.background(palette.hunkBg)) {
            DiffFileHeader(
                DiffFileSummary(
                    path,
                    when {
                        movePath != null -> FileChangeKind.Renamed
                        change.kindType == "add" -> FileChangeKind.Added
                        change.kindType == "delete" -> FileChangeKind.Deleted
                        else -> FileChangeKind.Modified
                    },
                    diff.second?.additions ?: 0,
                    diff.second?.deletions ?: 0,
                ),
            )
            if (movePath != null) {
                Text(movePath, style = happyTextStyle(fontSize = 12, family = PlexMono), color = palette.textSecondary, modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 9.dp))
            }
        }
        diff.first?.let { DiffChunk(it, showLineNumbers = env.showLineNumbers) }
    }
}

/** CodexDiffViewFull: the `unified_diff` in one such card, under a header naming the file. */
@Composable
internal fun CodexDiffFullView(input: Map<String, JsonElement>?, env: MessageDetailEnvironment) {
    val patch = input?.get("unified_diff").str ?: return
    val fileName = (input?.get("path") ?: input?.get("filePath")).str ?: unifiedDiffFileName(patch)
    val stats = remember(patch) { DiffStats.countPatch(patch) }
    val colors = HappyTheme.colors
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.padding(horizontal = 12.dp).padding(bottom = 28.dp).fillMaxWidth().clip(shape).background(colors.surface).border(1.dp, colors.divider, shape)) {
        if (fileName != null) DiffFileHeader(DiffFileSummary(fileName, FileChangeKind.Modified, stats.additions, stats.deletions))
        DiffChunk(DiffSource.Patch(patch), showLineNumbers = env.showLineNumbers)
    }
}
