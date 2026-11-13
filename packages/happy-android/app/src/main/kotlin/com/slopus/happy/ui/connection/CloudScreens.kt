package com.slopus.happy.ui.connection

import androidx.annotation.RawRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.defaultMinSize
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import com.slopus.happy.ui.components.MaterialSymbols
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
import androidx.compose.ui.draw.alpha
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.semantics.contentType
import kotlinx.coroutines.launch
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
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
import com.slopus.happy.connection.CloudProvider
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.connection.CloudInviteRefusal
import com.slopus.happy.connection.EmailSignIn
import com.slopus.happy.connection.PasswordSignIn
import com.slopus.happy.connection.ServerAuthException
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LocalBarOnGlass
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.components.SceneAnimation
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.avatar.PlaceholderAvatar
import com.slopus.happy.ui.components.rememberThumbHash
import com.slopus.happy.ui.onboarding.OnboardingContentSpec
import com.slopus.happy.ui.onboarding.cappedScale
import com.slopus.happy.ui.start.GrainGradient
import com.slopus.happy.ui.start.StartGallery
import com.slopus.happy.ui.start.StartSlide
import com.slopus.happy.ui.start.StartGallerySpec
import com.slopus.happy.ui.start.StartSpec
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import com.slopus.happy.ui.components.PageProgressIndicator as CircularProgressIndicator

object CloudTags {
    const val PRIMARY = "cloud.primary"
    const val SECONDARY = "cloud.secondary"
    const val NAME = "cloud.name"
    const val MENU = "cloud.menu"
    const val MEMBERS = "cloud.members"
    const val LEAVE = "cloud.leave"
    const val LOGIN = "cloud.login"
    const val PASSWORD = "cloud.password"
    const val SLIDES = "cloud.slides"
    const val CREATE = "cloud.create"
    const val TITLE = "cloud.title"
    const val INVITE_SERVER = "cloud.invite.server"
    const val INVITER = "cloud.invite.inviter"
    const val GOOGLE = "cloud.google"
    const val EMAIL = "cloud.email"
    const val EMAIL_CODE = "cloud.email.code"
    const val EMAIL_SIGN_IN = "cloud.email.signIn"
    const val CHANGE_EMAIL = "cloud.email.change"
    fun server(name: String) = "cloud.server.$name"
    fun join(name: String) = "cloud.join.$name"
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
    /** A row's Join, desktop's 104. */
    val joinWidth = 104.dp
    val fieldRadius = 16.dp
    val fieldMinHeight = 56.dp
    val spinner = 28.dp
    /** Over the welcome's button, its note. */
    val noteGap = 12.dp
    /** The welcome's slides hold longer than the first screen's: their lines run two or three (iOS's 12 s). */
    const val ADVANCE_MILLIS = 12_000L
    /** An invite's note: room for three lines in its pill, kept whether or not it says anything. */
    val inviteNote = 70.dp
    /** An invite's server picture, in the scene's place. */
    val inviteServerAvatar = 112.dp
    /** Who sent an invite, beside "<name> invited you". */
    val inviterAvatar = 28.dp
    /** One step's content giving way to the next's, in place. */
    const val SWAP_MILLIS = 150

    /** Cards and fields: the theme's surface, a little see-through so the gradient reads behind them. */
    const val SURFACE_ALPHA = 0.92f
}

