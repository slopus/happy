package com.slopus.happy.ui.voice

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.Settings
import com.slopus.happy.ui.components.*
import com.slopus.happy.ui.settings.ItemIcon
import com.slopus.happy.ui.settings.SettingsSpec
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.voice.VoiceLanguages
import com.slopus.happy.voice.VoiceUsage
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.home.copyToClipboard
import com.slopus.happy.ui.chat.ChatTheme
import java.text.NumberFormat

/**
 * settings/voice.tsx: standard ItemGroups on the grouped surface. Usage has 16/8
 * insets, 14pt labels, 8-high tracks, radius 4, blue/red at the limit; 13pt totals
 * 4 below. Language and BYO use 29 icons and standard Item sizing. Setting a
 * trimmed custom agent enables Direct Connection; clearing it disables it.
 */
@Composable
fun VoiceSettingsScreen(
    settings: Settings,
    onSettingsChange: ((Settings) -> Settings) -> Unit,
    usage: VoiceUsage?,
    usageLoading: Boolean,
    hasPro: Boolean,
    onSupport: () -> Unit,
    onLanguage: () -> Unit,
    onBack: () -> Unit,
    developerContent: (@Composable () -> Unit)? = null,
) {
    val colors = HappyTheme.colors
    val context = LocalContext.current
    var editing by rememberSaveable { mutableStateOf(false) }
    Screen(header = { StackHeader(stringResource(R.string.settings_voice_assistant), onBack) }) {
        ItemList {
            if (usageLoading) {
                Box(Modifier.fillMaxWidth().padding(vertical = 24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = colors.textSecondary, strokeWidth = 2.dp)
                }
            } else if (usage != null) {
                ItemGroup(title = stringResource(R.string.settings_voice_usage_title), footer = stringResource(R.string.settings_voice_usage_footer)) {
                    Column(Modifier.testTag("voice.usage").padding(horizontal = 16.dp, vertical = 8.dp)) {
                        VoiceUsageMeter(stringResource(R.string.settings_voice_usage_label), usage.usedSeconds, usage.limitSeconds)
                        Text("${formatVoiceTime(usage.usedSeconds)} / ${formatVoiceTime(usage.limitSeconds)}", color = Color(0xFF8E8E93), style = happyTextStyle(13), modifier = Modifier.padding(top = 4.dp))
                        VoiceUsageMeter(stringResource(R.string.settings_voice_conversations_label), usage.conversationCount, usage.conversationLimit)
                        Text("${usage.conversationCount} / ${usage.conversationLimit}", color = Color(0xFF8E8E93), style = happyTextStyle(13), modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }
            if (!hasPro) ItemGroup {
                Item(title = stringResource(R.string.settings_voice_support_title), subtitle = stringResource(R.string.settings_voice_support_subtitle),
                    icon = { ItemIcon(Ionicon.HeartOutline, Color(0xFFFF2D55)) }, onClick = onSupport, modifier = Modifier.testTag("voice.support"))
            }
            developerContent?.invoke()
            ItemGroup(title = stringResource(R.string.settings_voice_language_title), footer = stringResource(R.string.settings_voice_language_description)) {
                Item(title = stringResource(R.string.settings_voice_preferred_language), subtitle = stringResource(R.string.settings_voice_preferred_language_subtitle),
                    detail = (VoiceLanguages.find(settings.voiceAssistantLanguage) ?: VoiceLanguages.all.first()).displayName,
                    icon = { ItemIcon(Ionicon.LanguageOutline, SettingsSpec.blue) }, onClick = onLanguage,
                    modifier = Modifier.testTag("voice.language"))
            }
            ItemGroup(title = stringResource(R.string.settings_voice_byo_title), footer = stringResource(R.string.settings_voice_byo_description)) {
                Item(title = stringResource(R.string.settings_voice_custom_agent_id),
                    subtitle = settings.voiceCustomAgentId ?: stringResource(R.string.settings_voice_custom_agent_id_not_set),
                    icon = { ItemIcon(Ionicon.KeyOutline, SettingsSpec.orange) }, onClick = { editing = true }, modifier = Modifier.testTag("voice.agent"))
                val bypass = stringResource(R.string.settings_voice_bypass_token)
                Item(title = bypass, subtitle = stringResource(R.string.settings_voice_bypass_token_subtitle),
                    icon = { ItemIcon(Ionicon.FlashOutline, SettingsSpec.red) },
                    rightElement = { HappySwitch(settings.voiceBypassToken, { value -> onSettingsChange { it.copy(voiceBypassToken = value) } }, label = bypass) })
            }
            settings.voiceCustomAgentId?.takeIf { it.isNotEmpty() }?.let { id ->
                ItemGroup(title = stringResource(R.string.settings_voice_prompt_guide_title), footer = stringResource(R.string.settings_voice_prompt_guide_description)) {
                    Item(title = stringResource(R.string.settings_voice_custom_agent_id), subtitle = id,
                        onClick = { copyToClipboard(context, id) }, showChevron = false)
                }
            }
        }
    }
    if (editing) PromptModal(
        Prompt(title = stringResource(R.string.settings_voice_custom_agent_id), message = stringResource(R.string.settings_voice_custom_agent_id_description),
            placeholder = stringResource(R.string.settings_voice_custom_agent_id_placeholder), defaultValue = settings.voiceCustomAgentId.orEmpty(),
            onResult = { value ->
                editing = false
                if (value != null) onSettingsChange { setCustomVoiceAgent(it, value) }
            }),
        onDismiss = { editing = false },
    )
}

internal fun setCustomVoiceAgent(settings: Settings, value: String): Settings {
    val id = value.trim().takeIf { it.isNotEmpty() }
    return settings.copy(voiceCustomAgentId = id, voiceBypassToken = id != null)
}

private fun formatVoiceTime(seconds: Int) = "${seconds / 60}m ${seconds % 60}s"

/** UsageBar.tsx: 8 vertical margin, label row 4 above the 8-high track, capped at 100%. */
@Composable
private fun VoiceUsageMeter(label: String, value: Int, limit: Int) {
    val colors = HappyTheme.colors
    val fraction = if (limit > 0) (value.toFloat() / limit).coerceIn(0f, 1f) else 0f
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth().padding(bottom = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = happyTextStyle(14), color = colors.text)
            Text(NumberFormat.getIntegerInstance().format(value), style = happyTextStyle(14, weight = FontWeight.SemiBold), color = colors.textSecondary)
        }
        Box(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)).background(colors.divider)) {
            Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().background(if (value >= limit) SettingsSpec.red else SettingsSpec.blue, RoundedCornerShape(4.dp)))
        }
    }
}

