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
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
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
    const val CODE = "cloud.code"
    const val MENU = "cloud.menu"
    const val MEMBERS = "cloud.members"
    const val LEAVE = "cloud.leave"
    const val LOGIN = "cloud.login"
    const val PASSWORD = "cloud.password"
    const val SLIDES = "cloud.slides"
    const val CREATE = "cloud.create"
    const val INVITE = "cloud.invite"
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
 * phone), then Continue into the app once one is; Bootstrap a new one and
 * Join with an invite under them. Back there signs the account out, so
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
    /** A test account's sign-in, for the welcome's hidden form. */
    signInWithPassword: suspend (login: String, password: String) -> PasswordSignIn,
    onReload: () -> Unit,
    onJoinServer: (CloudServer) -> Unit,
    onContinue: () -> Unit,
    onCreate: () -> Unit,
    onInvite: () -> Unit,
    onSignOut: () -> Unit,
    onBack: () -> Unit,
) {
    when (state) {
        // Signed out, waiting for the Auth Tab, finishing, or why it failed: all the welcome, its one button saying which.
        is CloudAccountState.SignedOut, CloudAccountState.InBrowser, CloudAccountState.Finishing, is CloudAccountState.Failed ->
            CloudWelcome(state, onOpenBrowser, signInWithPassword, onBack)
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
                    CloudLink(CloudAction(stringResource(R.string.cloud_invite), onInvite, enabled = !joining), CloudTags.INVITE)
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
 * under it in Use Happy Cloud's, as iOS. Each opens that provider's sign-in
 * in the app ([CloudProvider]: Apple has no native sign-in on Android, and
 * the accounts service refuses Google). Over them, a note: the hour up, or
 * why the last sign-in failed. While the code is exchanged the one pressed
 * spins.
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
    if (!unlocked) {
        val colors = HappyTheme.colors
        val note = when (state) {
            is CloudAccountState.SignedOut -> if (state.expired) stringResource(R.string.cloud_session_expired) to null else null
            is CloudAccountState.Failed -> stringResource(failureText(state.reason)) to colors.textDestructive
            else -> null
        }
        CloudDeck(
            note = note,
            primary = apple,
            secondary = github,
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
 * any, 12 over [primary] where Start is, and [secondary] where Use Happy
 * Cloud is: 12 under it, 24 above the bottom inset, both as wide as the
 * wider (at least 280), [primary] rising to make room. It scrolls when it
 * outgrows the window. The drift keeps clear of the slides and of the
 * note and buttons.
 */
@Composable
private fun CloudDeck(note: Pair<String, Color?>?, primary: CloudAction, secondary: CloudAction?, onArtPress: (Long) -> Unit, onBack: () -> Unit) {
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
                                        .padding(top = StartSpec.cloudGap, bottom = StartSpec.cloudBottomPadding)
                                        .testTag(CloudTags.SECONDARY),
                                )
                            }
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
/** A quiet action in a screen's column, in the gradient's text colour: desktop's ghost buttons under the list. */
@Composable
private fun CloudLink(action: CloudAction, tag: String) {
    val dark = HappyTheme.colors.dark
    RoundButton(
        title = action.title,
        onClick = action.onClick,
        enabled = action.enabled,
        display = RoundButtonDisplay.Inverted,
        contentColor = if (dark) StartSpec.darkText else StartSpec.lightText,
        modifier = Modifier.testTag(tag),
    )
}

/**
 * A server on the gradient, desktop's row: its picture, display name and
 * `@name`, the person's role where the accounts service still lists one,
 * then Join: a spinner while it joins, and Joined with a check once it is
 * on the phone.
 */
@Composable
private fun ServerCard(server: CloudServer, join: CloudJoin?, enabled: Boolean, image: suspend (String) -> ByteArray?, onJoin: () -> Unit) {
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
        if (role != null) Text(stringResource(role), style = happyTextStyle(fontSize = 14, lineHeight = 18), color = colors.textSecondary)
        if (join == CloudJoin.Joined) {
            Row(
                Modifier.widthIn(min = CloudSpec.joinWidth).testTag(CloudTags.join(server.name)),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally),
            ) {
                Icon(Ionicon.Checkmark, 18.dp, colors.success)
                Text(stringResource(R.string.cloud_server_joined), style = happyTextStyle(fontSize = 15, lineHeight = 20, weight = FontWeight.Medium), color = colors.textSecondary)
            }
        } else {
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
 * go back to, says so and offers Have an invite? Join a server.
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
    onInvite: () -> Unit = {},
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
        if (first) CloudLink(CloudAction(stringResource(R.string.cloud_create_have_invite), onInvite, enabled = !busy), CloudTags.INVITE)
    }
}

/** Join with an invite: the server's `@name` and the invite code its owner sent, then Join server. */
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
        title = stringResource(R.string.cloud_invite),
        body = stringResource(R.string.cloud_join_detail),
        art = R.raw.state_owl,
        primary = CloudAction(stringResource(R.string.cloud_invite_button), onJoin, enabled = name.length >= 3 && code.isNotEmpty() && !busy, loading = busy),
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