/**
 * Happy Cloud's frame: the first screen's Grain Gradient behind the
 * system bars, a clear bar with back, then one centred column: [art] (a
 * scene) over a large [title] (onboarding's 28/34) and its [body], then
 * [content], and at the bottom one [primary] action, as wide as its label
 * (at least 280), with an optional quiet [secondary] under it. It keeps
 * clear of the keyboard (the scene leaves while it is up) and scrolls when
 * it outgrows the window.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CloudFrame(
    title: String,
    /** Null: no back (a step the person may not leave), and no bar. */
    onBack: (() -> Unit)?,
    body: String? = null,
    @RawRes art: Int? = null,
    /** Every press on [art], with its time: the welcome counts them. */
    onArtPress: ((Long) -> Unit)? = null,
    primary: CloudAction? = null,
    secondary: CloudAction? = null,
    /** The bar's ⋮: what is done rarely, out of the way of the one action. */
    menu: List<CloudAction> = emptyList(),
    /** Over the title in [art]'s place, and staying while the keyboard is up: a picture to choose. */
    top: (@Composable () -> Unit)? = null,
    columnMaxWidth: Dp = CloudSpec.columnMaxWidth,
    /** The lines [body] keeps room for, so a shorter one moves nothing. */
    bodyMinLines: Int = 1,
    /**
     * Buttons as wide as the column whatever they say, the secondary a
     * surface pill, and its room kept without one: a screen whose states
     * swap in place.
     */
    steadyButtons: Boolean = false,
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
                    Modifier.padding(horizontal = CloudSpec.sidePadding).widthIn(max = columnMaxWidth).fillMaxWidth(),
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
                    if (top != null) {
                        top()
                        Spacer(Modifier.height(CloudSpec.artGap - CloudSpec.gap))
                    }
                    Text(
                        title,
                        style = cappedScale(StartGallerySpec.title.copy(lineBreak = LineBreak.Heading), OnboardingContentSpec.TITLE_MAX_SCALE),
                        color = text,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().semantics { heading() }.testTag(CloudTags.TITLE),
                    )
                    if (body != null) {
                        Text(
                            body,
                            style = StartGallerySpec.body.copy(lineBreak = LineBreak.Paragraph),
                            color = text.copy(alpha = StartSpec.SECONDARY_ALPHA),
                            textAlign = TextAlign.Center,
                            minLines = bodyMinLines,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    content()
                }
                Spacer(Modifier.weight(1f))
                Spacer(Modifier.height(StartGallerySpec.margin))
                val buttonWidth = if (steadyButtons) {
                    Modifier.padding(horizontal = CloudSpec.sidePadding).widthIn(max = columnMaxWidth).fillMaxWidth()
                } else {
                    Modifier.widthIn(min = StartSpec.connectMinWidth).width(IntrinsicSize.Max)
                }
                if (primary != null) {
                    RoundButton(
                        title = primary.title,
                        onClick = primary.onClick,
                        enabled = primary.enabled,
                        loading = primary.loading,
                        modifier = buttonWidth.testTag(CloudTags.PRIMARY),
                    )
                }
                if (secondary != null || steadyButtons) {
                    Spacer(Modifier.height(8.dp))
                    RoundButton(
                        title = secondary?.title ?: "",
                        onClick = secondary?.onClick ?: {},
                        enabled = secondary?.enabled ?: false,
                        display = RoundButtonDisplay.Inverted,
                        // A pill of its own, as the cards are: never a bare line of text.
                        modifier = (if (secondary != null) buttonWidth.testTag(CloudTags.SECONDARY) else buttonWidth.alpha(0f).clearAndSetSemantics {})
                            .then(if (steadyButtons) Modifier.clip(RoundedCornerShape(percent = 50)).background(HappyTheme.colors.surface.copy(alpha = CloudSpec.SURFACE_ALPHA)) else Modifier),
                    )
                }
            }
        }
        // Clear: the gradient shows through the bar, as on the first screen's next one.
        if (onBack != null) Box(Modifier.windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))) {
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
internal class CloudAction(val title: String, val onClick: () -> Unit, val enabled: Boolean = true, val loading: Boolean = false)

@Composable
private fun Spinner() {
    val dark = HappyTheme.colors.dark
    CircularProgressIndicator(color = if (dark) StartSpec.darkText else StartSpec.lightText, strokeWidth = 2.5.dp, modifier = Modifier.size(CloudSpec.spinner))
}

/** Where joining one of the account's servers from its list stands: on its row's button. */
enum class CloudJoin { Joining, Joined }

/**
 * Happy Cloud introducing itself, as the first screen introduces Happy:
 * desktop's CLOUD_SLIDES (CloudConnectScreen.tsx), its art and its words.
 */
val CloudSlides = listOf(
    StartSlide(StartSlide.Art.Cloud, R.string.cloud_title, R.string.cloud_slide_cloud_body),
    StartSlide(StartSlide.Art.Scene(R.raw.state_robot), R.string.cloud_slide_scale_title, R.string.cloud_slide_scale_body),
    StartSlide(StartSlide.Art.Scene(R.raw.state_closed_lock), R.string.cloud_slide_permissions_title, R.string.cloud_slide_permissions_body),
    StartSlide(StartSlide.Art.Scene(R.raw.state_sparkles), R.string.cloud_slide_yours_title, R.string.cloud_slide_yours_body),
    StartSlide(StartSlide.Art.Scene(R.raw.state_open_hands), R.string.cloud_slide_source_title, R.string.cloud_slide_source_body),
)

/**
 * Happy Cloud, desktop's steps (CloudConnectScreen.tsx). Signed out, or
 * signing in: the welcome, with Sign in with GitHub in it ([CloudWelcome]).
 * Signed in: Join a
 * server, the account's servers each with Join (Joined once it is on the
 * phone), then Continue into the app once one is; Bootstrap a new one
 * under them. An invite is a link, accepted on the web, not a code typed
 * here. Back there signs the account out, so
 * Continue can sign in with another ([onSignOut]); not while a join runs.
 */
@Composable
fun CloudScreen(
    state: CloudAccountState,
    servers: List<CloudServer>?,
    failure: CloudException.Reason?,
    /** Servers on the phone already, by origin: Joined. */
    here: Set<String>,
    /** Servers joined from this list, or being joined, by id. */
    joins: Map<String, CloudJoin>,
    /** A server picture's bytes, fetched with the account token. */
    image: suspend (String) -> ByteArray?,
    /** Sign in with Apple or GitHub, in the app. */
    onOpenBrowser: (CloudProvider) -> Unit,
    /** Continue with Google: Google's own sheet, on the phone. */
    onSignInWithGoogle: () -> Unit,
    /** Continue with email: its address, then the code mailed to it ([CloudEmailScreen]). */
    onEmail: () -> Unit,
    /** A test account's sign-in, for the welcome's hidden form. */
    signInWithPassword: suspend (login: String, password: String) -> PasswordSignIn,
    onReload: () -> Unit,
    onJoinServer: (CloudServer) -> Unit,
    onContinue: () -> Unit,
    onCreate: () -> Unit,
    onSignOut: () -> Unit,
    onBack: () -> Unit,
) {
    when (state) {
        // Signed out, waiting for the Auth Tab, finishing, or why it failed: all the welcome, its one button saying which.
        is CloudAccountState.SignedOut, CloudAccountState.InBrowser, CloudAccountState.Finishing, is CloudAccountState.Failed ->
            CloudWelcome(state, onOpenBrowser, onSignInWithGoogle, onEmail, signInWithPassword, onBack)
        CloudAccountState.SignedIn -> {
            val joining = CloudJoin.Joining in joins.values
            fun joined(server: CloudServer) = joins[server.id] == CloudJoin.Joined || (joins[server.id] == null && server.origin in here)
            CloudFrame(
                title = stringResource(R.string.cloud_join),
                body = if (failure != null) stringResource(cloudFailureText(failure)) else stringResource(R.string.cloud_servers_detail),
                primary = when {
                    failure != null -> CloudAction(stringResource(R.string.team_server_try_again), onReload)
                    servers?.any(::joined) == true -> CloudAction(stringResource(R.string.common_continue), onContinue, enabled = !joining)
                    else -> null
                },
                menu = listOf(CloudAction(stringResource(R.string.cloud_sign_out), onSignOut)),
                // Back leaves the account, as desktop's does: the welcome's Continue can then use another.
                onBack = { if (!joining) onSignOut() },
            ) {
                when {
                    failure != null -> Unit
                    servers == null -> Spinner()
                    else -> Column(verticalArrangement = Arrangement.spacedBy(CloudSpec.rowGap), modifier = Modifier.fillMaxWidth()) {
                        servers.forEach { server ->
                            ServerCard(
                                server,
                                join = if (joined(server)) CloudJoin.Joined else joins[server.id],
                                // One sign-in at a time on the phone: the others wait for it.
                                enabled = !joining,
                                image = image,
                                onJoin = { onJoinServer(server) },
                            )
                        }
                    }
                }
                if (failure == null && servers != null) {
                    CloudLink(CloudAction(stringResource(R.string.cloud_bootstrap_new), onCreate, enabled = !joining), CloudTags.CREATE)
                }
            }
        }
    }
}

/**
 * Signed out: the welcome, desktop's, with the sign-in in it (Steve): Happy
 * Cloud's slides ([CloudSlides]) as the first screen's [StartGallery] on its
 * gradient, desktop's scenes drifting down the sides ([CloudDrift]), and at
 * the bottom Sign in with Apple in Start's place and Sign in with GitHub
 * under it in Use Happy Cloud's, as iOS, with Continue with Google 12 over
 * them ([GoogleButton]). Apple and GitHub open that provider's sign-in in
 * the app (Apple has no native sign-in on Android); Google's is its own
 * sheet on the phone. Under them, the quiet Continue with email, which
 * signs in with a code mailed to the person and no browser
 * ([CloudEmailScreen]). Over them, a note: the hour up, or why the last
 * sign-in failed. While the sheet is up or the code is exchanged the one
 * pressed spins.
 *
 * The slides' art pressed [UNLOCK_TAPS] times within [UNLOCK_MILLIS]
 * reveals a test account's sign-in, login and password, for people and
 * agents testing without GitHub. Until then nothing of it is composed, so
 * nothing hints at it. The password lives only in this composition: not
 * saved with the screen, and gone once it leaves.
 */
@Composable
private fun CloudWelcome(
    state: CloudAccountState,
    onSignIn: (CloudProvider) -> Unit,
    onSignInWithGoogle: () -> Unit,
    onEmail: () -> Unit,
    signInWithPassword: suspend (login: String, password: String) -> PasswordSignIn,
    onBack: () -> Unit,
) {
    var unlocked by remember { mutableStateOf(false) }
    val presses = remember { ArrayDeque<Long>() }
    // Which one was pressed, so the spinner is on it; kept while the browser is up, through a fold or unfold.
    var pressed by rememberSaveable { mutableStateOf(CloudProvider.Apple) }
    fun action(provider: CloudProvider, title: String) = CloudAction(
        title,
        { pressed = provider; onSignIn(provider) },
        enabled = state != CloudAccountState.Finishing,
        loading = state == CloudAccountState.Finishing && pressed == provider,
    )
    val apple = action(CloudProvider.Apple, stringResource(R.string.cloud_sign_in_apple))
    val github = action(CloudProvider.GitHub, stringResource(R.string.cloud_sign_in_github))
    val google = CloudAction(
        stringResource(R.string.cloud_sign_in_google),
        { pressed = CloudProvider.Google; onSignInWithGoogle() },
        enabled = state != CloudAccountState.Finishing,
        loading = state == CloudAccountState.Finishing && pressed == CloudProvider.Google,
    )
    val email = CloudAction(stringResource(R.string.cloud_sign_in_email), onEmail, enabled = state != CloudAccountState.Finishing)
    if (!unlocked) {
        val colors = HappyTheme.colors
        val note = when (state) {
            is CloudAccountState.SignedOut -> if (state.expired) stringResource(R.string.cloud_session_expired) to null else null
            is CloudAccountState.Failed -> stringResource(failureText(state.reason)) to colors.textDestructive
            else -> null
        }
        CloudDeck(
            note = note,
            google = google,
            primary = apple,
            secondary = github,
            quiet = email,
            onArtPress = remember {
                { at: Long ->
                    presses.addLast(at)
                    if (presses.size > UNLOCK_TAPS) presses.removeFirst()
                    if (presses.size == UNLOCK_TAPS && at - presses.first() <= UNLOCK_MILLIS) unlocked = true
                }
            },
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
        art = R.raw.state_closed_lock,
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
        secondary = github,
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

/**
 * The welcome's frame, the first screen's with back: the gradient, the
 * drift, the clear bar, [CloudSlides] centred between the bar's row and the
 * buttons (16 kept above and below, moving on every 12 s), then [note] if
 * any, 12 over [google] if any, 12 over [primary] where Start is, and [secondary] where Use Happy
 * Cloud is: 12 under it, 24 above the bottom inset, both as wide as the
 * wider (at least 280), [primary] rising to make room. [quiet], a text
 * action in the gradient's text colour, goes right under [secondary] and
 * takes its 24 above the bottom, the two buttons rising. It scrolls when it
 * outgrows the window. The drift keeps clear of the slides and of the
 * note and buttons.
 */
@Composable
private fun CloudDeck(note: Pair<String, Color?>?, google: CloudAction?, primary: CloudAction, secondary: CloudAction?, quiet: CloudAction?, onArtPress: (Long) -> Unit, onBack: () -> Unit) {
    val dark = HappyTheme.colors.dark
    val text = if (dark) StartSpec.darkText else StartSpec.lightText
    var root by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var slides by remember { mutableStateOf<Rect?>(null) }
    var actions by remember { mutableStateOf<Rect?>(null) }
    fun Modifier.keptClear(set: (Rect) -> Unit) = onGloballyPositioned { child -> root?.takeIf { it.isAttached }?.let { set(it.localBoundingBoxOf(child)) } }
    Box(Modifier.fillMaxSize().onGloballyPositioned { root = it }) {
        GrainGradient(palette = if (dark) StartSpec.darkPalette else StartSpec.lightPalette, modifier = Modifier.fillMaxSize())
        CloudDrift(keepClear = listOfNotNull(slides, actions).takeIf { it.size == 2 })
        BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))) {
            val viewport = maxHeight
            val art = StartGallerySpec.artFor(maxWidth, maxHeight)
            val compact = maxHeight < StartGallerySpec.compactHeight
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = viewport),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(StartSpec.controlsPadding + StartSpec.control + StartGallerySpec.margin))
                Spacer(Modifier.weight(1f))
                StartGallery(
                    textColor = text,
                    secondaryColor = text.copy(alpha = StartSpec.SECONDARY_ALPHA),
                    dotColor = if (dark) StartSpec.darkDot else StartSpec.lightDot,
                    art = art,
                    compact = compact,
                    slides = CloudSlides,
                    onArtPress = onArtPress,
                    advanceMillis = CloudSpec.ADVANCE_MILLIS,
                    modifier = Modifier.testTag(CloudTags.SLIDES).keptClear { slides = it },
                )
                Spacer(Modifier.weight(1f))
                Spacer(Modifier.height(StartGallerySpec.margin))
                // The whole row, not the button alone: nothing drifts beside it.
                Column(Modifier.fillMaxWidth().keptClear { actions = it }, horizontalAlignment = Alignment.CenterHorizontally) {
                    if (note != null) {
                        Box(Modifier.padding(horizontal = CloudSpec.sidePadding).widthIn(max = CloudSpec.columnMaxWidth)) { NotePill(note.first, note.second) }
                        Spacer(Modifier.height(CloudSpec.noteGap))
                    }
                    // Start and Use Happy Cloud's places, as wide as the wider; both filled, as iOS: two ways in, neither the lesser.
                    Column(Modifier.widthIn(min = StartSpec.connectMinWidth).width(IntrinsicSize.Max)) {
                        if (google != null) {
                            GoogleButton(google, Modifier.testTag(CloudTags.GOOGLE))
                            Spacer(Modifier.height(StartSpec.cloudGap))
                        }
                        RoundButton(
                            title = primary.title,
                            onClick = primary.onClick,
                            enabled = primary.enabled,
                            loading = primary.loading,
                            modifier = Modifier.testTag(CloudTags.PRIMARY),
                        )
                        Box(Modifier.fillMaxWidth().heightIn(min = StartSpec.bottomPadding), contentAlignment = Alignment.TopCenter) {
                            if (secondary != null) {
                                RoundButton(
                                    title = secondary.title,
                                    onClick = secondary.onClick,
                                    enabled = secondary.enabled,
                                    loading = secondary.loading,
                                    modifier = Modifier
                                        .padding(top = StartSpec.cloudGap, bottom = if (quiet == null) StartSpec.cloudBottomPadding else 0.dp)
                                        .testTag(CloudTags.SECONDARY),
                                )
                            }
                        }
                        if (quiet != null) {
                            RoundButton(
                                title = quiet.title,
                                onClick = quiet.onClick,
                                enabled = quiet.enabled,
                                display = RoundButtonDisplay.Inverted,
                                contentColor = text,
                                modifier = Modifier.fillMaxWidth().padding(bottom = StartSpec.cloudBottomPadding).testTag(CloudTags.EMAIL_SIGN_IN),
                            )
                        }
                    }
                }
            }
        }
        Box(Modifier.windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))) {
            CompositionLocalProvider(LocalBarOnGlass provides true) {
                StackHeader(title = "", onBack = onBack, fullWidth = true)
            }
        }
    }
}
/**
 * Continue with Google, as Google's branding guidelines draw it
 * (developers.google.com/identity/branding-guidelines): the full-colour G,
 * 20, 10 before "Continue with Google" in medium weight, both centred; a
 * pill as tall as [RoundButton]'s Large (50) with its sides' 24. In the dark
 * theme Google's neutral button (#F2F2F2, #1F1F1F text, no stroke), a light
 * pill like the others there; in the light theme Google's light one (white,
 * a 1 #747775 stroke, #1F1F1F text). Disabled is 50%; while loading a
 * spinner stands over the hidden content, as RoundButton's.
 */
