package com.slopus.happy.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object BotKindTags {
    const val KIND = "homeDock.kind"
    fun kind(bot: Boolean) = if (bot) "homeDock.kind.bot" else "homeDock.kind.session"
    const val LEDE = "homeDock.botLede"
}

/** HomeDock.tsx's Session | Bot and NativeSegmentedControl.tsx (the one Android draws). */
object BotKindSpec {
    val segmentHeight = 32.dp
    val segmentPadding = 2.dp
    val segmentRadius = 9.dp
    val segmentItemRadius = 7.dp
    val segmentMaxWidth = 260.dp
    val segmentLabel = happyTextStyle(fontSize = 13, weight = FontWeight.SemiBold)
    val ledeMaxWidth = 340.dp
    val lede = happyTextStyle(fontSize = 13, lineHeight = 18)
    val headerGap = 10.dp
}

/**
 * What the composer shows of a bot being made: its name. It wears the
 * placeholder its ID picks, as every bot without a picture does.
 */
@Immutable
class HomeDockBot(
    val creating: Boolean,
    val name: String,
)

/**
 * The focused dock's header while bots can be made (HomeDock.tsx
 * focusHeader): Session | Bot, a segmented control at most 260 wide (32
 * high, 2 in, radius 9 on glass backgroundSubtle; the picked segment
 * surfaceHighest, radius 7; 13 semibold labels, secondary unless picked);
 * while Bot is picked, 10 under it, what a bot is for, 13/18 secondary,
 * centred, at most 340 wide.
 */
@Composable
fun BotKindHeader(creatingBot: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Column(modifier = modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(BotKindSpec.headerGap)) {
        val what = stringResource(R.string.home_dock_bot_kind)
        Row(
            modifier = Modifier
                .testTag(BotKindTags.KIND)
                .widthIn(max = BotKindSpec.segmentMaxWidth)
                .fillMaxWidth()
                .height(BotKindSpec.segmentHeight)
                .clip(RoundedCornerShape(BotKindSpec.segmentRadius))
                .background(colors.glass.backgroundSubtle)
                .semantics { contentDescription = what }
                .padding(BotKindSpec.segmentPadding),
        ) {
            listOf(false to R.string.home_dock_kind_session, true to R.string.new_work_bot).forEach { (bot, label) ->
                val selected = bot == creatingBot
                Box(
                    modifier = Modifier
                        .testTag(BotKindTags.kind(bot))
                        .weight(1f)
                        .fillMaxSize()
                        .clip(RoundedCornerShape(BotKindSpec.segmentItemRadius))
                        .background(if (selected) colors.surfaceHighest else Color.Transparent)
                        .clickable(role = Role.RadioButton) { onChange(bot) }
                        .semantics { this.selected = selected },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(stringResource(label), style = BotKindSpec.segmentLabel, color = if (selected) colors.text else colors.textSecondary, maxLines = 1)
                }
            }
        }
        if (creatingBot) {
            Text(
                stringResource(R.string.home_dock_bot_lede),
                style = BotKindSpec.lede.copy(textAlign = TextAlign.Center),
                color = colors.textSecondary,
                modifier = Modifier.testTag(BotKindTags.LEDE).widthIn(max = BotKindSpec.ledeMaxWidth),
            )
        }
    }
}
