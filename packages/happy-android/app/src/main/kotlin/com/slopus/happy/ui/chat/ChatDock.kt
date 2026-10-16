package com.slopus.happy.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatState
import com.slopus.happy.chat.ComposerModes
import com.slopus.happy.model.SessionState
import com.slopus.happy.sync.rigCanAbort
import com.slopus.happy.ui.attachments.ComposerAddImageButton
import com.slopus.happy.ui.attachments.ComposerAttachmentStrip
import com.slopus.happy.ui.attachments.hasComposerImages
import com.slopus.happy.ui.autocomplete.ComposerSuggestions
import com.slopus.happy.ui.autocomplete.rememberComposerAutocomplete
import com.slopus.happy.ui.layout.CenteredInputWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.usage.ComposerUsageRow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * AgentContentView's scrim behind the floating dock: from 28 above the
 * dock ([dockHeight], with its system-bar and keyboard room) down to the
 * screen's bottom, or to the keyboard's top when it is up.
 */
@Composable
internal fun DockScrim(dockHeight: Int, modifier: Modifier = Modifier) {
    val density = LocalDensity.current
    val keyboardExtra = (WindowInsets.ime.getBottom(density) - WindowInsets.navigationBars.getBottom(density)).coerceAtLeast(0)
    val stops = if (HappyTheme.colors.dark) ChatScreenSpec.scrimDark else ChatScreenSpec.scrimLight
    with(density) {
        Box(
            modifier
                .padding(bottom = keyboardExtra.toDp())
                .testTag(ChatScreenTags.SCRIM)
                .fillMaxWidth()
                .height((dockHeight - keyboardExtra).toDp() + ChatScreenSpec.scrimOverhang)
                .background(Brush.verticalGradient(*stops.toTypedArray())),
        )
    }
}

/**
 * SessionView.tsx's `input`: the inactive-session hint (a real session
 * only), [goalBar] and the question banner in the centred input width,
 * [activityBar] full width, then the composer. Each part above the
 * composer, and the composer's status and usage rows, fade in place while
 * [showDetails] is false. [session] is the chat, or a pending chat's anchor.
 */
@Composable
internal fun ChatDock(
    state: ChatState,
    session: ChatSessionInfo,
    draft: String,
    actions: ChatScreenActions,
    now: Long,
    modes: ComposerModes,
    inactiveHint: InactiveHint?,
    goalBar: (@Composable () -> Unit)?,
    activityBar: (@Composable () -> Unit)?,
    inputPadding: Dp,
    showDetails: Boolean,
    onPanelPositioned: ((LayoutCoordinates) -> Unit)?,
    modifier: Modifier,
    composerModifier: Modifier,
) {
    Column(modifier.testTag(ChatScreenTags.DOCK).fillMaxWidth()) {
        if (inactiveHint != null) {
            AnimatedFade(showDetails) { CenteredInputWidth(horizontalPadding = inputPadding) { InactiveArchivedHint(inactiveHint, actions.onResume) } }
        }
        if (goalBar != null) {
            AnimatedFade(showDetails) { CenteredInputWidth(horizontalPadding = inputPadding) { goalBar() } }
        }
        AnimatedFade(showDetails) {
            CenteredInputWidth(horizontalPadding = inputPadding) {
                AgentQuestionBanner(state.pendingCommunications, actions.onAnswerQuestion, actions.onCancelQuestion)
            }
        }
        if (activityBar != null) AnimatedFade(showDetails) { activityBar() }
        ChatComposerFor(state, session, draft, actions, now, modes, showDetails, onPanelPositioned, composerModifier)
    }
}

/**
 * AgentInput.tsx's press handling. Stop: an error haptic, a spinner for at
 * least 300 ms, and once the agent took it Stop stays away until the agent
 * is no longer busy; if it failed, the button shakes and Stop comes back.
 * A refused send (a busy agent that can't be steered): an error haptic and
 * the card shakes. Send: a light haptic. A hardware Escape, when the
 * suggestion list doesn't take it, stops a busy agent.
 */
@Composable
private fun ChatComposerFor(
    state: ChatState,
    session: ChatSessionInfo,
    draft: String,
    actions: ChatScreenActions,
    now: Long,
    modes: ComposerModes,
    showDetails: Boolean,
    onPanelPositioned: ((LayoutCoordinates) -> Unit)?,
    modifier: Modifier,
) {
    val sessionState = state.sessionState
    val metadata = session.metadata
    val showAbort = showsAbort(sessionState)
    var aborting by remember { mutableStateOf(false) }
    // A local acknowledgement: the status update can trail the abort RPC.
    var stopRequested by remember { mutableStateOf(false) }
    LaunchedEffect(showAbort) { if (!showAbort) stopRequested = false }
    val canAbort = sessionState != SessionState.Disconnected && metadata.rigCanAbort() && !stopRequested
    val blocked = session.isRig && state.thinking && metadata?.capabilities?.steering != true
    val primary = resolvePrimaryAction(
        hasContent = draft.isNotBlank() || hasComposerImages(),
        showAbort = showAbort,
        canAbort = canAbort,
        blocked = blocked,
    )
    val autocomplete = rememberComposerAutocomplete(draft, actions.onDraftChange)
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val panelShake = rememberShake()
    val primaryShake = rememberShake()
    fun abort() {
        if (aborting) return
        haptics.error()
        stopRequested = true
        aborting = true
        scope.launch {
            try {
                coroutineScope {
                    launch { delay(ABORT_MIN_SPINNER_MS) }
                    actions.onAbort()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                stopRequested = false
                launch { primaryShake.shake() }
            } finally {
                aborting = false
            }
        }
    }
    // AgentInput handleKeyPress: with no suggestions up, Escape stops a busy agent.
    val canEscape = showAbort && sessionState != SessionState.Disconnected && metadata.rigCanAbort()
    ChatComposer(
        text = draft,
        onTextChange = actions.onDraftChange,
        status = rememberComposerStatus(sessionState, state.activeAt, now),
        primary = primary,
        aborting = aborting,
        onPrimary = {
            when (primary) {
                PrimaryAction.Stop -> abort()
                PrimaryAction.Blocked -> {
                    haptics.error()
                    scope.launch { panelShake.shake() }
                }
                PrimaryAction.Send -> {
                    haptics.light()
                    stopRequested = false
                    actions.onSend(draft)
                }
                PrimaryAction.Idle -> Unit
            }
        },
        modifier = modifier,
        showDetails = showDetails,
        onPanelPositioned = onPanelPositioned,
        middle = {
            // [+] [permission ... model · effort]: the chips take what the add button leaves.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ComposerSpec.actionRowGap)) {
                ComposerAddImageButton()
                ComposerModeChips(modes, metadata, actions.onModeChange, Modifier.weight(1f))
            }
        },
        top = { ComposerAttachmentStrip() },
        overlay = { ComposerSuggestions(autocomplete) },
        cursor = autocomplete.cursor,
        onKey = { event ->
            (event.key == Key.Escape && canEscape && !aborting).also { if (it && event.type == KeyEventType.KeyDown) abort() }
        },
        panelShake = panelShake,
        primaryShake = primaryShake,
        bottom = { ComposerUsageRow(state.snapshot.usage, session.agentState?.usageLimits) },
    )
}

/** AgentInput.tsx: Stop's spinner shows at least this long. */
private const val ABORT_MIN_SPINNER_MS = 300L
