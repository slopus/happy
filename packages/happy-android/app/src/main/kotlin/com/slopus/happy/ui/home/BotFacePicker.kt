package com.slopus.happy.ui.home

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
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
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object BotFaceTags {
    const val PICKER = "botFaces"
    fun face(slot: Int) = "botFaces.face.$slot"
    const val DIE = "botFaces.die"
    const val CREDIT = "botFaces.credit"
    const val KIND = "homeDock.kind"
    fun kind(bot: Boolean) = if (bot) "homeDock.kind.bot" else "homeDock.kind.session"
    const val LEDE = "homeDock.botLede"
}

/** BotFacePicker.tsx and NativeSegmentedControl.tsx (the one Android draws). */
object BotFaceSpec {
    val paddingStart = 6.dp
    val paddingEnd = 6.dp
    val paddingTop = 6.dp
    val paddingBottom = 4.dp
    val gap = 6.dp
    val heading = happyTextStyle(fontSize = 12, weight = FontWeight.SemiBold)
    val faceGap = 10.dp
    val faceMax = 52.dp
    val faceRadius = 14.dp
    val ring = 2.dp
    val die = 40.dp
    val dieIcon = 22.dp
    val credit = happyTextStyle(fontSize = 11)

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

/** What the composer shows of a bot being made: its name, the faces on offer, the one picked. */
@Immutable
class HomeDockBot(
    val creating: Boolean,
    val name: String,
    /** The four faces, null while one is being drawn. */
    val faces: List<BotFacePicture?>,
    val slot: Int,
    /** botFaceCredit, once the style is read. */
    val artist: String?,
    val artistUrl: String?,
)

/**
 * BotFacePicker: the faces a new bot may wear. Spec: 6/6/6/4 in, 6 apart:
 * "Avatar" 12 semibold secondary; then the four faces, 10 apart, sharing
 * the row with the die and at most 52 square, radius 14 with a 2 ring
 * always laid out (text colour when picked, else clear); the 40 round die
 * right after (dice-outline 22, glass backgroundSubtle while pressed);
 * then "Art by {artist}", 11 secondary, the name an underlined link.
 */
@Composable
fun BotFacePicker(bot: HomeDockBot, onPick: (Int) -> Unit, onRoll: () -> Unit, onOpenUrl: (String) -> Unit, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Column(
        modifier = modifier
            .testTag(BotFaceTags.PICKER)
            .fillMaxWidth()
            .padding(start = BotFaceSpec.paddingStart, end = BotFaceSpec.paddingEnd, top = BotFaceSpec.paddingTop, bottom = BotFaceSpec.paddingBottom),
        verticalArrangement = Arrangement.spacedBy(BotFaceSpec.gap),
    ) {
        Text(stringResource(R.string.home_dock_bot_avatar), style = BotFaceSpec.heading, color = colors.textSecondary)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(BotFaceSpec.faceGap)) {
            bot.faces.forEachIndexed { index, picture ->
                val picked = index == bot.slot
                val label = stringResource(R.string.home_dock_bot_face, index + 1)
                val shape = RoundedCornerShape(BotFaceSpec.faceRadius)
                Box(
                    modifier = Modifier
                        .testTag(BotFaceTags.face(index))
                        .weight(1f, fill = false)
                        .widthIn(max = BotFaceSpec.faceMax)
                        .fillMaxWidth()
                        .aspectRatio(1f)
                        .clip(shape)
                        .border(BotFaceSpec.ring, if (picked) colors.text else Color.Transparent, shape)
                        .clickable(role = Role.RadioButton) { onPick(index) }
                        .semantics {
                            selected = picked
                            contentDescription = label
                        }
                        .padding(BotFaceSpec.ring)
                        .clip(RoundedCornerShape(BotFaceSpec.faceRadius - BotFaceSpec.ring)),
                ) {
                    if (picture != null) Canvas(Modifier.fillMaxSize()) { drawBotFace(picture) }
                }
            }
            val interaction = remember { MutableInteractionSource() }
            val pressed by interaction.collectIsPressedAsState()
            val roll = stringResource(R.string.home_dock_bot_roll)
            Box(
                modifier = Modifier
                    .testTag(BotFaceTags.DIE)
                    .size(BotFaceSpec.die)
                    .clip(CircleShape)
                    .background(if (pressed) colors.glass.backgroundSubtle else Color.Transparent)
                    .clickable(interaction, indication = null, role = Role.Button, onClick = onRoll)
                    .semantics { contentDescription = roll },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Ionicon.DiceOutline, BotFaceSpec.dieIcon, colors.text)
            }
        }
        if (bot.artist != null) {
            val prefix = stringResource(R.string.home_dock_bot_art_by)
            val credit = buildAnnotatedString {
                append(prefix)
                append(' ')
                val url = bot.artistUrl
                if (url.isNullOrEmpty()) {
                    append(bot.artist)
                } else {
                    withLink(
                        LinkAnnotation.Clickable(
                            "artist",
                            TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline)),
                        ) { onOpenUrl(url) },
                    ) { append(bot.artist) }
                }
            }
            Text(credit, style = BotFaceSpec.credit, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag(BotFaceTags.CREDIT))
        }
    }
}

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
    Column(modifier = modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(BotFaceSpec.headerGap)) {
        val what = stringResource(R.string.home_dock_bot_kind)
        Row(
            modifier = Modifier
                .testTag(BotFaceTags.KIND)
                .widthIn(max = BotFaceSpec.segmentMaxWidth)
                .fillMaxWidth()
                .height(BotFaceSpec.segmentHeight)
                .clip(RoundedCornerShape(BotFaceSpec.segmentRadius))
                .background(colors.glass.backgroundSubtle)
                .semantics { contentDescription = what }
                .padding(BotFaceSpec.segmentPadding),
        ) {
            listOf(false to R.string.home_dock_kind_session, true to R.string.home_dock_kind_bot).forEach { (bot, label) ->
                val selected = bot == creatingBot
                Box(
                    modifier = Modifier
                        .testTag(BotFaceTags.kind(bot))
                        .weight(1f)
                        .fillMaxSize()
                        .clip(RoundedCornerShape(BotFaceSpec.segmentItemRadius))
                        .background(if (selected) colors.surfaceHighest else Color.Transparent)
                        .clickable(role = Role.RadioButton) { onChange(bot) }
                        .semantics { this.selected = selected },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(stringResource(label), style = BotFaceSpec.segmentLabel, color = if (selected) colors.text else colors.textSecondary, maxLines = 1)
                }
            }
        }
        if (creatingBot) {
            Text(
                stringResource(R.string.home_dock_bot_lede),
                style = BotFaceSpec.lede.copy(textAlign = TextAlign.Center),
                color = colors.textSecondary,
                modifier = Modifier.testTag(BotFaceTags.LEDE).widthIn(max = BotFaceSpec.ledeMaxWidth),
            )
        }
    }
}
