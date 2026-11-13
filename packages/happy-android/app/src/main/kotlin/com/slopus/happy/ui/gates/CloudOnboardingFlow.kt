package com.slopus.happy.ui.gates

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.annotation.RawRes
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.toRoute
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.agent.Permission
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.onboarding.CloudOnboarding
import com.slopus.happy.onboarding.OnboardingApi
import com.slopus.happy.onboarding.OnboardingGate
import com.slopus.happy.onboarding.OnboardingIncomplete
import com.slopus.happy.onboarding.OnboardingPlan
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.connection.CloudAction
import com.slopus.happy.ui.connection.CloudFrame
import com.slopus.happy.ui.connection.CloudProfileScreen
import com.slopus.happy.ui.connection.NotePill
import com.slopus.happy.ui.connection.ProfilePicturePicker
import com.slopus.happy.ui.connection.rememberPersonSeed
import com.slopus.happy.ui.connection.rememberPhoto
import com.slopus.happy.ui.connection.rememberProfilePhotoPicker
import com.slopus.happy.ui.conversation.openChiefOfStaff
import com.slopus.happy.ui.page
import com.slopus.happy.ui.start.StartSpec
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** A Happy Cloud server's onboarding over its home, for connection [connectionId]. */
@Serializable data class CloudOnboardingRoute(val connectionId: String)

object CloudOnboardingTags {
    const val PROGRESS = "cloudOnboarding.progress"
    const val PROBLEM = "cloudOnboarding.problem"
    fun screen(key: String) = "cloudOnboarding.screen.$key"
}

fun NavGraphBuilder.cloudOnboardingRoutes(graph: AppGraph, nav: NavHostController) {
    page<CloudOnboardingRoute> { entry -> CloudOnboardingPage(graph, nav, entry.toRoute<CloudOnboardingRoute>().connectionId) }
}

/**
 * Shows the open connection's onboarding over its home whenever the server
 * says something is left for the person ([OnboardingPlan]) and home is on
 * screen: again whenever it stops being finished (nothing latches), and
 * after Not Now only while a gate blocks.
 */
@Composable
fun CloudOnboardingEffect(graph: AppGraph, nav: NavHostController, connectionId: String?) {
    val source = remember(connectionId) { connectionId?.let { graph.agentSessions.session(it)?.onboarding } } ?: return
    val onboarding by source.current.collectAsStateWithLifecycle()
    val later by source.later.collectAsStateWithLifecycle()
    val entry by nav.currentBackStackEntryAsState()
    val home = entry?.destination?.hasRoute<HomeRoute>() == true
    LaunchedEffect(onboarding, later, home) {
        val now = onboarding ?: return@LaunchedEffect
        if (!home || OnboardingPlan.of(now).step == null) return@LaunchedEffect
        if (later && now.gates.none { it.blocking }) return@LaunchedEffect
        nav.navigate(CloudOnboardingRoute(connectionId!!)) { launchSingleTop = true }
    }
}

@Composable
private fun CloudOnboardingPage(graph: AppGraph, nav: NavHostController, connectionId: String) {
    val session = remember(connectionId) { graph.agentSessions.session(connectionId) } ?: return
    val source = session.onboarding ?: return
    val onboarding = source.current.collectAsStateWithLifecycle().value ?: return
    val permissions by session.permissions.collectAsStateWithLifecycle()
    val photoBytes by session.profile.photo.collectAsStateWithLifecycle()
    val profile by session.profile.state.collectAsStateWithLifecycle()
    var finishing by remember { mutableStateOf(false) }
    val plan = OnboardingPlan.of(onboarding)
    val step = plan.step(showing = true)
    // Nothing left and no finish to show (a server without gates): the flow goes.
    LaunchedEffect(step == null) { if (step == null && !finishing) nav.popBackStack() }
    step ?: return
    val blocks = !onboarding.legacy && onboarding.gates.any { it.blocking }
    val activity = LocalContext.current as? Activity
    val notNow = { source.putAway(); nav.popBackStack(); Unit }
    // A gate that blocks keeps the person here: Back leaves the app instead, as from home.
    BackHandler { if (blocks) activity?.moveTaskToBack(true) else notNow() }
    val client = session.client
    val meets = permissions.allows(Permission.CONTENT_WRITE) && permissions.allows(Permission.BOTS_MANAGE)
    CloudOnboardingFlow(
        onboarding = onboarding,
        step = step,
        progress = if (plan.count > 1) plan.progress else null,
        handle = HappyCloud.handle(session.server) ?: session.server.orEmpty(),
        seed = rememberPersonSeed(graph, connectionId),
        name = profile.name,
        photo = rememberPhoto(photoBytes),
        meets = meets,
        actions = OnboardingActions(
            skip = { id -> source.took(OnboardingApi.skip(client, id)) },
            check = { source.check() },
            saveName = { name -> session.profile.rename(name); source.check() },
            savePhoto = { jpeg -> session.profile.setPhoto(jpeg); source.check() },
            finish = {
                finishing = true
                try {
                    if (!onboarding.legacy) OnboardingApi.complete(client)
                    nav.popBackStack()
                    if (meets) nav.openChiefOfStaff(connectionId, "")
                } catch (e: OnboardingIncomplete) {
                    finishing = false
                    source.refresh()
                } catch (e: Exception) {
                    finishing = false
                    throw e
                }
            },
            web = HappyCloud.webApp(session.server),
            onNotNow = notNow.takeUnless { blocks },
        ),
    )
}

