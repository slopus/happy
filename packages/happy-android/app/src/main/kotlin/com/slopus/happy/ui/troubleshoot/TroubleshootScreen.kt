package com.slopus.happy.ui.troubleshoot

import android.content.ClipData
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.onboarding.DESKTOP_URL
import com.slopus.happy.ui.onboarding.TerminalBlock
import com.slopus.happy.ui.onboarding.TerminalLine
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

object TroubleshootTags {
    const val CONTENT = "troubleshoot.content"
    const val HEADING = "troubleshoot.heading"
    const val INTRO = "troubleshoot.intro"
    const val STEP = "troubleshoot.step"
    const val STEP_ICON = "troubleshoot.stepIcon"
    const val TERMINAL = "troubleshoot.terminal"
    const val COPY = "troubleshoot.copy"
    const val HINT = "troubleshoot.hint"
}

/** troubleshoot.tsx styles. */
object TroubleshootSpec {
    val paddingHorizontal = 24.dp
    val paddingTop = 20.dp
    val headingGap = 8.dp
    val introGap = 24.dp
    val stepGap = 12.dp
    val stepSpacing = 20.dp
    val stepIconWidth = 26.dp
    val stepIconHeight = 22.dp
    val stepIcon = 22.dp
    val stepTitleGap = 4.dp
    val terminalGap = 12.dp
    val machineIcon = 28.dp
    val promptPaddingTop = 20.dp
    val buttonWidth = 260.dp
    val hintGap = 8.dp
    val heading = happyTextStyle(fontSize = 24, lineHeight = 30, weight = FontWeight.SemiBold)
    val intro = happyTextStyle(fontSize = 15, lineHeight = 21)
    val stepTitle = happyTextStyle(fontSize = 17, lineHeight = 22, weight = FontWeight.SemiBold)
    val stepBody = happyTextStyle(fontSize = 15, lineHeight = 21)
    val hint = happyTextStyle(fontSize = 13, lineHeight = 18)
}

/**
 * What to check when every linked computer is offline (troubleshoot.tsx),
 * in order of likelihood: asleep, Happy Desktop not open, the terminal
 * daemon stopped. Then the computers (rows open the machine screen through
 * [onOpenMachine]) and "Copy AI prompt", which points a coding agent on the
 * computer at the local Happy logs.
 *
 * Spec: content 24 side padding, 20 top. Heading 24/30 semibold, 8 above
 * the intro 15/21 secondary, 24 above the steps. A step is a 26x22 icon
 * slot (22 icon, secondary) 12 before its text, 20 below the step: title
 * 17/22 semibold 4 above the body 15/21 secondary. The terminal step adds a
 * [TerminalBlock] 12 below its body. The Machines group lists each computer
 * with a 28 desktop icon, "Offline" under the offline ones and a chevron.
 * Last, 20 below, centred: a 260 wide quiet button ("Copied" for 2 s after
 * copying) and the hint 13/18 secondary 8 below it.
 */
