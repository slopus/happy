package com.slopus.happy.ui.components

import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProgressIndicatorDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CoroutineScope

/** An outgoing page may still be STARTED for drawing, but must not intercept the next page's input. */
val LocalPageActive = compositionLocalOf { true }

@Composable
fun PageBackHandler(enabled: Boolean = true, onBack: () -> Unit) {
    androidx.activity.compose.BackHandler(enabled && LocalPageActive.current, onBack)
}

/** A covered page retains its dialog state, not a separate window over the foreground page. */
@Composable
fun PageDialog(onDismissRequest: () -> Unit, properties: DialogProperties = DialogProperties(), content: @Composable () -> Unit) {
    if (LocalPageActive.current) Dialog(onDismissRequest, properties, content)
}

@Composable
fun PagePopup(popupPositionProvider: PopupPositionProvider, onDismissRequest: (() -> Unit)? = null, properties: PopupProperties = PopupProperties(), content: @Composable () -> Unit) {
    if (LocalPageActive.current) Popup(popupPositionProvider, onDismissRequest, properties, content)
}

/** The entry, not merely the activity, must be visible before page-owned work runs. */
@Composable
fun pageStarted(): Boolean {
    val state by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    return state.isAtLeast(Lifecycle.State.STARTED)
}

/** Restarts observation on reveal; accepted user mutations belong to a separate scope. */
@Composable
fun StartedEffect(vararg keys: Any?, block: suspend CoroutineScope.() -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val current by rememberUpdatedState(block)
    LaunchedEffect(lifecycle, *keys) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { current() }
    }
}

/** Material's same spinner while visible; a static, same-sized arc while covered. */
@Composable
fun PageProgressIndicator(
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
    strokeWidth: Dp = ProgressIndicatorDefaults.CircularStrokeWidth,
) {
    if (pageStarted()) CircularProgressIndicator(modifier, color, strokeWidth)
    else CircularProgressIndicator(progress = { .25f }, modifier = modifier, color = color, strokeWidth = strokeWidth)
}