package com.slopus.happy.ui.connection

import androidx.annotation.RawRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import com.slopus.happy.ui.start.StartControl
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.HappyDropdownMenu
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.text.input.PasswordVisualTransformation
import kotlinx.coroutines.launch
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudName
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.connection.PasswordSignIn
import com.slopus.happy.connection.ServerAuthException
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LocalBarOnGlass
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.SceneAnimation
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.avatar.PlaceholderAvatar
import com.slopus.happy.ui.components.rememberThumbHash
import com.slopus.happy.ui.onboarding.OnboardingContentSpec
import com.slopus.happy.ui.onboarding.cappedScale
import com.slopus.happy.ui.start.GrainGradient
import com.slopus.happy.ui.start.StartGallerySpec
import com.slopus.happy.ui.start.StartSpec
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator

object CloudTags {
    const val PRIMARY = "cloud.primary"
    const val SECONDARY = "cloud.secondary"
    const val NAME = "cloud.name"
    const val CODE = "cloud.code"
    const val MENU = "cloud.menu"
    const val MEMBERS = "cloud.members"
    const val LEAVE = "cloud.leave"
    const val LOGIN = "cloud.login"
    const val PASSWORD = "cloud.password"
    fun server(name: String) = "cloud.server.$name"
    fun member(accountId: String) = "cloud.member.$accountId"
}

/** Sizes of the Happy Cloud screens, on the first screen's gradient and type ([com.slopus.happy.ui.start.StartScreen]). */
object CloudSpec {
    val sidePadding = 24.dp
    val columnMaxWidth = 440.dp
    val art = 160.dp
    val artGap = 24.dp
    val gap = 16.dp
    val rowAvatar = 44.dp
    val rowRadius = 20.dp
    val rowPadding = 16.dp
    val rowGap = 10.dp
    val fieldRadius = 16.dp
    val fieldMinHeight = 56.dp
    val spinner = 28.dp
    /** Cards and fields: the theme's surface, a little see-through so the gradient reads behind them. */
    const val SURFACE_ALPHA = 0.92f
}