@Composable
fun TroubleshootScreen(
    computers: List<TroubleshootComputer>,
    aiPrompt: String,
    onOpenMachine: (id: String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    val error = stringResource(R.string.common_error)
    val copyFailed = stringResource(R.string.troubleshoot_copy_failed)
    val ok = stringResource(R.string.common_ok)

    LaunchedEffect(copied) {
        if (copied) {
            delay(2000)
            copied = false
        }
    }

    Screen(header = { StackHeader(stringResource(R.string.troubleshoot_title), onBack, TitleAlignment.Center) }) {
        ItemList {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(TroubleshootTags.CONTENT)
                    .padding(start = TroubleshootSpec.paddingHorizontal, end = TroubleshootSpec.paddingHorizontal, top = TroubleshootSpec.paddingTop),
            ) {
                Text(
                    text = stringResource(R.string.troubleshoot_heading),
                    style = TroubleshootSpec.heading,
                    color = colors.text,
                    modifier = Modifier.padding(bottom = TroubleshootSpec.headingGap).testTag(TroubleshootTags.HEADING),
                )
                Text(
                    text = stringResource(R.string.troubleshoot_intro),
                    style = TroubleshootSpec.intro,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(bottom = TroubleshootSpec.introGap).testTag(TroubleshootTags.INTRO),
                )
                Step(Ionicon.MoonOutline, stringResource(R.string.troubleshoot_awake_step)) {
                    StepBody(stringResource(R.string.troubleshoot_awake_body))
                }
                Step(Ionicon.DesktopOutline, stringResource(R.string.troubleshoot_desktop_step)) {
                    val linkStyle = TextLinkStyles(SpanStyle(color = colors.text, textDecoration = TextDecoration.Underline))
                    val text = buildAnnotatedString {
                        append(stringResource(R.string.troubleshoot_desktop_body_prefix))
                        withLink(LinkAnnotation.Clickable(DESKTOP_URL, linkStyle) { onOpenUrl(DESKTOP_URL) }) {
                            append(stringResource(R.string.troubleshoot_desktop_body_link))
                        }
                        append(stringResource(R.string.troubleshoot_desktop_body_suffix))
                    }
                    Text(text = text, style = TroubleshootSpec.stepBody, color = colors.textSecondary)
                }
                Step(Ionicon.TerminalOutline, stringResource(R.string.troubleshoot_terminal_step)) {
                    StepBody(stringResource(R.string.troubleshoot_terminal_body))
                    TerminalBlock(
                        lines = listOf(
                            TerminalLine.Comment(stringResource(R.string.troubleshoot_terminal_comment)),
                            TerminalLine.Command(stringResource(R.string.onboarding_terminal_install)),
                            TerminalLine.Command(stringResource(R.string.onboarding_terminal_run)),
                        ),
                        modifier = Modifier.padding(top = TroubleshootSpec.terminalGap).testTag(TroubleshootTags.TERMINAL),
                    )
                }
            }

            if (computers.isNotEmpty()) {
                ItemGroup(title = stringResource(R.string.troubleshoot_machines)) {
                    val offline = stringResource(R.string.troubleshoot_machine_offline)
                    computers.forEach { computer ->
                        Item(
                            title = computer.name,
                            subtitle = if (computer.online) null else offline,
                            icon = { Icon(Ionicon.DesktopOutline, TroubleshootSpec.machineIcon, colors.textSecondary) },
                            onClick = { onOpenMachine(computer.id) },
                        )
                    }
                }
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = TroubleshootSpec.paddingHorizontal, end = TroubleshootSpec.paddingHorizontal, top = TroubleshootSpec.promptPaddingTop),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(modifier = Modifier.widthIn(max = TroubleshootSpec.buttonWidth).fillMaxWidth().testTag(TroubleshootTags.COPY)) {
                    RoundButton(
                        title = stringResource(if (copied) R.string.troubleshoot_copied else R.string.troubleshoot_copy_ai_prompt),
                        onClick = {
                            scope.launch {
                                try {
                                    clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(aiPrompt, aiPrompt)))
                                    copied = true
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (_: Exception) {
                                    alert = Alert(error, copyFailed, listOf(AlertButton(ok)))
                                }
                            }
                        },
                        size = RoundButtonSize.Normal,
                        display = RoundButtonDisplay.Inverted,
                    )
                }
                Text(
                    text = stringResource(R.string.troubleshoot_copy_ai_prompt_hint),
                    style = TroubleshootSpec.hint,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = TroubleshootSpec.hintGap).testTag(TroubleshootTags.HINT),
                )
            }
        }
    }
    alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
}

@Composable
private fun Step(icon: Ionicon, title: String, body: @Composable () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth().padding(bottom = TroubleshootSpec.stepSpacing).testTag(TroubleshootTags.STEP),
        horizontalArrangement = Arrangement.spacedBy(TroubleshootSpec.stepGap),
    ) {
        Box(
            modifier = Modifier.size(TroubleshootSpec.stepIconWidth, TroubleshootSpec.stepIconHeight).testTag(TroubleshootTags.STEP_ICON),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon = icon, size = TroubleshootSpec.stepIcon, color = colors.textSecondary)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = TroubleshootSpec.stepTitle,
                color = colors.text,
                modifier = Modifier.padding(bottom = TroubleshootSpec.stepTitleGap),
            )
            body()
        }
    }
}

@Composable
private fun StepBody(text: String) {
    Text(text = text, style = TroubleshootSpec.stepBody, color = HappyTheme.colors.textSecondary)
}
