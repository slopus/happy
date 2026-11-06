package com.slopus.happy.ui.connection

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.avatar.PlaceholderAvatar
import com.slopus.happy.ui.components.rememberThumbHash
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudName
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Item
import com.slopus.happy.ui.components.ItemGroup
import com.slopus.happy.ui.components.ItemList
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

object CloudTags {
    const val SIGN_IN = "cloud.signIn"
    const val RETRY = "cloud.retry"
    const val CREATE = "cloud.create"
    const val JOIN = "cloud.join"
    const val NAME = "cloud.name"
    const val CODE = "cloud.code"
    const val SUBMIT = "cloud.submit"
    fun server(name: String) = "cloud.server.$name"
}

/**
 * Happy Cloud: until the account is signed in, the sign-in in the browser
 * as [ServerSignInScreen] draws a team server's (waiting with Open browser
 * again, finishing, or why it failed); then the account's servers ("Your
 * servers": each one's picture, display name, host and the person's role,
 * the ones already on the phone checked), and "Create a new server" and
 * "Join a server".
 */
@Composable
fun CloudScreen(
    state: CloudAccountState,
    servers: List<CloudServer>?,
    failure: CloudException.Reason?,
    here: Set<String>,
    /** A server picture's bytes, fetched with the account token. */
    image: suspend (String) -> ByteArray?,
    onOpenBrowser: () -> Unit,
    onRetrySignIn: () -> Unit,
    onReload: () -> Unit,
    onPick: (CloudServer) -> Unit,
    onCreate: () -> Unit,
    onJoin: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    val icon = 29.dp
    val avatar = 32.dp
    Screen(header = { StackHeader(stringResource(R.string.cloud_title), onBack) }) {
        if (state != CloudAccountState.SignedIn) {
            CloudColumn {
                when (state) {
                    CloudAccountState.SignedOut -> {
                        Line(stringResource(R.string.cloud_title), CloudText.title)
                        Line(stringResource(R.string.cloud_connect_message), CloudText.body, secondary = true)
                        Spacer(Modifier.height(8.dp))
                        RoundButton(stringResource(R.string.cloud_sign_in), onOpenBrowser, Modifier.testTag(CloudTags.SIGN_IN))
                    }
                    CloudAccountState.InBrowser -> {
                        Spinner()
                        Line(stringResource(R.string.team_server_waiting), CloudText.body)
                        Spacer(Modifier.height(8.dp))
                        RoundButton(stringResource(R.string.team_server_reopen), onOpenBrowser, Modifier.testTag(CloudTags.SIGN_IN), display = RoundButtonDisplay.Inverted)
                    }
                    CloudAccountState.Finishing -> {
                        Spinner()
                        Line(stringResource(R.string.team_server_finishing), CloudText.body)
                    }
                    is CloudAccountState.Failed -> {
                        Line(stringResource(R.string.team_server_failed), CloudText.title)
                        Line(stringResource(failureText(state.reason)), CloudText.body, secondary = true)
                        Spacer(Modifier.height(8.dp))
                        RoundButton(stringResource(R.string.team_server_try_again), onRetrySignIn, Modifier.testTag(CloudTags.RETRY))
                    }
                    CloudAccountState.SignedIn -> Unit
                }
            }
            return@Screen
        }
        ItemList {
            ItemGroup(title = stringResource(R.string.cloud_your_servers)) {
                when {
                    failure != null -> Item(
                        title = stringResource(cloudFailureText(failure)),
                        subtitle = stringResource(R.string.team_server_try_again),
                        icon = { Icon(Ionicon.AlertCircleOutline, icon, colors.textDestructive) },
                        onClick = onReload,
                        showChevron = false,
                    )
                    servers == null -> Item(title = stringResource(R.string.cloud_loading), loading = true, showChevron = false)
                    servers.isEmpty() -> Item(title = stringResource(R.string.cloud_no_servers), showChevron = false)
                    else -> servers.forEach { server ->
                        Item(
                            title = server.title,
                            subtitle = host(server.origin ?: server.url),
                            detail = stringResource(if (server.owner) R.string.cloud_role_owner else R.string.cloud_role_member),
                            icon = { ServerAvatar(server, image, avatar) },
                            rightElement = if (server.origin in here) ({ Icon(Ionicon.CheckmarkCircle, 20.dp, colors.success) }) else null,
                            onClick = { onPick(server) },
                            modifier = Modifier.testTag(CloudTags.server(server.name)),
                        )
                    }
                }
            }
            ItemGroup {
                Item(
                    title = stringResource(R.string.cloud_create),
                    icon = { Icon(Ionicon.AddOutline, icon, colors.text) },
                    onClick = onCreate,
                    modifier = Modifier.testTag(CloudTags.CREATE),
                )
                Item(
                    title = stringResource(R.string.cloud_join),
                    icon = { Icon(Ionicon.PersonAddOutline, icon, colors.text) },
                    onClick = onJoin,
                    modifier = Modifier.testTag(CloudTags.JOIN),
                )
            }
        }
    }
}