/** What the flow's screens do, each answered by the server's onboarding as it is next. */
class OnboardingActions(
    val skip: suspend (gateId: String) -> Unit,
    val check: suspend () -> Unit,
    val saveName: suspend (String) -> Unit,
    val savePhoto: suspend (ByteArray) -> Unit,
    /** Completes onboarding and leaves; throws when it couldn't. */
    val finish: suspend () -> Unit,
    /** The server in the web app, where payments and what the phone can't do yet are done. */
    val web: String?,
    /** Not Now; null while a gate blocks. */
    val onNotNow: (() -> Unit)?,
)

/** Google Play's page for Happy, where the server names none. */
internal const val PLAY_STORE = "https://play.google.com/store/apps/details?id=com.ex3ndr.happy"

/**
 * The flow itself, one full screen per [step] on Happy Cloud's gradient,
 * each taking the last one's place as the server moves on; a short bar at
 * the top fills as gates are done ([progress], null for a flow of one).
 */
@Composable
internal fun CloudOnboardingFlow(
    onboarding: CloudOnboarding,
    step: OnboardingPlan.Step,
    progress: Float?,
    handle: String,
    seed: String,
    name: String?,
    photo: ImageBitmap?,
    meets: Boolean,
    actions: OnboardingActions,
) {
    Box(Modifier.fillMaxSize()) {
        AnimatedContent(
            targetState = step,
            contentKey = ::stepKey,
            transitionSpec = { (slideInHorizontally { it / 4 } + fadeIn()) togetherWith fadeOut() },
            label = "onboarding",
        ) { shown ->
            Box(Modifier.fillMaxSize().testTag(CloudOnboardingTags.screen(stepKey(shown)))) {
                when (shown) {
                    is OnboardingPlan.Step.Gate -> GateScreen(shown.gate, handle, seed, name, photo, actions)
                    OnboardingPlan.Step.Update -> {
                        val context = LocalContext.current
                        val store = (onboarding.gates.firstNotNullOfOrNull { it.kind as? OnboardingGate.Kind.MobileApp })?.playStoreUrl ?: PLAY_STORE
                        Notice(
                            R.raw.state_magic_wand,
                            stringResource(R.string.cloud_onboarding_update_title),
                            stringResource(R.string.cloud_onboarding_update_body),
                            primary = stringResource(R.string.cloud_onboarding_update_action) to suspend { openUrl(context, store) },
                            onNotNow = actions.onNotNow,
                        )
                    }
                    is OnboardingPlan.Step.Waiting -> WaitingScreen(shown.gates, actions)
                    OnboardingPlan.Step.Finish -> FinishScreen(onboarding, handle, meets, actions)
                }
            }
        }
        // Only over a gate's own screen: waiting, updating and the finish aren't steps along it.
        if (progress != null && step is OnboardingPlan.Step.Gate) Progress(progress, Modifier.align(Alignment.TopCenter))
    }
}

private fun stepKey(step: OnboardingPlan.Step): String = when (step) {
    is OnboardingPlan.Step.Gate -> step.gate.id
    OnboardingPlan.Step.Update -> "update"
    is OnboardingPlan.Step.Waiting -> "waiting"
    OnboardingPlan.Step.Finish -> "finish"
}

/** A short capsule centred where the bar is, filling as gates are done. */
@Composable
private fun Progress(fraction: Float, modifier: Modifier) {
    val dark = HappyTheme.colors.dark
    val text = if (dark) StartSpec.darkText else StartSpec.lightText
    val label = stringResource(R.string.cloud_onboarding_progress)
    Box(
        modifier
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(top = 29.dp)
            .size(96.dp, 6.dp)
            .clip(RoundedCornerShape(50))
            .background(text.copy(alpha = 0.18f))
            .semantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f)
            }
            .testTag(CloudOnboardingTags.PROGRESS),
    ) {
        val animated by androidx.compose.animation.core.animateFloatAsState(fraction.coerceIn(0f, 1f), label = "progress")
        Box(Modifier.fillMaxHeight().fillMaxWidth(animated).clip(RoundedCornerShape(50)).background(text))
    }
}