@Composable
private fun GoogleButton(action: CloudAction, modifier: Modifier = Modifier) {
    val dark = HappyTheme.colors.dark
    val shape = RoundedCornerShape(percent = 50)
    val size = RoundButtonSize.Large
    val text = Color(0xFF1F1F1F)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .alpha(if (action.enabled) 1f else 0.5f)
            .defaultMinSize(minWidth = 64.dp, minHeight = size.height)
            .clip(shape)
            .background(if (dark) Color(0xFFF2F2F2) else Color.White)
            .then(if (dark) Modifier else Modifier.border(1.dp, Color(0xFF747775), shape))
            .clickable(enabled = action.enabled && !action.loading, role = Role.Button, onClick = action.onClick)
            .padding(horizontal = size.paddingHorizontal),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.alpha(if (action.loading) 0f else 1f),
        ) {
            Image(painterResource(R.drawable.google_g), contentDescription = null, modifier = Modifier.size(20.dp))
            Text(
                action.title,
                style = happyTextStyle(fontSize = size.fontSize, lineHeight = size.lineHeight, weight = FontWeight.Medium),
                color = text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (action.loading) CircularProgressIndicator(modifier = Modifier.size(20.dp), color = text, strokeWidth = 2.dp)
    }
}

/** A quiet action in a screen's column: a surface pill, as the cards and the secondary buttons are, never bare text. */
@Composable
private fun CloudLink(action: CloudAction, tag: String) {
    val dark = HappyTheme.colors.dark
    RoundButton(
        title = action.title,
        onClick = action.onClick,
        enabled = action.enabled,
        display = RoundButtonDisplay.Inverted,
        contentColor = if (dark) StartSpec.darkText else StartSpec.lightText,
        modifier = Modifier
            .widthIn(min = StartSpec.connectMinWidth)
            .width(IntrinsicSize.Max)
            .clip(RoundedCornerShape(percent = 50))
            .background(HappyTheme.colors.surface.copy(alpha = CloudSpec.SURFACE_ALPHA))
            .testTag(tag),
    )
}

