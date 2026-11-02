package com.slopus.happy.ui.connection

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.connection.ServerAuthException
import com.slopus.happy.connection.ServerSignInState
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator

object ServerSignInTags {
    const val NAME = "serverSignIn.name"
    const val CONTINUE = "serverSignIn.continue"
    const val BROWSER = "serverSignIn.browser"
    const val SPINNER = "serverSignIn.spinner"
    const val RETRY = "serverSignIn.retry"
}

/** Sizes of [ServerSignInScreen], as PairingScreen's. */
object ServerSignInSpec {
    val sideInset = 24.dp
    val topInset = 32.dp
    val gap = 16.dp
    val fieldPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp)
    val fieldMinHeight = 44.dp
    val fieldRadius = 10.dp
    val spinner = 24.dp
}

/**
 * Signing in to a team server (edge SSO), PairingScreen's layout: the
 * standard header, then one centred column 24 in from the sides, 16
 * between parts, by [state]: a spinner while the server a scanned code
 * named is asked; the server's sign-in name on a button with the host
 * the browser will show under it; waiting for the browser, with Open
 * browser again; a spinner while the code is exchanged; a new member's
 * name; or why it failed with Try again. Field 15, at least 44 high,
 * radius 10; title 20/28 semibold, body 16/24, notes 13/18.
 */
@Composable
fun ServerSignInScreen(
    state: ServerSignInState,
    onOpenBrowser: () -> Unit,
    onSubmitName: (String) -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    val title = happyTextStyle(fontSize = 20, lineHeight = 28, weight = FontWeight.SemiBold)
    val body = happyTextStyle(fontSize = 16, lineHeight = 24)
    val note = happyTextStyle(fontSize = 13, lineHeight = 18)
    val field = happyTextStyle(fontSize = 15, lineHeight = 20)
    Screen(header = { StackHeader(stringResource(R.string.team_server_title), onBack) }, avoidKeyboard = true) {
        Column(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .contentMaxWidth(LocalWindowLayout.current)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(top = barInsetTop())
                .padding(horizontal = ServerSignInSpec.sideInset, vertical = ServerSignInSpec.topInset),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(ServerSignInSpec.gap),
        ) {
            @Composable
            fun Line(text: String, style: TextStyle, secondary: Boolean = false, modifier: Modifier = Modifier) = Text(
                text,
                style = style,
                color = if (secondary) colors.textSecondary else colors.text,
                textAlign = TextAlign.Center,
                modifier = modifier.fillMaxWidth(),
            )

            @Composable
            fun Spinner() = CircularProgressIndicator(
                color = colors.textSecondary,
                strokeWidth = 2.dp,
                modifier = Modifier.size(ServerSignInSpec.spinner).testTag(ServerSignInTags.SPINNER),
            )

            @Composable
            fun Field(value: String, onChange: (String) -> Unit, placeholder: String, tag: String, enabled: Boolean = true, keyboard: KeyboardOptions) = HappyTextField(
                value = value,
                onValueChange = onChange,
                placeholder = placeholder,
                textStyle = field,
                contentPadding = ServerSignInSpec.fieldPadding,
                minHeight = ServerSignInSpec.fieldMinHeight,
                cornerRadius = ServerSignInSpec.fieldRadius,
                singleLine = true,
                enabled = enabled,
                keyboardOptions = keyboard,
                modifier = Modifier.testTag(tag),
            )

            when (state) {
                is ServerSignInState.Checking -> {
                    Spinner()
                    Line(stringResource(R.string.team_server_checking, host(state.server)), body)
                }
                is ServerSignInState.Ready -> {
                    Line(host(state.server), title)
                    Line(stringResource(R.string.team_server_browser_host, state.method.authorizationHost), body, secondary = true)
                    Spacer(Modifier.height(8.dp))
                    RoundButton(stringResource(R.string.team_server_continue_with, state.method.name), onOpenBrowser, Modifier.testTag(ServerSignInTags.BROWSER))
                }
                is ServerSignInState.InBrowser -> {
                    Spinner()
                    Line(stringResource(R.string.team_server_waiting), body)
                    Line(stringResource(R.string.team_server_browser_host, state.method.authorizationHost), note, secondary = true)
                    Spacer(Modifier.height(8.dp))
                    RoundButton(
                        stringResource(R.string.team_server_reopen),
                        onOpenBrowser,
                        Modifier.testTag(ServerSignInTags.BROWSER),
                        display = RoundButtonDisplay.Inverted,
                    )
                }
                is ServerSignInState.Finishing -> {
                    Spinner()
                    Line(stringResource(R.string.team_server_finishing), body)
                }
                is ServerSignInState.NeedsName -> {
                    var name by rememberSaveable { mutableStateOf("") }
                    Line(stringResource(R.string.team_server_name_title), title)
                    Line(stringResource(R.string.team_server_name_detail, host(state.server)), body, secondary = true)
                    Field(
                        name,
                        { name = it },
                        stringResource(R.string.team_server_name_placeholder),
                        ServerSignInTags.NAME,
                        enabled = !state.saving,
                        keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                    )
                    if (state.failed) Line(stringResource(R.string.team_server_name_failed), note, secondary = true)
                    Spacer(Modifier.height(8.dp))
                    RoundButton(
                        stringResource(R.string.common_continue),
                        { onSubmitName(name) },
                        Modifier.testTag(ServerSignInTags.CONTINUE),
                        enabled = name.isNotBlank() && !state.saving,
                        loading = state.saving,
                    )
                }
                is ServerSignInState.Done -> Spinner()
                is ServerSignInState.Failed -> {
                    Line(stringResource(R.string.team_server_failed), title)
                    Line(stringResource(failureText(state.reason)), body, secondary = true)
                    Spacer(Modifier.height(8.dp))
                    RoundButton(stringResource(R.string.team_server_try_again), onRetry, Modifier.testTag(ServerSignInTags.RETRY))
                }
            }
        }
    }
}

/** An origin as people read it: its host, and port when not 443. */
internal fun host(origin: String): String = origin.removePrefix("https://")

internal fun failureText(reason: ServerAuthException.Reason): Int = when (reason) {
    ServerAuthException.Reason.InvalidAddress -> R.string.team_server_error_invalid_address
    ServerAuthException.Reason.NoSignIn -> R.string.team_server_error_no_sign_in
    ServerAuthException.Reason.EdgeBlocked -> R.string.team_server_error_edge_blocked
    ServerAuthException.Reason.Unreachable -> R.string.team_server_error_unreachable
    ServerAuthException.Reason.Denied -> R.string.team_server_error_denied
    ServerAuthException.Reason.Expired -> R.string.team_server_error_expired
    ServerAuthException.Reason.InvalidToken -> R.string.team_server_error_invalid_token
    ServerAuthException.Reason.Rejected -> R.string.team_server_error_rejected
    ServerAuthException.Reason.SignInRequired -> R.string.team_server_error_sign_in_required
    ServerAuthException.Reason.WrongServer -> R.string.team_server_error_wrong_server
}