/**
 * Happy Cloud's frame: the first screen's Grain Gradient behind the
 * system bars, a clear bar with back, then one centred column: [art] (a
 * scene) over a large [title] (onboarding's 28/34) and its [body], then
 * [content], and at the bottom one [primary] action, as wide as its label
 * (at least 200), with an optional quiet [secondary] under it. It keeps
 * clear of the keyboard (the scene leaves while it is up) and scrolls when
 * it outgrows the window.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CloudFrame(
    title: String,
    onBack: () -> Unit,
    body: String? = null,
    @RawRes art: Int? = null,
    /** Every press on [art], with its time: the welcome counts them. */
    onArtPress: ((Long) -> Unit)? = null,
    primary: CloudAction? = null,
    secondary: CloudAction? = null,
    /** The bar's ⋮: what is done rarely, out of the way of the one action. */
    menu: List<CloudAction> = emptyList(),
    content: @Composable ColumnScope.() -> Unit = {},
) {
    val dark = HappyTheme.colors.dark
    val text = if (dark) StartSpec.darkText else StartSpec.lightText
    Box(Modifier.fillMaxSize()) {
        GrainGradient(palette = if (dark) StartSpec.darkPalette else StartSpec.lightPalette, modifier = Modifier.fillMaxSize())
        BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout).union(WindowInsets.ime))) {
            val viewport = maxHeight
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = viewport)
                    .padding(bottom = StartSpec.bottomPadding),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(StartSpec.controlsPadding + StartSpec.control + StartGallerySpec.margin))
                Spacer(Modifier.weight(1f))
                Column(
                    Modifier.padding(horizontal = CloudSpec.sidePadding).widthIn(max = CloudSpec.columnMaxWidth).fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(CloudSpec.gap),
                ) {
                    // The keyboard up: the scene gives its room to the field and the action, which must stay in view.
                    if (art != null && !WindowInsets.isImeVisible) {
                        var plays by rememberSaveable { mutableIntStateOf(1) }
                        SceneAnimation(
                            art,
                            plays,
                            { plays = it + 1 },
                            // Watched before the replay's own click sees it, and never consumed: the scene still replays, and nothing new is announced.
                            modifier = if (onArtPress == null) Modifier else Modifier.pointerInput(onArtPress) {
                                awaitEachGesture { onArtPress(awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial).uptimeMillis) }
                            },
                            size = CloudSpec.art,
                        )
                        Spacer(Modifier.height(CloudSpec.artGap - CloudSpec.gap))
                    }
                    Text(
                        title,
                        style = cappedScale(StartGallerySpec.title.copy(lineBreak = LineBreak.Heading), OnboardingContentSpec.TITLE_MAX_SCALE),
                        color = text,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().semantics { heading() },
                    )
                    if (body != null) {
                        Text(
                            body,
                            style = StartGallerySpec.body.copy(lineBreak = LineBreak.Paragraph),
                            color = text.copy(alpha = StartSpec.SECONDARY_ALPHA),
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    content()
                }
                Spacer(Modifier.weight(1f))
                Spacer(Modifier.height(StartGallerySpec.margin))
                if (primary != null) {
                    RoundButton(
                        title = primary.title,
                        onClick = primary.onClick,
                        enabled = primary.enabled,
                        loading = primary.loading,
                        modifier = Modifier.widthIn(min = StartSpec.connectMinWidth).width(IntrinsicSize.Max).testTag(CloudTags.PRIMARY),
                    )
                }
                if (secondary != null) {
                    Spacer(Modifier.height(8.dp))
                    RoundButton(
                        title = secondary.title,
                        onClick = secondary.onClick,
                        enabled = secondary.enabled,
                        display = RoundButtonDisplay.Inverted,
                        modifier = Modifier.widthIn(min = StartSpec.connectMinWidth).width(IntrinsicSize.Max).testTag(CloudTags.SECONDARY),
                    )
                }
            }
        }
        // Clear: the gradient shows through the bar, as on the first screen's next one.
        Box(Modifier.windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))) {
            CompositionLocalProvider(LocalBarOnGlass provides true) {
                StackHeader(title = "", onBack = onBack, fullWidth = true) {
                    if (menu.isNotEmpty()) {
                        Box {
                            var open by remember { mutableStateOf(false) }
                            StartControl(Ionicon.EllipsisVertical, stringResource(R.string.start_more), text, { open = true }, Modifier.testTag(CloudTags.MENU))
                            HappyDropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.widthIn(min = StartSpec.menuMinWidth)) {
                                menu.forEach { item ->
                                    HappyMenuItem(
                                        label = item.title,
                                        leading = { Icon(Ionicon.LogOutOutline, StartSpec.menuIcon, LocalContentColor.current) },
                                        onClick = {
                                            open = false
                                            item.onClick()
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** One of a screen's actions: the primary at the bottom, or the quiet one under it. */
private class CloudAction(val title: String, val onClick: () -> Unit, val enabled: Boolean = true, val loading: Boolean = false)

@Composable
private fun Spinner() {
    val dark = HappyTheme.colors.dark
    CircularProgressIndicator(color = if (dark) StartSpec.darkText else StartSpec.lightText, strokeWidth = 2.5.dp, modifier = Modifier.size(CloudSpec.spinner))
}

/**
 * Happy Cloud. Signed out: a welcome in place of a question (or, its hour
 * up, saying the account must sign in again), whose Connect opens the
 * account's sign-in in the browser; then waiting for the browser,
 * finishing, or why it failed. Signed in: the account's servers.
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
    /** A test account's sign-in, for the welcome's hidden form. */
    signInWithPassword: suspend (login: String, password: String) -> PasswordSignIn,
    onRetrySignIn: () -> Unit,
    onReload: () -> Unit,
    onPick: (CloudServer) -> Unit,
    onCreate: () -> Unit,
    onJoin: () -> Unit,
    onSignOut: () -> Unit,
    onBack: () -> Unit,
) {
    when (state) {
        is CloudAccountState.SignedOut -> CloudWelcome(state.expired, onOpenBrowser, signInWithPassword, onBack)
        CloudAccountState.InBrowser -> CloudFrame(
            title = stringResource(R.string.team_server_waiting),
            art = R.raw.state_sparkles,
            primary = CloudAction(stringResource(R.string.team_server_reopen), onOpenBrowser),
            onBack = onBack,
        )
        CloudAccountState.Finishing -> CloudFrame(title = stringResource(R.string.team_server_finishing), art = R.raw.state_sparkles, onBack = onBack) { Spinner() }
        is CloudAccountState.Failed -> CloudFrame(
            title = stringResource(R.string.team_server_failed),
            body = stringResource(failureText(state.reason)),
            primary = CloudAction(stringResource(R.string.team_server_try_again), onRetrySignIn),
            onBack = onBack,
        )
        CloudAccountState.SignedIn -> CloudFrame(
            title = stringResource(R.string.cloud_your_servers),
            body = when {
                failure != null -> stringResource(cloudFailureText(failure))
                servers?.isEmpty() == true -> stringResource(R.string.cloud_no_servers)
                else -> null
            },
            art = if (servers.isNullOrEmpty()) R.raw.state_robot else null,
            primary = if (failure != null) CloudAction(stringResource(R.string.team_server_try_again), onReload) else CloudAction(stringResource(R.string.cloud_create), onCreate),
            secondary = CloudAction(stringResource(R.string.cloud_join), onJoin),
            menu = listOf(CloudAction(stringResource(R.string.cloud_sign_out), onSignOut)),
            onBack = onBack,
        ) {
            when {
                failure != null -> Unit
                servers == null -> Spinner()
                else -> Column(verticalArrangement = Arrangement.spacedBy(CloudSpec.rowGap), modifier = Modifier.fillMaxWidth()) {
                    servers.forEach { ServerCard(it, it.origin in here, image) { onPick(it) } }
                }
            }
        }
    }
}

/**
 * Signed out: the welcome, whose Connect opens the account's sign-in in the
 * browser. Its sparkles pressed [UNLOCK_TAPS] times within [UNLOCK_MILLIS]
 * reveal a test account's sign-in, login and password, for people and
 * agents testing without Apple or GitHub. Until then nothing of it is
 * composed, so nothing hints at it. The password lives only in this
 * composition: not saved with the screen, and gone once it leaves.
 */
@Composable
private fun CloudWelcome(
    expired: Boolean,
    onOpenBrowser: () -> Unit,
    signInWithPassword: suspend (login: String, password: String) -> PasswordSignIn,
    onBack: () -> Unit,
) {
    var unlocked by remember { mutableStateOf(false) }
    val presses = remember { ArrayDeque<Long>() }
    val connect = CloudAction(stringResource(R.string.cloud_connect_confirm), onOpenBrowser)
    val body = stringResource(if (expired) R.string.cloud_session_expired else R.string.cloud_connect_message)
    if (!unlocked) {
        CloudFrame(
            title = stringResource(R.string.cloud_title),
            body = body,
            art = R.raw.state_sparkles,
            onArtPress = remember {
                { at: Long ->
                    presses.addLast(at)
                    if (presses.size > UNLOCK_TAPS) presses.removeFirst()
                    if (presses.size == UNLOCK_TAPS && at - presses.first() <= UNLOCK_MILLIS) unlocked = true
                }
            },
            primary = connect,
            onBack = onBack,
        )
        return
    }
    var login by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var outcome by remember { mutableStateOf<PasswordSignIn?>(null) }
    val scope = rememberCoroutineScope()
    CloudFrame(
        title = stringResource(R.string.cloud_title),
        body = stringResource(R.string.cloud_test_title),
        art = R.raw.state_sparkles,
        primary = CloudAction(
            stringResource(R.string.cloud_test_sign_in),
            {
                busy = true
                outcome = null
                scope.launch {
                    try {
                        outcome = signInWithPassword(login.trim(), password)
                    } finally {
                        busy = false
                    }
                }
            },
            enabled = login.isNotBlank() && password.isNotEmpty() && !busy,
            loading = busy,
        ),
        secondary = connect,
        onBack = onBack,
    ) {
        CloudField(login, { login = it; outcome = null }, stringResource(R.string.cloud_test_login), CloudTags.LOGIN, !busy, KeyboardType.Ascii, ImeAction.Next)
        CloudField(password, { password = it; outcome = null }, stringResource(R.string.cloud_test_password), CloudTags.PASSWORD, !busy, KeyboardType.Password, ImeAction.Done, PasswordVisualTransformation())
        when (val failed = outcome) {
            PasswordSignIn.Wrong -> NotePill(stringResource(R.string.cloud_test_wrong), HappyTheme.colors.textDestructive)
            is PasswordSignIn.Locked -> NotePill(stringResource(R.string.cloud_test_locked, failed.minutes), HappyTheme.colors.textDestructive)
            is PasswordSignIn.Failed -> NotePill(stringResource(cloudFailureText(failed.reason)), HappyTheme.colors.textDestructive)
            PasswordSignIn.SignedIn, null -> Unit
        }
    }
}

private const val UNLOCK_TAPS = 10
private const val UNLOCK_MILLIS = 4_000L

/** A server on the gradient: its picture, display name, `@name`, the person's role, and a check when it is on the phone already. */
@Composable
private fun ServerCard(server: CloudServer, onPhone: Boolean, image: suspend (String) -> ByteArray?, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(CloudSpec.rowRadius))
            .background(colors.surface.copy(alpha = CloudSpec.SURFACE_ALPHA))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(CloudSpec.rowPadding)
            .testTag(CloudTags.server(server.name)),
    ) {
        ServerAvatar(server, image, CloudSpec.rowAvatar)
        Column(Modifier.weight(1f)) {
            Text(server.title, style = happyTextStyle(fontSize = 18, lineHeight = 24, weight = FontWeight.SemiBold), color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("@${server.name}", style = happyTextStyle(fontSize = 15, lineHeight = 20), color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        // Roles are the server's since the roles cutover: an accounts service that still lists one shows it.
        val role = when (server.role) {
            null -> null
            "owner" -> R.string.cloud_role_owner
            "admin" -> R.string.cloud_role_admin
            "viewer" -> R.string.cloud_role_viewer
            else -> R.string.cloud_role_member
        }
        if (role != null) Text(stringResource(role), style = happyTextStyle(fontSize = 14, lineHeight = 18), color = colors.textSecondary)
        if (onPhone) Icon(Ionicon.CheckmarkCircle, 22.dp, colors.success)
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
        PlaceholderAvatar("agent:${server.origin?.removePrefix("https://") ?: server.url}", size, animated = false)
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

/**
 * Creating a server: its name, typed as `@name` like a username (its
 * domain isn't shown yet), said to be free or not as the person pauses,
 * then Create server.
 */
@Composable
fun CloudCreateScreen(
    name: String,
    availability: CloudName?,
    busy: Boolean,
    failure: CloudException.Reason?,
    onName: (String) -> Unit,
    onCreate: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    CloudFrame(
        title = stringResource(R.string.cloud_create),
        body = stringResource(R.string.cloud_create_detail),
        art = R.raw.state_wand,
        primary = CloudAction(stringResource(R.string.cloud_create_button), onCreate, enabled = availability == CloudName.Available && !busy, loading = busy),
        onBack = onBack,
    ) {
        CloudField(name, onName, "@" + stringResource(R.string.cloud_name_placeholder), CloudTags.NAME, !busy, KeyboardType.Uri, ImeAction.Done, AtPrefix)
        val handle = "@$name"
        val (note, color) = when {
            failure != null && failure != CloudException.Reason.Taken -> stringResource(cloudFailureText(failure)) to colors.textDestructive
            name.length < 3 -> stringResource(R.string.cloud_name_rules) to null
            availability == null -> stringResource(R.string.cloud_name_checking) to null
            availability == CloudName.Available -> stringResource(R.string.cloud_name_available, handle) to colors.success
            availability == CloudName.Taken -> stringResource(R.string.cloud_name_taken, handle) to colors.textDestructive
            availability == CloudName.Reserved -> stringResource(R.string.cloud_name_reserved, handle) to colors.textDestructive
            else -> stringResource(R.string.cloud_name_rules) to colors.textDestructive
        }
        NotePill(note, color)
    }
}

/** Joining a server: its `@name` and the invite code its owner gave, then Join. */
@Composable
fun CloudJoinScreen(
    name: String,
    code: String,
    busy: Boolean,
    failure: CloudException.Reason?,
    onName: (String) -> Unit,
    onCode: (String) -> Unit,
    onJoin: () -> Unit,
    onBack: () -> Unit,
) {
    CloudFrame(
        title = stringResource(R.string.cloud_join),
        body = stringResource(R.string.cloud_join_detail),
        art = R.raw.state_owl,
        primary = CloudAction(stringResource(R.string.cloud_join_button), onJoin, enabled = name.length >= 3 && code.isNotEmpty() && !busy, loading = busy),
        onBack = onBack,
    ) {
        CloudField(name, onName, "@" + stringResource(R.string.cloud_name_placeholder), CloudTags.NAME, !busy, KeyboardType.Uri, ImeAction.Next, AtPrefix)
        CloudField(code, onCode, stringResource(R.string.cloud_invite_code), CloudTags.CODE, !busy, KeyboardType.Ascii, ImeAction.Done)
        if (failure != null) NotePill(stringResource(cloudFailureText(failure)), HappyTheme.colors.textDestructive)
    }
}

/**
 * A Happy Cloud server's sign-in, in place of the plain team server screen:
 * "Connecting to @name…" while the server is found, the browser comes back
 * by itself and the code is exchanged; or why it failed, with Try again.
 * Should the browser stay open (closed by hand), it can be opened again.
 */
@Composable
fun CloudConnectingScreen(handle: String, failed: ServerAuthException.Reason?, inBrowser: Boolean, onOpenBrowser: () -> Unit, onRetry: () -> Unit, onBack: () -> Unit) {
    if (failed != null) {
        CloudFrame(
            title = stringResource(R.string.team_server_failed),
            body = stringResource(failureText(failed)),
            primary = CloudAction(stringResource(R.string.team_server_try_again), onRetry),
            onBack = onBack,
        )
        return
    }
    CloudFrame(
        title = stringResource(R.string.cloud_connecting, handle),
        art = R.raw.state_boba,
        secondary = if (inBrowser) CloudAction(stringResource(R.string.team_server_reopen), onOpenBrowser) else null,
        onBack = onBack,
    ) { Spinner() }
}

/**
 * A new member's name on a Happy Cloud server, on the gradient as the
 * screens before it (the team server sign-in's name step, restyled): the
 * server has no profile for them until it is named (`userId: null`), and
 * nothing is filled in for them.
 */
@Composable
fun CloudNameScreen(handle: String, saving: Boolean, failed: Boolean, onSubmit: (String) -> Unit, onBack: () -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    CloudFrame(
        title = stringResource(R.string.team_server_name_title),
        body = stringResource(R.string.team_server_name_detail, handle),
        art = R.raw.state_sparkles,
        primary = CloudAction(stringResource(R.string.common_continue), { onSubmit(name) }, enabled = name.isNotBlank() && !saving, loading = saving),
        onBack = onBack,
    ) {
        CloudField(
            name,
            { name = it },
            stringResource(R.string.team_server_name_placeholder),
            ServerSignInTags.NAME,
            !saving,
            KeyboardType.Text,
            ImeAction.Done,
            capitalization = KeyboardCapitalization.Words,
        )
        if (failed) NotePill(stringResource(R.string.team_server_name_failed), HappyTheme.colors.textDestructive)
    }
}

/** A large field on the gradient: the theme's surface, a little see-through, 18 type. */
@Composable
private fun CloudField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    tag: String,
    enabled: Boolean,
    keyboard: KeyboardType,
    ime: ImeAction,
    transformation: VisualTransformation = VisualTransformation.None,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.None,
) {
    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(CloudSpec.fieldRadius)).background(HappyTheme.colors.surface.copy(alpha = CloudSpec.SURFACE_ALPHA))) {
        HappyTextField(
            value = value,
            onValueChange = onChange,
            placeholder = placeholder,
            textStyle = happyTextStyle(fontSize = 18, lineHeight = 24),
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 16.dp),
            minHeight = CloudSpec.fieldMinHeight,
            cornerRadius = CloudSpec.fieldRadius,
            singleLine = true,
            enabled = enabled,
            keyboardOptions = KeyboardOptions(capitalization = capitalization, autoCorrectEnabled = false, keyboardType = keyboard, imeAction = ime),
            visualTransformation = transformation,
            modifier = Modifier.testTag(tag),
        )
    }
}

/** A note that reads on any part of the gradient: on the fields' surface, in [color] or the secondary text. */
@Composable
private fun NotePill(text: String, color: Color?) {
    val colors = HappyTheme.colors
    Box(Modifier.clip(RoundedCornerShape(50)).background(colors.surface.copy(alpha = CloudSpec.SURFACE_ALPHA)).padding(horizontal = 14.dp, vertical = 8.dp)) {
        Text(text, style = happyTextStyle(fontSize = 14, lineHeight = 18, weight = FontWeight.Medium), color = color ?: colors.textSecondary, textAlign = TextAlign.Center)
    }
}

/** `@` before what is typed; nothing while empty, so the placeholder shows alone. */
private object AtPrefix : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        if (text.isEmpty()) return TransformedText(text, OffsetMapping.Identity)
        return TransformedText(
            AnnotatedString("@") + text,
            object : OffsetMapping {
                override fun originalToTransformed(offset: Int) = offset + 1
                override fun transformedToOriginal(offset: Int) = (offset - 1).coerceIn(0, text.length)
            },
        )
    }
}

internal fun cloudFailureText(reason: CloudException.Reason): Int = when (reason) {
    // Create shows a taken name as its availability, with the name; join never hears it.
    CloudException.Reason.Taken -> R.string.cloud_failed
    CloudException.Reason.Invalid -> R.string.cloud_name_rules
    CloudException.Reason.NotFound -> R.string.cloud_join_not_found
    CloudException.Reason.SignInRequired -> R.string.team_server_error_sign_in_required
    CloudException.Reason.Unreachable -> R.string.team_server_error_unreachable
    CloudException.Reason.Failed -> R.string.cloud_failed
}