/**
 * Creating a server: its name, typed with the `.BASE` it will live under
 * beside it, said to be free or not as the person pauses, then Create.
 */
@Composable
fun CloudCreateScreen(
    name: String,
    base: String,
    availability: CloudName?,
    busy: Boolean,
    failure: CloudException.Reason?,
    onName: (String) -> Unit,
    onCreate: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    Screen(header = { StackHeader(stringResource(R.string.cloud_create), onBack) }, avoidKeyboard = true) {
        CloudColumn {
            Line(stringResource(R.string.cloud_create_detail), CloudText.body, secondary = true)
            NameField(name, base, busy, onName, ImeAction.Done)
            val (note, color) = when {
                failure != null && failure != CloudException.Reason.Taken -> stringResource(cloudFailureText(failure)) to colors.textDestructive
                name.length < 3 -> stringResource(R.string.cloud_name_rules) to colors.textSecondary
                availability == null -> stringResource(R.string.cloud_name_checking) to colors.textSecondary
                availability == CloudName.Available -> stringResource(R.string.cloud_name_available, "$name.$base") to colors.success
                availability == CloudName.Taken -> stringResource(R.string.cloud_name_taken) to colors.textDestructive
                availability == CloudName.Reserved -> stringResource(R.string.cloud_name_reserved) to colors.textDestructive
                else -> stringResource(R.string.cloud_name_rules) to colors.textDestructive
            }
            Line(note, CloudText.note, color = color)
            Spacer(Modifier.height(8.dp))
            RoundButton(
                stringResource(R.string.cloud_create_button),
                onCreate,
                Modifier.testTag(CloudTags.SUBMIT),
                enabled = availability == CloudName.Available && !busy,
                loading = busy,
            )
        }
    }
}

/** Joining a server: its name and the invite code its owner gave, then Join. */
@Composable
fun CloudJoinScreen(
    name: String,
    code: String,
    base: String,
    busy: Boolean,
    failure: CloudException.Reason?,
    onName: (String) -> Unit,
    onCode: (String) -> Unit,
    onJoin: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    Screen(header = { StackHeader(stringResource(R.string.cloud_join), onBack) }, avoidKeyboard = true) {
        CloudColumn {
            Line(stringResource(R.string.cloud_join_detail), CloudText.body, secondary = true)
            NameField(name, base, busy, onName, ImeAction.Next)
            HappyTextField(
                value = code,
                onValueChange = onCode,
                placeholder = stringResource(R.string.cloud_invite_code),
                textStyle = CloudText.field,
                contentPadding = ServerSignInSpec.fieldPadding,
                minHeight = ServerSignInSpec.fieldMinHeight,
                cornerRadius = ServerSignInSpec.fieldRadius,
                singleLine = true,
                enabled = !busy,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
                modifier = Modifier.testTag(CloudTags.CODE),
            )
            if (failure != null) Line(stringResource(cloudFailureText(failure)), CloudText.note, color = colors.textDestructive)
            Spacer(Modifier.height(8.dp))
            RoundButton(
                stringResource(R.string.cloud_join_button),
                onJoin,
                Modifier.testTag(CloudTags.SUBMIT),
                enabled = name.length >= 3 && code.isNotEmpty() && !busy,
                loading = busy,
            )
        }
    }
}

