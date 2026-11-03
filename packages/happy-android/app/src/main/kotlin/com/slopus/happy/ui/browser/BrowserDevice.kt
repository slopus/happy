package com.slopus.happy.ui.browser

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.slopus.happy.R
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.PageBackHandler

/**
 * What a page asks of the phone itself, which WKWebView answers natively
 * and Android's WebView leaves to the app: a file for `<input type=file>`,
 * the camera or microphone, and full screen for a video. Its answers go
 * back to WebView through the callbacks kept here. Main thread only.
 */
@Stable
class BrowserDevice internal constructor() {
    /** A page asking for the camera or microphone, until it is answered. */
    internal var asking by mutableStateOf<Ask?>(null)
    /** A video in full screen, and how to leave it. */
    internal var fullscreen by mutableStateOf<Pair<View, WebChromeClient.CustomViewCallback>?>(null)
    internal var choose: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Boolean = { _, _ -> false }
    internal var request: (PermissionRequest, Array<String>) -> Unit = { request, _ -> request.deny() }
    /** Each origin's answer, for as long as the page is open (Telegram asks again on each visit; desktop 2305465f keeps it per profile, ours lives as long as the page). */
    private val decided = HashMap<String, Boolean>()

    /** A request for [camera] and/or [microphone] by [host], and the system permissions each needs. */
    class Ask(val request: PermissionRequest, val host: String, val camera: Boolean, val microphone: Boolean) {
        val key: String get() = "${request.origin}|$camera|$microphone"
        val permissions: Array<String> get() = listOfNotNull(Manifest.permission.CAMERA.takeIf { camera }, Manifest.permission.RECORD_AUDIO.takeIf { microphone }).toTypedArray()
    }

    /**
     * Telegram's BotWebViewContainer (onPermissionRequest,
     * BotWebViewContainer.java:4811): only the camera and microphone are
     * asked about; anything else a page asks for is refused.
     */
    internal fun permission(request: PermissionRequest) {
        val camera = PermissionRequest.RESOURCE_VIDEO_CAPTURE in request.resources
        val microphone = PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources
        if (!camera && !microphone) return request.deny()
        val ask = Ask(request, request.origin?.host?.takeIf { it.isNotEmpty() } ?: request.origin.toString(), camera, microphone)
        when (decided[ask.key]) {
            false -> request.deny()
            true -> this.request(request, ask.permissions)
            null -> {
                asking?.request?.deny()
                asking = ask
            }
        }
    }

    internal fun canceled(request: PermissionRequest) {
        if (asking?.request === request) asking = null
    }

    internal fun answer(allowed: Boolean) {
        val ask = asking ?: return
        asking = null
        decided[ask.key] = allowed
        if (allowed) request(ask.request, ask.permissions) else ask.request.deny()
    }
}

/**
 * Wires [device] to the activity: the system's file picker and permission
 * prompts, the camera/microphone question over the page, and a full-screen
 * video over the whole window with the system bars hidden; back leaves it.
 */
@Composable
internal fun BrowserDeviceHost(device: BrowserDevice) {
    val context = LocalContext.current
    var files by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = files ?: return@rememberLauncherForActivityResult
        files = null
        callback.onReceiveValue(chosen(result.resultCode, result.data))
    }
    var granting by remember { mutableStateOf<PermissionRequest?>(null) }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        val request = granting ?: return@rememberLauncherForActivityResult
        granting = null
        if (results.isNotEmpty() && results.values.all { it }) request.grant(request.resources.filter(::isMedia).toTypedArray()) else request.deny()
    }
    device.choose = { callback, params ->
        files?.onReceiveValue(null)
        val intent = params.createIntent().addCategory(Intent.CATEGORY_OPENABLE)
        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        try {
            files = callback
            picker.launch(intent)
            true
        } catch (_: ActivityNotFoundException) {
            files = null
            false
        }
    }
    device.request = { request, needed ->
        val missing = needed.filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) {
            request.grant(request.resources.filter(::isMedia).toTypedArray())
        } else {
            granting?.deny()
            granting = request
            permissions.launch(missing.toTypedArray())
        }
    }
    DisposableEffect(device) {
        onDispose {
            files?.onReceiveValue(null)
            granting?.deny()
            device.asking?.request?.deny()
            device.fullscreen?.second?.onCustomViewHidden()
        }
    }

    device.asking?.let { ask ->
        val title = when {
            ask.camera && ask.microphone -> stringResource(R.string.browser_permission_camera_microphone, ask.host)
            ask.camera -> stringResource(R.string.browser_permission_camera, ask.host)
            else -> stringResource(R.string.browser_permission_microphone, ask.host)
        }
        HappyAlert(
            Alert(
                title,
                stringResource(R.string.browser_permission_message, ask.host),
                listOf(
                    AlertButton(stringResource(R.string.browser_dont_allow)) { device.answer(false) },
                    AlertButton(stringResource(R.string.browser_allow)) { device.answer(true) },
                ),
                // Answered by a button only, as iOS's alert is: a dismissal runs before the button's action.
                cancelable = false,
            ),
            onDismiss = {},
        )
    }

    val shown = device.fullscreen
    PageBackHandler(enabled = shown != null) { shown?.second?.onCustomViewHidden() }
    DisposableEffect(shown) {
        val activity = context.activity() ?: return@DisposableEffect onDispose {}
        val (view, _) = shown ?: return@DisposableEffect onDispose {}
        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        val frame = FrameLayout(activity).apply {
            setBackgroundColor(Color.BLACK)
            addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        root.addView(frame, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val bars = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        bars.hide(WindowInsetsCompat.Type.systemBars())
        onDispose {
            bars.show(WindowInsetsCompat.Type.systemBars())
            frame.removeAllViews()
            root.removeView(frame)
        }
    }
}

private fun isMedia(resource: String) = resource == PermissionRequest.RESOURCE_VIDEO_CAPTURE || resource == PermissionRequest.RESOURCE_AUDIO_CAPTURE

/** What the picker returned: every pick of a multiple choice, else its one (Telegram's onActivityResultFragment, BotWebViewContainer.java:800). */
private fun chosen(resultCode: Int, data: Intent?): Array<Uri>? {
    if (resultCode != Activity.RESULT_OK || data == null) return null
    data.clipData?.let { clip -> return Array(clip.itemCount) { clip.getItemAt(it).uri } }
    return data.data?.let { arrayOf(it) }
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}