/**
 * A server on the gradient, desktop's row: its picture, display name and
 * `@name`, the person's role where the accounts service still lists one,
 * then Join: a spinner while it joins, and Joined with a check once it is
 * on the phone. Without [onJoin], the server alone (an invite's).
 */
@Composable
private fun ServerCard(server: CloudServer, join: CloudJoin?, enabled: Boolean, image: suspend (String) -> ByteArray?, onJoin: (() -> Unit)?, roleName: String? = null) {
    val colors = HappyTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .testTag(CloudTags.server(server.name))
            .clip(RoundedCornerShape(CloudSpec.rowRadius))
            .background(colors.surface.copy(alpha = CloudSpec.SURFACE_ALPHA))
            .padding(CloudSpec.rowPadding),
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
        val roleText = roleName ?: role?.let { stringResource(it) }
        if (roleText != null) Text(roleText, style = happyTextStyle(fontSize = 14, lineHeight = 18), color = colors.textSecondary)
        if (join == CloudJoin.Joined) {
            Row(
                Modifier.widthIn(min = CloudSpec.joinWidth).testTag(CloudTags.join(server.name)),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally),
            ) {
                Icon(Ionicon.Checkmark, 18.dp, colors.success)
                Text(stringResource(R.string.cloud_server_joined), style = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.Medium), color = colors.textSecondary)
            }
        } else if (onJoin != null) {
            val label = stringResource(R.string.cloud_server_join_label, server.title)
            RoundButton(
                title = stringResource(R.string.cloud_join_button),
                onClick = onJoin,
                size = RoundButtonSize.Normal,
                enabled = enabled || join == CloudJoin.Joining,
                loading = join == CloudJoin.Joining,
                modifier = Modifier.width(CloudSpec.joinWidth).semantics { contentDescription = label }.testTag(CloudTags.join(server.name)),
            )
        }
    }
}

