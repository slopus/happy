package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Surface
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.slopus.happy.R

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

/**
 * A text prompt as Android asks for one: a Material 3 dialog with the
 * title, the message, an outlined text field and the actions bottom right
 * (Cancel, then the confirm action). Not happy-app's iOS-style card. The
 * scrim does not close it, so a half-typed link isn't lost; Back cancels.
 * The field takes focus once shown; the keyboard's Done confirms.
 */
@Composable
fun PromptModal(prompt: Prompt, onDismiss: () -> Unit) {
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
    // Laid out as Material 3's AlertDialog (28 corners, 24 padding, headline, body, actions
    // bottom right) on a plain Dialog: AlertDialog with a text field never settles under test.
    Dialog(onDismissRequest = cancel, properties = DialogProperties(dismissOnClickOutside = false, usePlatformDefaultWidth = false)) {
        Surface(
            shape = MaterialTheme.shapes.extraLarge,
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            tonalElevation = 6.dp,
            modifier = Modifier.padding(horizontal = 24.dp).widthIn(min = 280.dp, max = 560.dp).testTag(PromptTags.CONTAINER),
        ) {
            Column(Modifier.padding(24.dp)) {
                Text(
                    prompt.title,
                    style = MaterialTheme.typography.headlineSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(bottom = 16.dp).testTag(PromptTags.TITLE),
                )
                prompt.message?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 16.dp).testTag(PromptTags.MESSAGE),
                    )
                }
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    singleLine = true,
                    placeholder = prompt.placeholder?.let { { Text(it, maxLines = 1) } },
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
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag(PromptTags.INPUT),
                )
                Row(Modifier.fillMaxWidth().padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    TextButton(onClick = cancel, modifier = Modifier.testTag(PromptTags.CANCEL)) {
                        Text(prompt.cancelText ?: stringResource(R.string.common_cancel))
                    }
                    TextButton(onClick = confirm, modifier = Modifier.testTag(PromptTags.CONFIRM)) {
                        Text(prompt.confirmText ?: stringResource(R.string.common_ok))
                    }
                }
            }
        }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
}
