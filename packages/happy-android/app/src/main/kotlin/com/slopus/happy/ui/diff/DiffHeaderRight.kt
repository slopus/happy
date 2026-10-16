package com.slopus.happy.ui.diff

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle

object DiffHeaderRightTags {
    const val REFRESH = "diff.headerRight.refresh"
    const val WHITESPACE = "diff.headerRight.whitespace"
    const val COUNT = "diff.headerRight.count"
}

/**
 * DiffHeaderRight.tsx, the changes screens' header controls: an 18 refresh
 * glyph (textSecondary, 0.4 while [refreshing]) when [onRefresh] is set; the
 * "·→" whitespace toggle (mono 13, padding 8/3, radius 6, hairline divider
 * border; surfaceHigh and text when on, textSecondary when off); and "N
 * changed files" (13 textSecondary) when [fileCount] is known. The
 * unified / split toggle is web-only in happy-app and absent here. Laid
 * out by the caller's row (the header's right slot).
 */
@Composable
fun DiffHeaderRight(
    fileCount: Int?,
    ignoreWhitespace: Boolean,
    onIgnoreWhitespaceChange: (Boolean) -> Unit,
    onRefresh: (() -> Unit)? = null,
    refreshing: Boolean = false,
) {
    val colors = HappyTheme.colors
    if (onRefresh != null) {
        val reload = stringResource(R.string.files_reload)
        Icon(
            Ionicon.Refresh,
            18.dp,
            colors.textSecondary,
            Modifier
                .alpha(if (refreshing) 0.4f else 1f)
                .testTag(DiffHeaderRightTags.REFRESH)
                .clickable(enabled = !refreshing, role = Role.Button, onClick = onRefresh)
                .semantics { contentDescription = reload },
        )
    }
    val label = stringResource(R.string.diff_ignore_whitespace)
    val shape = RoundedCornerShape(6.dp)
    Box(
        modifier = Modifier
            .testTag(DiffHeaderRightTags.WHITESPACE)
            .background(if (ignoreWhitespace) colors.surfaceHigh else Color.Transparent, shape)
            .border(0.5.dp, colors.divider, shape)
            .clickable(role = Role.Switch) { onIgnoreWhitespaceChange(!ignoreWhitespace) }
            .semantics { contentDescription = label }
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text("\u00B7\u2192", style = happyTextStyle(fontSize = 13, family = PlexMono), color = if (ignoreWhitespace) colors.text else colors.textSecondary)
    }
    if (fileCount != null) {
        Text(
            pluralResource(R.plurals.files_changed_files, fileCount, fileCount),
            style = happyTextStyle(fontSize = 13),
            color = colors.textSecondary,
            modifier = Modifier.testTag(DiffHeaderRightTags.COUNT),
        )
    }
}
