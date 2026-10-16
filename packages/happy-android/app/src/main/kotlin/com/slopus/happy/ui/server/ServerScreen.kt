package com.slopus.happy.ui.server

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.auth.AuthApi.ServerProbe
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.launch

object ServerTags {
    const val FORM = "server.form"
    const val LABEL = "server.label"
    const val INPUT = "server.input"
    const val ERROR = "server.error"
    const val SAVE = "server.save"
    const val RESET = "server.reset"
    const val STATUS = "server.status"
}

/** server.tsx */
object ServerSpec {
    val paddingHorizontal = 16.dp
    val paddingVertical = 12.dp
    val labelGap = 8.dp
    val inputPaddingHorizontal = 14.dp
    val inputPaddingVertical = 12.dp
    val inputMinHeight = 44.dp
    val inputRadius = 10.dp
    val inputGap = 8.dp
    val messageGap = 12.dp
    val buttonGap = 4.dp
    val buttonsTop = 4.dp
    val buttonsBottom = 12.dp
    val label = happyTextStyle(fontSize = 12, letterSpacing = 0.5f, weight = FontWeight.SemiBold)
    val input = happyTextStyle(fontSize = 15, family = PlexMono)
    val message = happyTextStyle(fontSize = 12)
}

/**
 * Server URL for self-hosters. Save validates the URL's form, then asks the
 * server for its banner, then confirms; Reset goes back to the default. The
 * voice-server section of happy-app is left out with voice.
 *
 * Spec: one footer-only group holding the form, 16/12 padding. Label 12
 * semibold uppercase (tracking 0.5) 8 above the input; input mono 15,
 * 14/12 padding, at least 44 high, radius 10, 8 below it; error or
 * "validating" line 12, 12 below; normal-size buttons 4 apart with 4 above
 * and 12 below; status line 12, centred.
 */
