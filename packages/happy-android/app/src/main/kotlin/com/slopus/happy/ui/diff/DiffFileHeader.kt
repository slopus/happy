package com.slopus.happy.ui.diff

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.diff.DiffFile
import com.slopus.happy.diff.FileChangeKind
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.files.FileIcon
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle

/** What a file header shows: a built [DiffFile] has it, and so does a git-status entry (`DiffFileSummary`). */
data class DiffFileSummary(val path: String, val kind: FileChangeKind, val additions: Int, val deletions: Int) {
    companion object {
        fun of(file: DiffFile) = DiffFileSummary(file.path, file.kind, file.additions, file.deletions)
    }
}

/** No line height, so RN Android keeps the font's padding (happyTextStyle does the same). */
private val RnFontPadding = PlatformTextStyle(includeFontPadding = true)

object DiffHeaderSpec {
    val dir = happyTextStyle(fontSize = 12, family = PlexMono)
    val name = TextStyle(fontFamily = PlexMono, fontWeight = FontWeight.SemiBold, fontSize = 12.5.sp, platformStyle = RnFontPadding)
    val badge = TextStyle(fontFamily = PlexMono, fontWeight = FontWeight.SemiBold, fontSize = 10.5.sp, platformStyle = RnFontPadding)
    val stat = happyTextStyle(fontSize = 12, family = PlexMono)
}

/**
 * DiffFileHeader.tsx: padding 12/9 on hunkBg, items 8 apart: a 14
 * chevron (forward when [collapsed], down when open) when [onToggle] is
 * set, the 16 file icon, the folder (mono 12 textSecondary, shortened from
 * the start) then the name (mono semibold 12.5 text), or [title] in place
 * of both; a NEW / DELETED / RENAMED badge (mono semibold 10.5); +N and −N
 * (mono 12 in the marker colours); then [right].
 */
@Composable
fun DiffFileHeader(
    file: DiffFileSummary,
    modifier: Modifier = Modifier,
    collapsed: Boolean = false,
    onToggle: (() -> Unit)? = null,
    title: String? = null,
    right: (@Composable RowScope.() -> Unit)? = null,
) {
    val palette = diffPalette()
    val name = file.path.substringAfterLast('/').ifEmpty { file.path }
    val dir = file.path.substring(0, file.path.length - name.length)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .testTag(DiffTags.HEADER)
            .then(
                if (onToggle != null) {
                    Modifier
                        .clickable(role = Role.Button, onClick = onToggle)
                        .semantics { if (collapsed) expand { onToggle(); true } else collapse { onToggle(); true } }
                } else {
                    Modifier
                },
            )
            .background(palette.hunkBg)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (onToggle != null) {
            Icon(if (collapsed) Ionicon.ChevronForward else Ionicon.ChevronDown, 14.dp, palette.textSecondary, Modifier.testTag(DiffTags.CHEVRON))
        }
        FileIcon(name, 16.dp)
        Row(modifier = Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = title ?: dir,
                style = DiffHeaderSpec.dir,
                color = palette.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.StartEllipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (title == null) Text(name, style = DiffHeaderSpec.name, color = palette.text, maxLines = 1)
        }
        when (file.kind) {
            FileChangeKind.Added -> Badge("NEW", palette.markerAdd)
            FileChangeKind.Deleted -> Badge("DELETED", palette.markerDel)
            FileChangeKind.Renamed -> Badge("RENAMED", palette.textSecondary)
            else -> Unit
        }
        if (file.additions > 0) Text("+${file.additions}", style = DiffHeaderSpec.stat, color = palette.markerAdd)
        if (file.deletions > 0) Text("−${file.deletions}", style = DiffHeaderSpec.stat, color = palette.markerDel)
        right?.invoke(this)
    }
}

@Composable
private fun Badge(text: String, color: Color) {
    Text(text, style = DiffHeaderSpec.badge, color = color, maxLines = 1)
}
