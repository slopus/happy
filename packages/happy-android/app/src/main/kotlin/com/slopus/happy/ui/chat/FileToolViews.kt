package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.ui.theme.HappyTheme
import kotlin.math.roundToInt
import kotlinx.serialization.json.JsonElement

/** `knownTools.Edit.input`: old, new and path, or null when the input is not an edit. */
internal fun editStrings(input: Map<String, JsonElement>?): Triple<String, String, String>? {
    if (input == null) return null
    val path = input["file_path"].str ?: return null
    val old = input["old_string"].str ?: return null
    val new = input["new_string"].str ?: return null
    return Triple(old, new, path)
}

/** GeminiEditView.tsx `extractEditContent`. */
internal fun geminiEditContent(input: JsonElement?): Triple<String, String, String> {
    val o = input.obj
    val content = o?.get("toolCall").obj?.get("content").arr?.firstOrNull().obj
        ?: o?.get("input").arr?.firstOrNull().obj
    if (content != null) {
        return Triple(content["oldText"].str.orEmpty(), content["newText"].str.orEmpty(), content["path"].str.orEmpty())
    }
    return Triple(
        (o?.get("oldText") ?: o?.get("old_string")).str.orEmpty(),
        (o?.get("newText") ?: o?.get("new_string")).str.orEmpty(),
        (o?.get("path") ?: o?.get("file_path")).str.orEmpty(),
    )
}

/** MultiEditView.tsx: one diff per edit, 8 apart, in one full-width section; nothing without edits. */
@Composable
internal fun MultiEditView(input: Map<String, JsonElement>?, env: ToolEnvironment) {
    if (input == null) return
    val path = input["file_path"].str ?: return
    val edits = input["edits"].arr?.mapNotNull { it.obj }?.takeIf { list -> list.all { it["old_string"].str != null && it["new_string"].str != null } }
    if (edits.isNullOrEmpty()) return
    ToolSection(fullWidth = true) {
        edits.forEachIndexed { index, edit ->
            // The line-number setting is not passed per edit in happy-app either.
            DiffChunk(DiffSource.Contents(path, edit["old_string"].str.orEmpty(), edit["new_string"].str.orEmpty()), showLineNumbers = true)
            if (index < edits.lastIndex) Spacer(Modifier.height(ToolSpec.multiEditGap))
        }
    }
}

/**
 * FileView.tsx: an attached picture, at most 280 wide and 360 high in its
 * own aspect (4:3 without one), radius 8, 12 in and 8 above and below, its
 * name under it 4 down in 13 weight 500 textSecondary. Until attachments
 * download, the picture's box is drawn in surfaceHigh.
 */
@Composable
internal fun FileView(input: Map<String, JsonElement>?) {
    if (input == null) return
    val name = input["name"].str ?: return
    if (input["ref"].str == null) return
    val image = input["image"].obj
    val w = (image?.get("width") as? kotlinx.serialization.json.JsonPrimitive)?.content?.toFloatOrNull()
    val h = (image?.get("height") as? kotlinx.serialization.json.JsonPrimitive)?.content?.toFloatOrNull()
    val aspect = if (w != null && h != null && w > 0 && h > 0) w / h else 4f / 3f
    var displayW = minOf(if (w != null && w > 0) w else ToolSpec.fileMaxWidth, ToolSpec.fileMaxWidth)
    var displayH = displayW / aspect
    if (displayH > ToolSpec.fileMaxHeight) {
        displayH = ToolSpec.fileMaxHeight
        displayW = displayH * aspect
    }
    Column(
        modifier = Modifier.padding(horizontal = ToolSpec.filePaddingHorizontal, vertical = ToolSpec.filePaddingVertical),
        verticalArrangement = Arrangement.spacedBy(ToolSpec.fileGap),
    ) {
        Box(
            modifier = Modifier
                .size(displayW.roundToInt().dp, displayH.roundToInt().dp)
                .clip(RoundedCornerShape(ToolSpec.fileRadius))
                .background(HappyTheme.colors.surfaceHigh)
                .testTag(ToolTags.FILE),
        )
        Text(name, style = ToolSpec.fileName, color = HappyTheme.colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