@Composable
fun ServerScreen(
    customUrl: String?,
    probe: suspend (String) -> ServerProbe,
    onSave: (String) -> Unit,
    onReset: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    val scope = rememberCoroutineScope()
    var input by rememberSaveable { mutableStateOf(customUrl.orEmpty()) }
    var error by remember { mutableStateOf<String?>(null) }
    var validating by remember { mutableStateOf(false) }
    var alert by remember { mutableStateOf<Alert?>(null) }

    val strings = ServerStrings(
        error = stringResource(R.string.common_error),
        ok = stringResource(R.string.common_ok),
        cancel = stringResource(R.string.common_cancel),
        continueLabel = stringResource(R.string.common_continue),
        reset = stringResource(R.string.common_reset),
        enterUrl = stringResource(R.string.server_enter_server_url),
        urlEmpty = stringResource(R.string.server_url_empty),
        urlProtocol = stringResource(R.string.server_url_protocol),
        urlInvalid = stringResource(R.string.server_url_invalid),
        serverError = stringResource(R.string.server_server_returned_error),
        notHappy = stringResource(R.string.server_not_valid_happy_server),
        unreachable = stringResource(R.string.server_failed_to_connect_to_server),
        changeServer = stringResource(R.string.server_change_server),
        continueWithServer = stringResource(R.string.server_continue_with_server),
        resetToDefault = stringResource(R.string.server_reset_to_default),
        resetServerDefault = stringResource(R.string.server_reset_server_default),
    )

    fun save() {
        val url = input
        if (url.isBlank()) {
            alert = Alert(strings.error, strings.enterUrl, listOf(AlertButton(strings.ok)))
            return
        }
        when (ServerConfig.validate(url)) {
            ServerConfig.Validation.Empty -> error = strings.urlEmpty
            ServerConfig.Validation.NotHttp -> error = strings.urlProtocol
            ServerConfig.Validation.Malformed -> error = strings.urlInvalid
            ServerConfig.Validation.Valid -> scope.launch {
                validating = true
                error = null
                val result = probe(url)
                validating = false
                error = when (result) {
                    ServerProbe.HappyServer -> null
                    ServerProbe.NotHappyServer -> strings.notHappy
                    ServerProbe.ServerError -> strings.serverError
                    ServerProbe.Unreachable -> strings.unreachable
                }
                if (result == ServerProbe.HappyServer) {
                    alert = Alert(
                        strings.changeServer,
                        strings.continueWithServer,
                        listOf(AlertButton(strings.cancel), AlertButton(strings.continueLabel, destructive = true) { onSave(url) }),
                        // Modal.confirm: only a button answers it.
                        cancelable = false,
                    )
                }
            }
        }
    }

    fun reset() {
        alert = Alert(
            strings.resetToDefault,
            strings.resetServerDefault,
            listOf(
                AlertButton(strings.cancel),
                AlertButton(strings.reset, destructive = true) {
                    onReset()
                    input = ""
                },
            ),
            cancelable = false,
        )
    }

    Screen(header = { StackHeader(stringResource(R.string.server_title), onBack, TitleAlignment.Center) }) {
        ItemList {
            ItemGroup(footer = stringResource(R.string.server_self_host_footer)) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = ServerSpec.paddingHorizontal, vertical = ServerSpec.paddingVertical)
                        .testTag(ServerTags.FORM),
                ) {
                    Text(
                        text = stringResource(R.string.server_server_url_label).uppercase(),
                        style = ServerSpec.label,
                        color = colors.textSecondary,
                        modifier = Modifier.padding(bottom = ServerSpec.labelGap).testTag(ServerTags.LABEL),
                    )
                    HappyTextField(
                        value = input,
                        onValueChange = {
                            input = it
                            error = null
                        },
                        placeholder = stringResource(R.string.common_url_placeholder),
                        textStyle = ServerSpec.input,
                        contentPadding = PaddingValues(
                            horizontal = ServerSpec.inputPaddingHorizontal,
                            vertical = ServerSpec.inputPaddingVertical,
                        ),
                        minHeight = ServerSpec.inputMinHeight,
                        cornerRadius = ServerSpec.inputRadius,
                        singleLine = true,
                        enabled = !validating,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                        modifier = Modifier
                            .padding(bottom = ServerSpec.inputGap)
                            .alpha(if (validating) 0.6f else 1f)
                            .testTag(ServerTags.INPUT),
                    )
                    error?.let {
                        Text(
                            text = it,
                            style = ServerSpec.message,
                            color = colors.textDestructive,
                            modifier = Modifier.padding(bottom = ServerSpec.messageGap).testTag(ServerTags.ERROR),
                        )
                    }
                    if (validating) {
                        Text(
                            text = stringResource(R.string.server_validating_server),
                            style = ServerSpec.message,
                            color = colors.status.connecting,
                            modifier = Modifier.padding(bottom = ServerSpec.messageGap),
                        )
                    }
                    Column(
                        modifier = Modifier.padding(top = ServerSpec.buttonsTop, bottom = ServerSpec.buttonsBottom),
                        verticalArrangement = Arrangement.spacedBy(ServerSpec.buttonGap),
                    ) {
                        RoundButton(
                            title = stringResource(if (validating) R.string.server_validating else R.string.common_save),
                            onClick = ::save,
                            size = RoundButtonSize.Normal,
                            enabled = !validating,
                            modifier = Modifier.testTag(ServerTags.SAVE),
                        )
                        if (customUrl != null) {
                            RoundButton(
                                title = strings.resetToDefault,
                                onClick = ::reset,
                                size = RoundButtonSize.Normal,
                                display = RoundButtonDisplay.Inverted,
                                modifier = Modifier.testTag(ServerTags.RESET),
                            )
                        }
                    }
                    if (customUrl != null) {
                        Text(
                            text = stringResource(R.string.server_currently_using_custom_server),
                            style = ServerSpec.message,
                            color = colors.textSecondary,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().testTag(ServerTags.STATUS),
                        )
                    }
                }
            }
        }
    }

    alert?.let { HappyAlert(alert = it, onDismiss = { alert = null }) }
}

private class ServerStrings(
    val error: String,
    val ok: String,
    val cancel: String,
    val continueLabel: String,
    val reset: String,
    val enterUrl: String,
    val urlEmpty: String,
    val urlProtocol: String,
    val urlInvalid: String,
    val serverError: String,
    val notHappy: String,
    val unreachable: String,
    val changeServer: String,
    val continueWithServer: String,
    val resetToDefault: String,
    val resetServerDefault: String,
)
