package com.slopus.happy.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.prettyJson
import com.slopus.happy.model.InfoSetting
import com.slopus.happy.model.SandboxSummary
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

@Composable
internal fun InfoRow(title: String, subtitle: String, icon: Ionicon, modifier: Modifier = Modifier) {
    Item(
        title = title,
        modifier = modifier,
        subtitle = subtitle,
        icon = { Icon(icon, size = SessionInfoSpec.icon, color = SessionInfoSpec.purple) },
        showChevron = false,
    )
}

@Composable
internal fun DetailRow(title: String, detail: String, icon: Ionicon) {
    Item(
        title = title,
        detail = detail,
        icon = { Icon(icon, size = SessionInfoSpec.icon, color = SessionInfoSpec.purple) },
        showChevron = false,
    )
}

/** info.tsx `CopyableItem`: the resume command, copied with a checkmark for two seconds. */
@Composable
internal fun CopyableItem(command: String, copyToClipboard: (String) -> Boolean) {
    var copied by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Item(
        title = stringResource(R.string.home_info_resume_command),
        subtitle = command,
        icon = { Icon(Ionicon.PlayCircleOutline, size = SessionInfoSpec.icon, color = SessionInfoSpec.green) },
        showChevron = false,
        rightElement = {
            Icon(
                if (copied) Ionicon.Checkmark else Ionicon.CopyOutline,
                size = 18.dp,
                color = if (copied) SessionInfoSpec.green else SessionInfoSpec.gray,
            )
        },
        onClick = {
            if (!copyToClipboard(command)) return@Item
            copied = true
            scope.launch {
                kotlinx.coroutines.delay(2_000)
                copied = false
            }
        },
        modifier = Modifier.testTag(SessionInfoTags.RESUME_COMMAND),
    )
}

@Composable
internal fun RawJson(title: String, icon: Ionicon, color: Color, json: JsonObject) {
    val colors = HappyTheme.colors
    Item(title = title, icon = { Icon(icon, size = SessionInfoSpec.icon, color = color) }, showChevron = false)
    Box(
        modifier = Modifier
            .padding(start = 16.dp, end = 16.dp, bottom = 12.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(colors.surfaceHigh)
            .horizontalScroll(rememberScrollState())
            .padding(12.dp),
    ) {
        Text(prettyJson(json), style = SessionInfoSpec.code, color = colors.text)
    }
}

@Composable
internal fun sandboxText(summary: SandboxSummary): String = when (summary) {
    SandboxSummary.Disabled -> stringResource(R.string.home_info_disabled)
    is SandboxSummary.Text -> summary.text
    is SandboxSummary.Enabled -> buildList {
        add(stringResource(R.string.home_info_enabled))
        summary.isolation?.let { add("isolation=$it") }
        summary.network?.let { add("network=$it") }
        summary.workspace?.let { add("workspace=$it") }
    }.joinToString(" | ")
}

@Composable
internal fun settingText(setting: InfoSetting): String = stringResource(
    when (setting) {
        InfoSetting.Enabled -> R.string.home_info_enabled
        InfoSetting.Disabled -> R.string.home_info_disabled
        InfoSetting.Unknown -> R.string.home_info_unknown
    },
)

/** A number as JS prints it: whole numbers without a decimal point. */
internal fun formatNumber(value: Double): String =
    if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()
