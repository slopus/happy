package com.slopus.happy.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.ProviderIconKind
import com.slopus.happy.ui.theme.HappyTheme

/**
 * ProviderIcon.tsx: [size] square (14 by default). Codex and Claude are
 * their marks (Codex tinted secondary); Grok a flash, Kimi a moon, anything
 * else sparkles, all in the secondary text colour.
 */
@Composable
fun ProviderIcon(kind: ProviderIconKind?, modifier: Modifier = Modifier, size: Dp = 14.dp) {
    val colors = HappyTheme.colors
    when (kind ?: ProviderIconKind.Generic) {
        ProviderIconKind.Codex, ProviderIconKind.Claude -> Image(
            painter = painterResource(if (kind == ProviderIconKind.Codex) R.drawable.icon_gpt else R.drawable.icon_claude),
            contentDescription = null,
            contentScale = ContentScale.Fit,
            colorFilter = if (kind == ProviderIconKind.Codex) ColorFilter.tint(colors.textSecondary) else null,
            modifier = modifier.size(size),
        )
        ProviderIconKind.Grok -> Icon(Ionicon.FlashOutline, size, colors.textSecondary, modifier)
        ProviderIconKind.Kimi -> Icon(Ionicon.MoonOutline, size, colors.textSecondary, modifier)
        ProviderIconKind.Generic -> Icon(Ionicon.SparklesOutline, size, colors.textSecondary, modifier)
    }
}
