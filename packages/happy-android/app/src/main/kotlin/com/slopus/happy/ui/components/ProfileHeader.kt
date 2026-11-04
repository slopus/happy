package com.slopus.happy.ui.components

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.conversation.DetailFormat
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date

object ProfileHeaderTags {
    const val AVATAR = "profile.avatar"
    const val NAME = "profile.name"
    const val SUBTITLE = "profile.subtitle"
    const val TILE = "profile.tile"
    const val PLACEHOLDER = "profile.placeholder"
}

/** iOS ProfileHeaderLayout and SessionDetailLayout.Metrics, shared by both chat profiles. */
object ProfileHeaderSpec {
    val top = 12.dp
    val mark = 88.dp
    val nameGap = 14.dp
    val subtitleGap = 2.dp
    val textSide = 24.dp
    val tilesTop = 24.dp
    val tileGap = 10.dp
    val tileHeight = 80.dp
    val tileRadius = 22.dp
    val tileInset = 16.dp
    val valueTop = 14.dp
    val name = happyTextStyle(fontSize = 28, lineHeight = 34, weight = FontWeight.Medium)
    val subtitle = happyTextStyle(fontSize = 17, lineHeight = 22)
    val value = happyTextStyle(fontSize = 24, lineHeight = 30, weight = FontWeight.SemiBold)
    val label = happyTextStyle(fontSize = 13, lineHeight = 18)
}

/** An 88 dp avatar, centred name (28/34) and subtitle (17/22), with 12/14/2 dp gaps. */
@Composable
fun ProfileHeader(name: String?, subtitle: String, avatar: @Composable () -> Unit) {
    val spec = ProfileHeaderSpec
    val colors = HappyTheme.colors
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(spec.top))
        Box(Modifier.size(spec.mark).testTag(ProfileHeaderTags.AVATAR)) { avatar() }
        Spacer(Modifier.height(spec.nameGap))
        val nameLine = with(LocalDensity.current) { spec.name.lineHeight.toDp() }
        Box(Modifier.padding(horizontal = spec.textSide).heightIn(min = nameLine).testTag(ProfileHeaderTags.NAME), contentAlignment = Alignment.Center) {
            if (name != null) {
                Text(name, style = spec.name, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
            } else {
                ProfilePlaceholder(Modifier.width(180.dp).height(26.dp))
            }
        }
        Spacer(Modifier.height(spec.subtitleGap))
        Text(subtitle, style = spec.subtitle, color = colors.textSecondary, maxLines = 1,
            overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = spec.textSide).fillMaxWidth().testTag(ProfileHeaderTags.SUBTITLE))
    }
}

/** A profile statistic, at least 80 dp high; its 24/30 value shrinks to 14 sp to fit. */
@Composable
fun ProfileTile(value: String?, label: String, modifier: Modifier = Modifier) {
    val spec = ProfileHeaderSpec
    val colors = HappyTheme.colors
    Column(modifier.testTag(ProfileHeaderTags.TILE).heightIn(min = spec.tileHeight)
        .clip(RoundedCornerShape(spec.tileRadius)).background(colors.surface)
        .semantics(mergeDescendants = true) {}
        .padding(start = spec.tileInset, end = spec.tileInset, top = spec.valueTop, bottom = 4.dp)) {
        val line = with(LocalDensity.current) { spec.value.lineHeight.toDp() }
        Box(Modifier.fillMaxWidth().heightIn(min = line), contentAlignment = Alignment.CenterStart) {
            if (value != null) {
                BasicText(value, style = spec.value.copy(color = colors.text), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    autoSize = TextAutoSize.StepBased(minFontSize = 14.sp, maxFontSize = spec.value.fontSize))
            } else {
                ProfilePlaceholder(Modifier.width(72.dp).height(20.dp))
            }
        }
        Text(label, style = spec.label, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
internal fun ProfilePlaceholder(modifier: Modifier) {
    val colors = HappyTheme.colors
    val ground = colors.surfaceHighest
    val still = rememberReduceMotion()
    Box(modifier.testTag(ProfileHeaderTags.PLACEHOLDER).clip(RoundedCornerShape(6.dp)).background(ground)
        .then(if (still) Modifier else Modifier.shimmer(lerp(ground, if (colors.dark) Color.White else Color.Black, 0.06f))))
}

/** DetailFormat.started, with the phone's locale, time convention and timezone. */
@Composable
fun profileStartedText(since: Long, now: Long): String {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val zone = ZoneId.systemDefault()
    val date = Instant.ofEpochMilli(since).atZone(zone)
    fun pattern(skeleton: String) = DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, skeleton), locale)
    val time = DateFormat.getTimeFormat(context).format(Date(since))
    return when (DetailFormat.started(since, now, zone)) {
        DetailFormat.Started.Today -> stringResource(R.string.agent_page_started_today, time)
        DetailFormat.Started.Yesterday -> stringResource(R.string.agent_page_started_yesterday, time)
        DetailFormat.Started.Weekday -> date.format(pattern("EEEjmm"))
        DetailFormat.Started.ThisYear -> date.format(pattern("MMMd"))
        DetailFormat.Started.Date -> date.format(pattern("yMMMd"))
    }
}