/**
 * One screen with nothing typed: its scene, its words, its action and an
 * optional quieter one (Skip for now); what went wrong shows under the
 * words. An action runs once at a time, its button spinning meanwhile.
 */
@Composable
internal fun Notice(
    @RawRes art: Int,
    title: String,
    body: String,
    primary: Pair<String, suspend () -> Unit>?,
    secondary: Pair<String, suspend () -> Unit>? = null,
    onNotNow: (() -> Unit)?,
    failure: String = stringResource(R.string.cloud_onboarding_couldnt_check),
    secondaryFailure: String = stringResource(R.string.cloud_onboarding_couldnt_skip),
) {
    val scope = rememberCoroutineScope()
    var running by remember { mutableStateOf<Int?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    fun run(which: Int, failed: String, act: suspend () -> Unit) {
        if (running != null) return
        running = which
        problem = null
        scope.launch {
            try {
                act()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                problem = failed
            } finally {
                running = null
            }
        }
    }
    CloudFrame(
        title = title,
        onBack = onNotNow,
        body = body,
        art = art,
        primary = primary?.let { (label, act) -> CloudAction(label, { run(0, failure, act) }, enabled = running == null, loading = running == 0) },
        secondary = secondary?.let { (label, act) -> CloudAction(label, { run(1, secondaryFailure, act) }, enabled = running == null) },
    ) {
        problem?.let { Box(Modifier.testTag(CloudOnboardingTags.PROBLEM)) { NotePill(it, HappyTheme.colors.textDestructive) } }
    }
}

/** Skip for now on an optional gate's screen; the server's answer moves the flow on. */
@Composable
private fun skipFor(gate: OnboardingGate, actions: OnboardingActions): Pair<String, suspend () -> Unit>? =
    if (gate.requirement == OnboardingGate.Requirement.Optional) stringResource(R.string.cloud_onboarding_skip) to suspend { actions.skip(gate.id) } else null

@Composable
private fun GateScreen(gate: OnboardingGate, handle: String, seed: String, name: String?, photo: ImageBitmap?, actions: OnboardingActions) {
    when (gate.kind) {
        OnboardingGate.Kind.Profile -> ProfileStep(handle, seed, name, actions)
        OnboardingGate.Kind.Avatar -> PhotoStep(gate, seed, photo, actions)
        // Done on desktop or the web: payments always, the others until their screens come.
        else -> {
            val context = LocalContext.current
            Notice(
                R.raw.state_tv,
                stringResource(R.string.cloud_onboarding_elsewhere_title),
                stringResource(R.string.cloud_onboarding_elsewhere_body, stepName(gate)),
                primary = actions.web?.let { url -> stringResource(R.string.cloud_onboarding_open_web) to suspend { openUrl(context, url) } },
                secondary = skipFor(gate, actions),
                onNotNow = actions.onNotNow,
            )
        }
    }
}

/** Create your profile, as at sign-in: the name, then any picture. */
@Composable
private fun ProfileStep(handle: String, seed: String, name: String?, actions: OnboardingActions) {
    val scope = rememberCoroutineScope()
    var picked by remember { mutableStateOf<ByteArray?>(null) }
    var saving by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val choose = rememberProfilePhotoPicker(onPicked = { picked = it }, onFailed = {})
    CloudProfileScreen(
        handle = handle,
        seed = seed,
        suggested = name,
        photo = rememberPhoto(picked),
        saving = saving,
        failed = failed,
        onChoosePhoto = choose,
        onSubmit = { typed ->
            saving = true
            failed = false
            scope.launch {
                try {
                    actions.saveName(typed.trim())
                    // The picture is optional: one that doesn't go up leaves the name kept.
                    picked?.let { runCatching { actions.savePhoto(it) } }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    failed = true
                } finally {
                    saving = false
                }
            }
        },
        onBack = actions.onNotNow,
    )
}

/** Add a photo: the picker, then the picture goes up at once; Skip for now while optional. */
@Composable
private fun PhotoStep(gate: OnboardingGate, seed: String, photo: ImageBitmap?, actions: OnboardingActions) {
    val scope = rememberCoroutineScope()
    var picked by remember { mutableStateOf<ByteArray?>(null) }
    var uploading by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val failedWords = stringResource(R.string.cloud_onboarding_photo_failed)
    val skipWords = stringResource(R.string.cloud_onboarding_couldnt_skip)
    val unreadable = stringResource(R.string.settings_could_not_change_photo)
    val choose = rememberProfilePhotoPicker(
        onPicked = { jpeg ->
            picked = jpeg
            uploading = true
            problem = null
            scope.launch {
                try {
                    actions.savePhoto(jpeg)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    problem = failedWords
                } finally {
                    uploading = false
                }
            }
        },
        onFailed = { problem = unreadable },
    )
    val shown = rememberPhoto(picked) ?: photo
    val skip = skipFor(gate, actions)
    CloudFrame(
        title = stringResource(R.string.cloud_onboarding_photo_title),
        onBack = actions.onNotNow,
        body = stringResource(R.string.cloud_onboarding_photo_body),
        top = { ProfilePicturePicker(shown, seed, enabled = !uploading, onChoose = choose) },
        primary = CloudAction(stringResource(R.string.cloud_onboarding_choose_photo), choose, enabled = !uploading, loading = uploading),
        secondary = skip?.let { (label, act) ->
            CloudAction(label, {
                scope.launch {
                    try {
                        act()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        problem = skipWords
                    }
                }
            }, enabled = !uploading)
        },
    ) {
        problem?.let { Box(Modifier.testTag(CloudOnboardingTags.PROBLEM)) { NotePill(it, HappyTheme.colors.textDestructive) } }
    }
}

/**
 * Waiting for your admin: the blocking steps only someone else can see
 * to, named; or, where the server can't tell yet (payments before
 * billing), almost ready. Check again reads the server now.
 */
@Composable
private fun WaitingScreen(gates: List<OnboardingGate>, actions: OnboardingActions) {
    val theirs = gates.filter { !it.canComplete && it.status != OnboardingGate.Status.Unavailable }
    val check = stringResource(R.string.cloud_onboarding_check_again) to actions.check
    if (theirs.isEmpty()) {
        Notice(R.raw.state_tree, stringResource(R.string.cloud_onboarding_not_ready_title), stringResource(R.string.cloud_onboarding_not_ready_body), check, onNotNow = actions.onNotNow)
    } else {
        val steps = theirs.map { stepName(it) }.joinToString(", ") { it.replaceFirstChar { c -> c.lowercase() } }
        Notice(R.raw.state_owl, stringResource(R.string.cloud_onboarding_waiting_title), stringResource(R.string.cloud_onboarding_waiting_body, steps), check, onNotNow = actions.onNotNow)
    }
}

/** You're all set: completes onboarding, then the Chief of Staff's conversation for those who may talk to it, else home. */
@Composable
private fun FinishScreen(onboarding: CloudOnboarding, handle: String, meets: Boolean, actions: OnboardingActions) {
    val bot = (onboarding.gates.firstNotNullOfOrNull { it.kind as? OnboardingGate.Kind.AdminBot })?.name?.takeIf { it.isNotBlank() }
    val action = if (meets && bot != null) stringResource(R.string.cloud_onboarding_meet, bot) else stringResource(R.string.cloud_onboarding_get_started)
    Notice(
        R.raw.state_sparkles,
        stringResource(R.string.cloud_onboarding_done_title),
        stringResource(R.string.cloud_onboarding_done_body, handle),
        primary = action to actions.finish,
        onNotNow = null,
        failure = stringResource(R.string.cloud_onboarding_couldnt_finish),
    )
}

/** A gate as a step in a sentence. */
@Composable
internal fun stepName(gate: OnboardingGate): String = stringResource(
    when (gate.kind) {
        OnboardingGate.Kind.Profile -> R.string.cloud_onboarding_step_profile
        OnboardingGate.Kind.Avatar -> R.string.cloud_onboarding_step_avatar
        is OnboardingGate.Kind.AdminBot -> R.string.cloud_onboarding_step_admin_bot
        is OnboardingGate.Kind.Inference -> R.string.cloud_onboarding_step_inference
        is OnboardingGate.Kind.Plugins -> R.string.cloud_onboarding_step_plugins
        is OnboardingGate.Kind.Teammates -> R.string.cloud_onboarding_step_teammates
        is OnboardingGate.Kind.MobileApp -> R.string.cloud_onboarding_step_mobile_app
        OnboardingGate.Kind.PaymentMethod -> R.string.cloud_onboarding_step_payment_method
        OnboardingGate.Kind.Payment -> R.string.cloud_onboarding_step_payment
        OnboardingGate.Kind.Unknown -> R.string.cloud_onboarding_step_unknown
    },
)

private fun openUrl(context: android.content.Context, url: String) {
    try {
        context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: android.content.ActivityNotFoundException) {
    }
}
