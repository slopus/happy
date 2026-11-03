package com.slopus.happy.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.home.BotFaceSpec
import com.slopus.happy.ui.theme.HappyTheme

/** One segment of [SegmentedTabs]: what it says and its test tag. */
data class Segment(val label: String, val tag: String)

/**
 * A few views of one thing, as the app's segmented control draws them
 * (BotFacePicker's and new work's: a 32 high track on the subtle glass, 2
 * in, radius 9; the picked segment surfaceHighest, radius 7, in the text
 * colour; the others secondary; 13 semibold). Each segment is as wide as
 * its label plus 14 a side, at least 64; a pick other than [selected]
 * ticks and goes to [onPick].
 */
@Composable
fun SegmentedTabs(segments: List<Segment>, selected: Int, onPick: (Int) -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    val haptics = LocalHapticFeedback.current
    Row(
        modifier
            .heightIn(min = BotFaceSpec.segmentHeight)
            .clip(RoundedCornerShape(BotFaceSpec.segmentRadius))
            .background(colors.glass.backgroundSubtle)
            .padding(BotFaceSpec.segmentPadding),
    ) {
        segments.forEachIndexed { index, segment ->
            val picked = index == selected
            Box(
                Modifier
                    .testTag(segment.tag)
                    .widthIn(min = 64.dp)
                    .heightIn(min = BotFaceSpec.segmentHeight - BotFaceSpec.segmentPadding * 2)
                    .clip(RoundedCornerShape(BotFaceSpec.segmentItemRadius))
                    .background(if (picked) colors.surfaceHighest else Color.Transparent)
                    .clickable(role = Role.Tab) {
                        if (!picked) {
                            haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                            onPick(index)
                        }
                    }
                    .semantics { this.selected = picked }
                    .padding(horizontal = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(segment.label, style = BotFaceSpec.segmentLabel, color = if (picked) colors.text else colors.textSecondary, maxLines = 1)
            }
        }
    }
}