/**
 * A server's picture: its ThumbHash at once, the bytes dissolving in over it
 * once fetched. Without a picture, the placeholder its bare name picks, as
 * desktop's rail and iOS's list pick it, and as its connection will wear
 * ([com.slopus.happy.connection.AgentConnections.placeholderSeed]).
 */
@Composable
private fun ServerAvatar(server: CloudServer, image: suspend (String) -> ByteArray?, size: Dp) {
    val picture = server.image
    if (picture == null) {
        PlaceholderAvatar(server.name, size, animated = false)
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
 * Bootstrap a server (desktop's create): its name, typed as `@name` like a
 * username (its domain isn't shown yet), said to be free or not as the
 * person pauses, then Bootstrap. The account's [first] server, with none to
 * go back to, says so.
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
    first: Boolean = false,
) {
    val colors = HappyTheme.colors
    CloudFrame(
        title = stringResource(R.string.cloud_create),
        body = stringResource(if (first) R.string.cloud_create_first_detail else R.string.cloud_create_detail),
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

/**
 * An invite link's Join screen: the server's picture in the scene's place,
 * who invited the person, the server's `@name` and the role it gives, then
 * Join, which signs in to Happy Cloud first when [signedIn] isn't. Every
 * step keeps one layout, so nothing jumps as it loads, joins or fails: room
 * for the picture, the same title, a two-line body, a line each for the
 * server and the inviter, a note's room for why it can't go on, and two
 * buttons as wide as the column. Another address's invite offers another
 * account.
 */
@Composable
fun CloudInviteScreen(
    step: CloudInviteStep,
    signedIn: Boolean,
    image: suspend (String) -> ByteArray?,
    onJoin: () -> Unit,
    onRetry: () -> Unit,
    onOtherAccount: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = HappyTheme.colors
    val preview = when (step) {
        is CloudInviteStep.Ready -> step.preview
        is CloudInviteStep.Refused -> step.preview
        else -> null
    }
    val refusal = (step as? CloudInviteStep.Refused)?.refusal
    val failure = (step as? CloudInviteStep.Unloaded)?.reason ?: (step as? CloudInviteStep.Ready)?.failure
    val note = when (refusal) {
        null -> failure?.let { stringResource(cloudFailureText(it)) }
        CloudInviteRefusal.Expired -> stringResource(R.string.cloud_invite_expired)
        CloudInviteRefusal.Revoked -> stringResource(R.string.cloud_invite_revoked)
        CloudInviteRefusal.UsedUp -> stringResource(R.string.cloud_invite_used_up)
        CloudInviteRefusal.Unknown -> stringResource(R.string.cloud_invite_unknown)
        is CloudInviteRefusal.EmailMismatch -> refusal.emailHint?.let { stringResource(R.string.cloud_invite_email_mismatch, CloudEmail.unbroken(it)) }
            ?: stringResource(R.string.cloud_invite_email_mismatch_unknown)
    }
    val joining = (step as? CloudInviteStep.Ready)?.joining == true || step is CloudInviteStep.Joined
    val join = stringResource(if (signedIn) R.string.cloud_join_button else R.string.cloud_invite_sign_in)
    val notNow = CloudAction(stringResource(R.string.cloud_invite_not_now), onBack, enabled = !joining)
    val (primary, secondary) = when {
        refusal is CloudInviteRefusal.EmailMismatch -> CloudAction(stringResource(R.string.cloud_invite_other_account), onOtherAccount) to notNow
        refusal != null -> CloudAction(stringResource(R.string.common_ok), onBack) to null
        step is CloudInviteStep.Unloaded -> CloudAction(stringResource(R.string.team_server_try_again), onRetry) to notNow
        else -> CloudAction(join, onJoin, enabled = step is CloudInviteStep.Ready && !joining, loading = joining) to notNow
    }
    val line = happyTextStyle(fontSize = 15, lineHeight = 20)
    CloudFrame(
        title = stringResource(
            when (refusal) {
                null -> R.string.cloud_invite_title
                // The invite is fine; it's the account that isn't the one invited.
                is CloudInviteRefusal.EmailMismatch -> R.string.cloud_invite_wrong_email
                else -> R.string.cloud_invite_unavailable
            },
        ),
        body = preview?.let { stringResource(R.string.cloud_invite_detail, it.server.title) } ?: "",
        bodyMinLines = 2,
        top = {
            Box(Modifier.size(CloudSpec.art), contentAlignment = Alignment.Center) {
                Crossfade(preview?.server, animationSpec = tween(CloudSpec.SWAP_MILLIS), label = "invite server") { server ->
                    if (server != null) {
                        ServerAvatar(server, image, CloudSpec.inviteServerAvatar)
                    } else {
                        Box(Modifier.size(CloudSpec.inviteServerAvatar).clip(CircleShape).background(colors.surface.copy(alpha = CloudSpec.SURFACE_ALPHA)), contentAlignment = Alignment.Center) {
                            if (step is CloudInviteStep.Loading) Spinner() else Icon(Ionicon.LinkOutline, CloudSpec.inviteServerAvatar / 3, colors.textSecondary)
                        }
                    }
                }
            }
        },
        primary = primary,
        secondary = secondary,
        steadyButtons = true,
        onBack = onBack,
    ) {
        Crossfade(preview, animationSpec = tween(CloudSpec.SWAP_MILLIS), label = "invite details") { shown ->
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(CloudSpec.rowGap), modifier = Modifier.fillMaxWidth()) {
                Text(
                    shown?.let { listOfNotNull("@${it.server.name}", it.roleName).joinToString(" · ") } ?: "",
                    style = line,
                    color = colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    minLines = 1,
                    modifier = Modifier.testTag(CloudTags.INVITE_SERVER),
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.height(CloudSpec.inviterAvatar).testTag(CloudTags.INVITER),
                ) {
                    val inviter = shown?.inviter
                    if (inviter != null) {
                        InviterAvatar(inviter.name, inviter.image, image, CloudSpec.inviterAvatar)
                        Text(stringResource(R.string.cloud_invite_inviter, inviter.name), style = line, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        Box(Modifier.fillMaxWidth().heightIn(min = CloudSpec.inviteNote), contentAlignment = Alignment.TopCenter) {
            Crossfade(note, animationSpec = tween(CloudSpec.SWAP_MILLIS), label = "invite note") { shown ->
                if (shown != null) NotePill(shown, colors.textDestructive)
            }
        }
    }
}

/** Who sent an invite: their picture, or their initials on the surface without one. */
@Composable
private fun InviterAvatar(name: String, picture: String?, image: suspend (String) -> ByteArray?, size: Dp) {
    val colors = HappyTheme.colors
    val bytes by produceState<ByteArray?>(null, picture) { value = picture?.let { image(it) } }
    Box(Modifier.size(size).clip(CircleShape).background(colors.surfaceHigh), contentAlignment = Alignment.Center) {
        val shown = bytes
        if (shown != null) {
            RemoteImage(shown, null, Modifier.matchParentSize(), cacheKey = picture)
        } else {
            val initials = remember(name) { name.trim().split(Regex("\\s+")).filter(String::isNotEmpty).take(2).joinToString("") { it.take(1) }.uppercase() }
            Text(initials, style = happyTextStyle(fontSize = 11, lineHeight = 14, weight = FontWeight.SemiBold), color = colors.textSecondary)
        }
    }
}

/**
 * Continue with email, its first step: the address, then Send code, which
 * mails a one-time code to it (`POST /v1/auth/email/start`) and goes on to
 * [CloudEmailCodeScreen]. Why it was refused shows under the field. While
 * the service asks to wait ([wait], seconds), Send code says how long.
 */
@Composable
fun CloudEmailScreen(
    email: String,
    busy: Boolean,
    outcome: EmailSignIn?,
    wait: Long,
    onEmail: (String) -> Unit,
    onSend: () -> Unit,
    onBack: () -> Unit,
) {
    CloudFrame(
        title = stringResource(R.string.cloud_email_title),
        body = stringResource(R.string.cloud_email_detail),
        art = R.raw.state_cloud_variation,
        primary = CloudAction(
            if (wait > 0) stringResource(R.string.cloud_email_wait, CloudEmail.countdown(wait)) else stringResource(R.string.cloud_email_send),
            onSend,
            enabled = CloudEmail.plausible(email) && wait <= 0 && !busy,
            loading = busy,
        ),
        onBack = onBack,
    ) {
        CloudField(email, onEmail, stringResource(R.string.cloud_email_placeholder), CloudTags.EMAIL, !busy, KeyboardType.Email, ImeAction.Done, autofill = ContentType.EmailAddress)
        EmailNote(outcome)
    }
}

/**
 * Continue with email, its second step: the 6-digit code mailed to [email],
 * typed (or filled in by the keyboard's one-time code) and checked as its
 * sixth digit comes, or with Verify (`POST /v1/auth/email/verify`). The
 * field stays enabled through a check, so the keyboard stays up for the
 * next try. Resend code under it waits a minute after each code
 * ([resendWait]); Change email goes back to the address. While the service
 * asks to wait ([wait]), Verify and Resend both say how long.
 */
@Composable
fun CloudEmailCodeScreen(
    email: String,
    code: String,
    busy: Boolean,
    outcome: EmailSignIn?,
    wait: Long,
    resendWait: Long,
    onCode: (String) -> Unit,
    onVerify: () -> Unit,
    onResend: () -> Unit,
    onChangeEmail: () -> Unit,
    onBack: () -> Unit,
) {
    val resendIn = maxOf(wait, resendWait)
    CloudFrame(
        title = stringResource(R.string.cloud_email_code_title),
        body = stringResource(R.string.cloud_email_code_detail, CloudEmail.unbroken(email)),
        art = R.raw.state_tickets,
        primary = CloudAction(
            if (wait > 0) stringResource(R.string.cloud_email_wait, CloudEmail.countdown(wait)) else stringResource(R.string.cloud_email_verify),
            onVerify,
            enabled = code.length == CloudEmail.CODE_LENGTH && wait <= 0 && !busy,
            loading = busy,
        ),
        secondary = CloudAction(
            if (resendIn > 0) stringResource(R.string.cloud_email_resend_in, CloudEmail.countdown(resendIn)) else stringResource(R.string.cloud_email_resend),
            onResend,
            enabled = resendIn <= 0 && !busy,
        ),
        onBack = onBack,
    ) {
        CloudField(
            code,
            { onCode(CloudEmail.typedCode(it)) },
            stringResource(R.string.cloud_email_code_placeholder),
            CloudTags.EMAIL_CODE,
            // Never disabled: the keyboard stays up through a check, for the next try.
            true,
            KeyboardType.NumberPassword,
            ImeAction.Done,
            autofill = ContentType.SmsOtpCode,
        )
        EmailNote(outcome)
        CloudLink(CloudAction(stringResource(R.string.cloud_email_change), onChangeEmail, enabled = !busy), CloudTags.CHANGE_EMAIL)
    }
}

/** Under an email step's field: why it was refused, in red; a resend's new code, quietly. */
@Composable
private fun EmailNote(outcome: EmailSignIn?) {
    val red = HappyTheme.colors.textDestructive
    when (outcome) {
        EmailSignIn.Sent -> NotePill(stringResource(R.string.cloud_email_resent), null)
        EmailSignIn.InvalidEmail -> NotePill(stringResource(R.string.cloud_email_invalid), red)
        EmailSignIn.InvalidCode -> NotePill(stringResource(R.string.cloud_email_code_wrong), red)
        EmailSignIn.Unavailable -> NotePill(stringResource(R.string.cloud_email_unavailable), red)
        // The service's own words where it gave some, shown as they came.
        is EmailSignIn.Unsupported -> NotePill(outcome.message ?: stringResource(R.string.cloud_email_unsupported), red)
        is EmailSignIn.RateLimited -> NotePill(outcome.message ?: stringResource(R.string.cloud_email_rate_limited), red)
        is EmailSignIn.Failed -> NotePill(stringResource(cloudFailureText(outcome.reason)), red)
        EmailSignIn.SignedIn, null -> Unit
    }
}

/** Continue with email's rules: what may be sent, what is typed, and how a wait reads. */
internal object CloudEmail {
    const val CODE_LENGTH = 6
    /** A new code waits this long after the last one. */
    const val RESEND_SECONDS = 60L

    /** Worth asking the service about: something, an @, something; it decides the rest (`invalid_email`). */
    fun plausible(email: String): Boolean {
        val at = email.trim().indexOf('@')
        return at > 0 && at < email.trim().length - 1
    }

    /** A code as typed or pasted: its digits, at most six. */
    fun typedCode(text: String): String = text.filter { it in '0'..'9' }.take(CODE_LENGTH)

    /** [email] kept on one line: word joiners between its characters, so it never breaks at its dot or @. */
    fun unbroken(email: String): String = email.toList().joinToString("\u2060")

    /** A wait as m:ss, the same in every language. */
    fun countdown(seconds: Long): String = "%d:%02d".format(java.util.Locale.ROOT, seconds / 60, seconds % 60)
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
 * Create your profile: a new member's name and picture on a Happy Cloud
 * server, on the gradient as the screens before it, its column at most
 * [CloudProfileSpec.columnMaxWidth]. The server has no profile for them
 * until it is named (`userId: null`). Their picture 120 round over the
 * title, the placeholder [seed] picks until one is chosen (the server's
 * own, as its connection will wear it: never the name, which may arrive
 * late or be typed over), with a camera
 * badge; it and "Add photo" (then "Change photo") under it open the
 * picker. The field starts from [suggested] (the server's, on Happy Cloud
 * the account's) with the keyboard up; Continue saves the name, then the
 * picture, which is optional, spinning through both. [failed]: the name
 * wasn't saved, said in plain words.
 */
@Composable
fun CloudProfileScreen(
    handle: String,
    seed: String,
    suggested: String?,
    photo: ImageBitmap?,
    saving: Boolean,
    failed: Boolean,
    onChoosePhoto: () -> Unit,
    onSubmit: (String) -> Unit,
    onBack: (() -> Unit)?,
) {
    // The cursor after a suggested name, as iOS: ready to add to it or take it.
    var field by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(suggested.orEmpty().let { TextFieldValue(it, TextRange(it.length)) }) }
    val name = field.text
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    CloudFrame(
        title = stringResource(R.string.cloud_profile_title),
        body = stringResource(R.string.cloud_profile_detail, handle),
        primary = CloudAction(stringResource(R.string.common_continue), { onSubmit(name) }, enabled = name.isNotBlank() && !saving, loading = saving),
        onBack = onBack,
        columnMaxWidth = CloudProfileSpec.columnMaxWidth,
        top = { ProfilePicturePicker(photo, seed, enabled = !saving, onChoosePhoto) },
    ) {
        CloudNameField(
            field,
            { field = it },
            enabled = !saving,
            onDone = { if (name.isNotBlank() && !saving) onSubmit(name) },
            modifier = Modifier.focusRequester(focus),
        )
        if (failed) NotePill(stringResource(R.string.cloud_profile_name_failed), HappyTheme.colors.textDestructive)
    }
}

object CloudProfileTags {
    const val PICTURE = "cloudProfile.picture"
    const val PHOTO = "cloudProfile.photo"
}

object CloudProfileSpec {
    val picture = 120.dp
    val badge = 36.dp
    val badgeIcon = 18.dp
    val buttonGap = 6.dp
    val buttonHeight = 32.dp
    /** Narrower than the other Cloud screens': a field and a picture, not a list. */
    val columnMaxWidth = 420.dp
}

/** The picture, round, with its camera badge bottom-right, and the text button under it: both open the picker. */
@Composable
internal fun ProfilePicturePicker(photo: ImageBitmap?, seed: String, enabled: Boolean, onChoose: () -> Unit) {
    val colors = HappyTheme.colors
    val text = if (colors.dark) StartSpec.darkText else StartSpec.lightText
    val label = stringResource(if (photo == null) R.string.cloud_profile_add_photo else R.string.cloud_profile_change_photo)
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(CloudProfileSpec.picture)
                .clickable(enabled = enabled, role = Role.Button, onClick = onChoose)
                .semantics { contentDescription = label }
                .testTag(CloudProfileTags.PICTURE),
        ) {
            PersonPicture(photo, seed, CloudProfileSpec.picture)
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(CloudProfileSpec.badge)
                    .clip(CircleShape)
                    .background(colors.surface),
                contentAlignment = Alignment.Center,
            ) {
                androidx.compose.material3.Icon(MaterialSymbols.PhotoCamera, contentDescription = null, tint = colors.text, modifier = Modifier.size(CloudProfileSpec.badgeIcon))
            }
        }
        Box(
            Modifier
                .padding(top = CloudProfileSpec.buttonGap)
                .heightIn(min = CloudProfileSpec.buttonHeight)
                .clip(RoundedCornerShape(8.dp))
                .clickable(enabled = enabled, role = Role.Button, onClick = onChoose)
                .testTag(CloudProfileTags.PHOTO)
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(label, style = happyTextStyle(fontSize = 16, lineHeight = 20, weight = FontWeight.SemiBold), color = text)
        }
    }
}

/** A large field on the gradient: the theme's surface, a little see-through, 18 type. */
@Composable
internal fun CloudField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    tag: String,
    enabled: Boolean,
    keyboard: KeyboardType,
    ime: ImeAction,
    transformation: VisualTransformation = VisualTransformation.None,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.None,
    /** What autofill may offer here: an email address, a one-time code. */
    autofill: ContentType? = null,
    /** The keyboard's action key. */
    onIme: (() -> Unit)? = null,
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
            keyboardActions = KeyboardActions(onAny = { onIme?.invoke() }),
            modifier = Modifier.testTag(tag).then(if (autofill == null) Modifier else Modifier.semantics { contentType = autofill }),
        )
    }
}

/** [CloudField] for a name: its own cursor (a prefilled one at the end, as iOS), words capitalized, Done sending it. */
@Composable
private fun CloudNameField(value: TextFieldValue, onChange: (TextFieldValue) -> Unit, enabled: Boolean, onDone: () -> Unit, modifier: Modifier) {
    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(CloudSpec.fieldRadius)).background(HappyTheme.colors.surface.copy(alpha = CloudSpec.SURFACE_ALPHA))) {
        HappyTextField(
            value = value,
            onValueChange = onChange,
            placeholder = stringResource(R.string.team_server_name_placeholder),
            textStyle = happyTextStyle(fontSize = 18, lineHeight = 24),
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 16.dp),
            minHeight = CloudSpec.fieldMinHeight,
            cornerRadius = CloudSpec.fieldRadius,
            singleLine = true,
            enabled = enabled,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, autoCorrectEnabled = false, keyboardType = KeyboardType.Text, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
            modifier = modifier.testTag(ServerSignInTags.NAME),
        )
    }
}

/** A note that reads on any part of the gradient: on the fields' surface, in [color] or the secondary text. */
@Composable
internal fun NotePill(text: String, color: Color?) {
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
    // Create shows a taken name as its availability, with the name.
    CloudException.Reason.Taken -> R.string.cloud_failed
    CloudException.Reason.Invalid -> R.string.cloud_name_rules
    CloudException.Reason.NotFound -> R.string.cloud_failed
    CloudException.Reason.SignInRequired -> R.string.team_server_error_sign_in_required
    CloudException.Reason.Unreachable -> R.string.team_server_error_unreachable
    CloudException.Reason.Failed -> R.string.cloud_failed
}
