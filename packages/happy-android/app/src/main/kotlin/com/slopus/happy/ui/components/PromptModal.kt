package com.slopus.happy.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.slopus.happy.R
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.ui.theme.rgba

object PromptTags {
    const val CONTAINER = "prompt.container"
    const val TITLE = "prompt.title"
    const val MESSAGE = "prompt.message"
    const val INPUT = "prompt.input"
    const val CANCEL = "prompt.cancel"
    const val CONFIRM = "prompt.confirm"
}

enum class PromptInputType { Default, SecureText, EmailAddress, Numeric }

/**
 * What `Modal.prompt(title, message, { placeholder, defaultValue,
 * cancelText, confirmText, inputType })` asks. [onResult] gets the text on
 * confirm and null on cancel, as the promise resolves.
 */
@Immutable
data class Prompt(
    val title: String,
    val message: String? = null,
    val placeholder: String? = null,
    val defaultValue: String? = null,
    val cancelText: String? = null,
    val confirmText: String? = null,
    val inputType: PromptInputType = PromptInputType.Default,
    val onResult: (String?) -> Unit,
)

/** WebPromptModal.tsx, which Android uses for `Modal.prompt`. */
object PromptSpec {
    val width = 270.dp
    val radius = 14.dp
    val contentPaddingHorizontal = 16.dp
    val contentPaddingTop = 20.dp
    val contentPaddingBottom = 16.dp
    val inputHeight = 36.dp
    val inputRadius = 8.dp
    val inputPaddingHorizontal = 10.dp
    val inputMarginTop = 16.dp
    val buttonPaddingVertical = 11.dp
    val title = happyTextStyle(fontSize = 17, weight = FontWeight.SemiBold)
    val message = happyTextStyle(fontSize = 13, lineHeight = 18)
    val input = happyTextStyle(fontSize = 14)
    val button = happyTextStyle(fontSize = 17)
}

/**
 * Spec: a 270 wide card, radius 14, the strong glass colour with a hairline
 * glass border and a soft shadow, over the platform dialog scrim (happy-app
 * blurs and dims 42%). Content is padded
 * 16 / 20 top / 16 bottom and centred: title 17 semibold with 4 under it;
 * message 13/18 with 4 above; a 36 high input 16 below, radius 8, 1px
 * divider border, 10 side padding, 14 text. A divider line, then Cancel
 * and the confirm action side by side, split by a 1 wide divider, each 11
 * vertical padding around 17 link-coloured text (the confirm semibold).
 * The backdrop does not close it; Back cancels. The input takes focus once
 * the dialog is shown; Done confirms.
 */
@Composable
fun PromptModal(prompt: Prompt, onDismiss: () -> Unit) {
    val colors = HappyTheme.colors
    var value by rememberSaveable { mutableStateOf(prompt.defaultValue.orEmpty()) }
    val focus = remember { FocusRequester() }
    val cancel = {
        onDismiss()
        prompt.onResult(null)
    }
    val confirm = {
        onDismiss()
        prompt.onResult(value)
    }
    val glassBorder = if (colors.dark) rgba(255, 255, 255, 0.14f) else rgba(255, 255, 255, 0.82f)
    val shape = RoundedCornerShape(PromptSpec.radius)

    Dialog(
        onDismissRequest = cancel,
        properties = DialogProperties(dismissOnClickOutside = false, usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .width(PromptSpec.width)
                .testTag(PromptTags.CONTAINER)
                .shadow(5.dp, shape)
                .clip(shape)
                .background(colors.glass.backgroundStrong)
                .border(hairline(), glassBorder, shape),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(
                        start = PromptSpec.contentPaddingHorizontal,
                        end = PromptSpec.contentPaddingHorizontal,
                        top = PromptSpec.contentPaddingTop,
                        bottom = PromptSpec.contentPaddingBottom,
                    ),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    prompt.title,
                    style = PromptSpec.title,
                    color = colors.text,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(bottom = 4.dp).testTag(PromptTags.TITLE),
                )
                prompt.message?.let {
                    Text(
                        it,
                        style = PromptSpec.message,
                        color = colors.text,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 4.dp).testTag(PromptTags.MESSAGE),
                    )
                }
                BasicTextField(
                    value = value,
                    onValueChange = { value = it },
                    singleLine = true,
                    textStyle = PromptSpec.input.copy(color = colors.text),
                    cursorBrush = SolidColor(colors.text),
                    visualTransformation = if (prompt.inputType == PromptInputType.SecureText) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = when (prompt.inputType) {
                            PromptInputType.EmailAddress -> KeyboardType.Email
                            PromptInputType.Numeric -> KeyboardType.Number
                            PromptInputType.SecureText -> KeyboardType.Password
                            PromptInputType.Default -> KeyboardType.Text
                        },
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { confirm() }),
                    modifier = Modifier
                        .padding(top = PromptSpec.inputMarginTop)
                        .fillMaxWidth()
                        .height(PromptSpec.inputHeight)
                        .testTag(PromptTags.INPUT)
                        .focusRequester(focus),
                    decorationBox = { inner ->
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(PromptSpec.inputHeight)
                                .clip(RoundedCornerShape(PromptSpec.inputRadius))
                                .background(colors.input.background)
                                .border(1.dp, colors.divider, RoundedCornerShape(PromptSpec.inputRadius))
                                .padding(horizontal = PromptSpec.inputPaddingHorizontal),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            if (value.isEmpty() && prompt.placeholder != null) {
                                Text(prompt.placeholder, style = PromptSpec.input, color = colors.input.placeholder, maxLines = 1)
                            }
                            inner()
                        }
                    },
                )
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(colors.divider))
            Row(modifier = Modifier.fillMaxWidth().height(androidx.compose.foundation.layout.IntrinsicSize.Min), horizontalArrangement = Arrangement.Center) {
                PromptButton(
                    text = prompt.cancelText ?: stringResource(R.string.common_cancel),
                    bold = false,
                    tag = PromptTags.CANCEL,
                    onClick = cancel,
                    modifier = Modifier.weight(1f),
                )
                Box(Modifier.width(1.dp).fillMaxHeight().background(colors.divider))
                PromptButton(
                    text = prompt.confirmText ?: stringResource(R.string.common_ok),
                    bold = true,
                    tag = PromptTags.CONFIRM,
                    onClick = confirm,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
}

@Composable
private fun PromptButton(text: String, bold: Boolean, tag: String, onClick: () -> Unit, modifier: Modifier) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier = modifier
            .testTag(tag)
            .background(if (pressed) colors.divider else Color.Transparent)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
            .padding(vertical = PromptSpec.buttonPaddingVertical),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = PromptSpec.button.copy(fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal),
            color = colors.textLink,
            maxLines = 1,
        )
    }
}
