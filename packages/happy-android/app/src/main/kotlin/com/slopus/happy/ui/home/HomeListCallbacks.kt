package com.slopus.happy.ui.home

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import com.slopus.happy.model.WorkspaceOrigin

/**
 * Called with a row's session id every time that row composes. Tests use it
 * to pin that a changed session recomposes its own row and nothing else.
 */
val LocalHomeRowObserver = staticCompositionLocalOf<((String) -> Unit)?> { null }

/** What the list's rows ask of it; one instance for the whole list, so rows skip on equal data. */
@Immutable
class HomeListCallbacks(
    val onOpen: (sessionId: String) -> Unit,
    val onMenu: (sessionId: String) -> Unit,
    val onArchive: (sessionId: String) -> Unit,
    val onSetArchiveHidden: (Boolean) -> Unit,
    val onToggleProject: (projectId: String) -> Unit,
    val onOpenMachine: (machineId: String) -> Unit,
    val onCreateWorkspace: (WorkspaceOrigin) -> Unit,
    val onProjectMenu: (projectName: String, origin: WorkspaceOrigin) -> Unit,
    /** A finger landed on a session's row, before it is a tap (useSessionPressHandlers' onPressIn). */
    val onPressDown: (sessionId: String) -> Unit = {},
)

/**
 * Reports a finger landing on a session's row to [HomeListCallbacks.onPressDown],
 * so its chat starts loading before the tap completes. It only watches: the
 * tap, long press, scroll and swipe still belong to the row's own handlers.
 */
fun Modifier.sessionPressDown(sessionId: String?, callbacks: HomeListCallbacks): Modifier =
    if (sessionId == null) {
        this
    } else {
        pointerInput(sessionId, callbacks) {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                callbacks.onPressDown(sessionId)
            }
        }
    }