/**
 * settings/voice/language.tsx: search inset 16/12, glass field radius 16, hairline
 * border and 12/8 padding, 20 search icon 8 before 16pt text. Standard language
 * rows have 29 icons, a 24 selected checkmark, no chevrons, and select immediately.
 */
@Composable
fun VoiceLanguageScreen(preferred: String?, onSelect: (String?) -> Unit, onBack: () -> Unit) {
    val colors = HappyTheme.colors
    var query by rememberSaveable { mutableStateOf("") }
    val languages = remember(query) { VoiceLanguages.all.filter { it.matches(query) } }
    Screen(header = { StackHeader(stringResource(R.string.settings_voice__language__title), onBack) }) {
        ItemList {
            Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                Row(Modifier.testTag("voice.searchField").fillMaxWidth().background(colors.glass.backgroundStrong, RoundedCornerShape(16.dp))
                    .border(.5.dp, ChatTheme.colors.glassBorder, RoundedCornerShape(16.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(Ionicon.SearchOutline, 20.dp, colors.textSecondary)
                    Spacer(Modifier.width(8.dp))
                    BasicTextField(query, onValueChange = { query = it }, singleLine = true, textStyle = happyTextStyle(16).copy(color = colors.input.text),
                        cursorBrush = SolidColor(colors.text), modifier = Modifier.weight(1f).testTag("voice.search"),
                        decorationBox = { field ->
                            Box {
                                if (query.isEmpty()) Text(stringResource(R.string.settings_voice_language_search_placeholder), style = happyTextStyle(16), color = colors.input.placeholder)
                                field()
                            }
                        })
                    if (query.isNotEmpty()) {
                        Spacer(Modifier.width(8.dp))
                        HeaderIconButton(Ionicon.CloseCircle, stringResource(R.string.voice_clear_search), { query = "" }, iconSize = 20.dp, buttonSize = 20.dp)
                    }
                }
            }
            ItemGroup(title = stringResource(R.string.settings_voice__language__title),
                footer = pluralResource(R.plurals.settings_voice_language_footer, languages.size, languages.size)) {
                for (language in languages) Item(title = language.displayName,
                    subtitle = language.code ?: stringResource(R.string.settings_voice_language_auto_detect),
                    icon = { ItemIcon(Ionicon.LanguageOutline, SettingsSpec.blue) },
                    rightElement = if (preferred == language.code) ({ Icon(Ionicon.CheckmarkCircle, 24.dp, SettingsSpec.blue) }) else null,
                    onClick = { onSelect(language.code); onBack() }, showChevron = false,
                    modifier = Modifier.testTag("voice.language.${language.code ?: "auto"}"))
            }
        }
    }
}