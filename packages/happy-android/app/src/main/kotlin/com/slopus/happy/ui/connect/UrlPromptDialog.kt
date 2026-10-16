package com.slopus.happy.ui.connect

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.slopus.happy.R
import com.slopus.happy.ui.components.hairline
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object UrlPromptTags {
    const val CARD = "urlPrompt.card"
    const val INPUT = "urlPrompt.input"
    const val CANCEL = "urlPrompt.cancel"
    const val CONFIRM = "urlPrompt.confirm"
}

/** WebPromptModal.tsx, the Android `Modal.prompt`. */
object UrlPromptSpec {
    val width = 270.dp
    val radius = 14.dp
    val contentPaddingHorizontal = 16.dp
    val contentPaddingTop = 20.dp
    val contentPaddingBottom = 16.dp
    val titleGap = 4.dp
    val messageGap = 4.dp
    val inputHeight = 36.dp
    val inputRadius = 8.dp
    val inputPaddingHorizontal = 10.dp
    val inputGap = 16.dp
    val buttonPaddingVertical = 11.dp
    val title = happyTextStyle(fontSize = 17, weight = FontWeight.SemiBold)
    val message = happyTextStyle(fontSize = 13, lineHeight = 18)
    val input = happyTextStyle(fontSize = 14)
    val cancel = happyTextStyle(fontSize = 17)
    val confirm = happyTextStyle(fontSize = 17, weight = FontWeight.SemiBold)
}

/**
 * `Modal.prompt` on Android (WebPromptModal.tsx): a 270 wide card, radius
 * 14, on glass.backgroundStrong with a hairline border. Content 16 side, 20
 * top, 16 bottom padding, centred: title 17 semibold, message 13/18 4 below
 * it, then a 36 high field (1 border in divider, radius 8, 10 side padding,
 * 14 text) 16 below. Under a 1 divider, Cancel and the confirm action share
 * the width, 11 vertical padding, 17 in textLink (confirm semibold), split
 * by a 1 divider. The field takes focus; the backdrop does not dismiss.
 * Returns the text, or null for Cancel.
 */
@Composable
fun UrlPromptDialog(
    title: String,
    message: String?,
    placeholder: String,
    confirmText: String,
    onResult: (String?) -> Unit,
    cancelText: String = stringResource(R.string.common_cancel),
) {
    val colors = HappyTheme.colors
    var value by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }

    Dialog(
        onDismissRequest = { onResult(null) },
        properties = DialogProperties(dismissOnClickOutside = false),
    ) {
        val shape = RoundedCornerShape(UrlPromptSpec.radius)
        Column(
            modifier = Modifier
                .width(UrlPromptSpec.width)
                .testTag(UrlPromptTags.CARD)
                .clip(shape)
                .background(colors.glass.backgroundStrong)
                .border(hairline(), colors.glass.divider, shape),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(
                        start = UrlPromptSpec.contentPaddingHorizontal,
                        end = UrlPromptSpec.contentPaddingHorizontal,
                        top = UrlPromptSpec.contentPaddingTop,
                        bottom = UrlPromptSpec.contentPaddingBottom,
                    ),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = title,
                    style = UrlPromptSpec.title,
                    color = colors.text,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(bottom = UrlPromptSpec.titleGap),
                )
                if (message != null) {
                    Text(
                        text = message,
                        style = UrlPromptSpec.message,
                        color = colors.text,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = UrlPromptSpec.messageGap),
                    )
                }
                val inputStyle = UrlPromptSpec.input.copy(color = colors.text)
                BasicTextField(
                    value = value,
                    onValueChange = { value = it },
                    singleLine = true,
                    textStyle = inputStyle,
                    cursorBrush = SolidColor(colors.text),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { onResult(value) }),
                    modifier = Modifier
                        .padding(top = UrlPromptSpec.inputGap)
                        .fillMaxWidth()
                        .height(UrlPromptSpec.inputHeight)
                        .testTag(UrlPromptTags.INPUT)
                        .clip(RoundedCornerShape(UrlPromptSpec.inputRadius))
                        .background(colors.input.background)
                        .border(1.dp, colors.divider, RoundedCornerShape(UrlPromptSpec.inputRadius))
                        .focusRequester(focus),
                    decorationBox = { inner ->
                        Box(
                            modifier = Modifier.padding(horizontal = UrlPromptSpec.inputPaddingHorizontal),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            if (value.isEmpty()) Text(placeholder, style = inputStyle.copy(color = colors.input.placeholder))
                            inner()
                        }
                    },
                )
            }
            Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(colors.divider))
            Row(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                PromptButton(cancelText, UrlPromptSpec.cancel, Modifier.weight(1f).testTag(UrlPromptTags.CANCEL)) { onResult(null) }
                Box(modifier = Modifier.width(1.dp).fillMaxHeight().background(colors.divider))
                PromptButton(confirmText, UrlPromptSpec.confirm, Modifier.weight(1f).testTag(UrlPromptTags.CONFIRM)) { onResult(value) }
            }
        }
    }
}

@Composable
private fun PromptButton(text: String, style: TextStyle, modifier: Modifier, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier = modifier
            .background(if (pressed) colors.divider else Color.Transparent)
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
            .padding(vertical = UrlPromptSpec.buttonPaddingVertical),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = text, style = style, color = colors.textLink)
    }
}