/**
 * A server's picture: its ThumbHash at once, the bytes dissolving in over it
 * once fetched. Without a picture, the generated avatar its connection will
 * have (seeded by its host, as [com.slopus.happy.connection.AgentConnections.placeholderSeed]).
 */
@Composable
private fun ServerAvatar(server: CloudServer, image: suspend (String) -> ByteArray?, size: Dp) {
    val picture = server.image
    if (picture == null) {
        PlaceholderAvatar("agent:${host(server.origin ?: server.url)}", size, animated = false)
        return
    }
    val bytes by produceState<ByteArray?>(null, picture.url) { value = image(picture.url) }
    val placeholder = rememberThumbHash(picture.thumbhash)
    Box(Modifier.size(size).clip(CircleShape).background(HappyTheme.colors.surfaceHigh)) {
        when {
            bytes != null -> RemoteImage(bytes, null, Modifier.matchParentSize(), cacheKey = picture.url, placeholder = placeholder)
            placeholder != null -> Image(placeholder, null, Modifier.matchParentSize(), contentScale = ContentScale.Crop)
        }
    }
}

/** A server name field with `.BASE` after it, as the server's host will read. */
@Composable
private fun NameField(name: String, base: String, busy: Boolean, onName: (String) -> Unit, ime: ImeAction) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        HappyTextField(
            value = name,
            onValueChange = onName,
            placeholder = stringResource(R.string.cloud_name_placeholder),
            textStyle = CloudText.field,
            contentPadding = ServerSignInSpec.fieldPadding,
            minHeight = ServerSignInSpec.fieldMinHeight,
            cornerRadius = ServerSignInSpec.fieldRadius,
            singleLine = true,
            enabled = !busy,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ime),
            modifier = Modifier.weight(1f).testTag(CloudTags.NAME),
        )
        Text(".$base", style = CloudText.field, color = HappyTheme.colors.textSecondary, maxLines = 1, modifier = Modifier.padding(start = 8.dp).weight(1f, fill = false))
    }
}

/** [ServerSignInScreen]'s column: centred, 24 in from the sides, 16 between parts. */
@Composable
private fun CloudColumn(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(top = barInsetTop())
            .padding(horizontal = ServerSignInSpec.sideInset, vertical = ServerSignInSpec.topInset),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(ServerSignInSpec.gap),
    ) { content() }
}

private object CloudText {
    val title @Composable get() = happyTextStyle(fontSize = 20, lineHeight = 28, weight = FontWeight.SemiBold)
    val body @Composable get() = happyTextStyle(fontSize = 16, lineHeight = 24)
    val note @Composable get() = happyTextStyle(fontSize = 13, lineHeight = 18)
    val field @Composable get() = happyTextStyle(fontSize = 15, lineHeight = 20)
}

@Composable
private fun Line(text: String, style: TextStyle, secondary: Boolean = false, color: Color = Color.Unspecified) = Text(
    text,
    style = style,
    color = color.takeIf { it != Color.Unspecified } ?: if (secondary) HappyTheme.colors.textSecondary else HappyTheme.colors.text,
    textAlign = TextAlign.Center,
    modifier = Modifier.fillMaxWidth(),
)

@Composable
private fun Spinner() = CircularProgressIndicator(color = HappyTheme.colors.textSecondary, strokeWidth = 2.dp, modifier = Modifier.size(ServerSignInSpec.spinner))

private fun cloudFailureText(reason: CloudException.Reason): Int = when (reason) {
    CloudException.Reason.Taken -> R.string.cloud_name_taken
    CloudException.Reason.Invalid -> R.string.cloud_name_rules
    CloudException.Reason.NotFound -> R.string.cloud_join_not_found
    CloudException.Reason.SignInRequired -> R.string.team_server_error_sign_in_required
    CloudException.Reason.Unreachable -> R.string.team_server_error_unreachable
    CloudException.Reason.Failed -> R.string.cloud_failed
}
