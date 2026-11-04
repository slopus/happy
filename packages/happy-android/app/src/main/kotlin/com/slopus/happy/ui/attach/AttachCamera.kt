package com.slopus.happy.ui.attach

import android.Manifest
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Range
import android.util.Size
import android.view.OrientationEventListener
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.compose.CameraXViewfinder
import androidx.camera.core.AspectRatio
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ExperimentalZeroShutterLag
import androidx.camera.core.ImageCapture
import androidx.camera.core.SurfaceRequest
import androidx.camera.core.UseCase
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.viewfinder.core.ImplementationMode
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.camera.CameraBinding
import com.slopus.happy.camera.CameraFailure
import com.slopus.happy.camera.CapturedPhoto
import com.slopus.happy.camera.PhotoExecutor
import com.slopus.happy.camera.PhotoFiles
import com.slopus.happy.camera.capturePhoto
import com.slopus.happy.camera.cameraPresent
import com.slopus.happy.ui.camera.PhotoCameraLayout
import com.slopus.happy.ui.camera.PhotoMotion
import com.slopus.happy.ui.camera.PhotoProblem
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.layout.LocalWindowLayout
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Sheet-owned geometry and navigation; the preview itself is retained in [AttachCamera]. */
@Stable
internal class AttachCameraState {
    var full by mutableStateOf(false)
    var tile by mutableStateOf<LayoutCoordinates?>(null)
    var tilePosition by mutableStateOf<Rect?>(null)
    var root by mutableStateOf<LayoutCoordinates?>(null)
    var frozen: Rect? = null
    var frozenClip: Rect? = null
    var viewportTop: () -> Float = { 0f }
    var back: () -> Unit = {}
    var open: () -> Unit = {}

    fun bounds(): Rect? {
        val cell = tile?.takeIf { it.isAttached } ?: return null
        val host = root?.takeIf { it.isAttached } ?: return null
        val at = cell.positionInWindow() - host.positionInWindow()
        return Rect(at, androidx.compose.ui.geometry.Size(cell.size.width.toFloat(), cell.size.height.toFloat()))
    }
}

/** One CameraX session from the two-row tile through full camera, with private capture ownership. */
@Composable
@androidx.annotation.OptIn(ExperimentalZeroShutterLag::class)
internal fun AttachCamera(
    state: AttachCameraState,
    visible: Boolean,
    maxBytes: Long,
    hasRoom: () -> Boolean,
    onPhoto: (AttachmentPreview) -> Unit,
    onFinished: () -> Unit,
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val reduce = rememberReduceMotion()
    val haptics = LocalHapticFeedback.current
    val tablet = LocalWindowLayout.current.isTablet
    val window = (LocalView.current.parent as? DialogWindowProvider)?.window
    val density = LocalDensity.current
    val bottom = WindowInsets.navigationBars.getBottom(density) + with(density) { AttachSpec.tabBar.toPx() }
    val photo by rememberUpdatedState(onPhoto)
    val finished by rememberUpdatedState(onFinished)
    val room by rememberUpdatedState(hasRoom)
    val motion = remember { PhotoMotion() }
    val firstFrame = remember { Animatable(0f) }
    val blink = remember { Animatable(0f) }
    val files = remember { PhotoFiles(File(context.cacheDir, "attachments/camera")) }
    var allowed by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var present by remember { mutableStateOf<Boolean?>(null) }
    var checked by remember { mutableStateOf(false) }
    LaunchedEffect(context) { present = cameraPresent(context); checked = true }
    var resumed by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var surface by remember { mutableStateOf<SurfaceRequest?>(null) }
    var camera by remember { mutableStateOf<Camera?>(null) }
    var cameraState by remember { mutableStateOf<CameraState?>(null) }
    var problem by remember { mutableStateOf<PhotoProblem?>(null) }
    var review by remember { mutableStateOf<CapturedPhoto?>(null) }
    var busy by remember { mutableStateOf(false) }
    var retry by remember { mutableStateOf(0) }
    var transition by remember { mutableStateOf<Job?>(null) }
    var capturing by remember { mutableStateOf<Job?>(null) }
    val resolution = remember { ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy(AspectRatio.RATIO_4_3, AspectRatioStrategy.FALLBACK_RULE_AUTO)).build() }
    val capture = remember {
        ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_ZERO_SHUTTER_LAG)
            .setResolutionSelector(ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                .setResolutionStrategy(ResolutionStrategy(Size(3072, 2304), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)).build())
            .setIoExecutor(PhotoExecutor).build()
    }
    val useCases = remember(capture, retry) { listOf<UseCase>(capture) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it }
    val settings = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        allowed = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            resumed = owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            if (event == Lifecycle.Event.ON_RESUME) {
                allowed = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                scope.launch { present = cameraPresent(context); checked = true }
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    DisposableEffect(files) { onDispose { PhotoExecutor.execute { files.close() } } }
    DisposableEffect(window, state.full) {
        val controller = window?.let { WindowInsetsControllerCompat(it, it.decorView) }
        val lightStatus = controller?.isAppearanceLightStatusBars
        val lightNavigation = controller?.isAppearanceLightNavigationBars
        val full = state.full
        if (full) { controller?.isAppearanceLightStatusBars = false; controller?.isAppearanceLightNavigationBars = false }
        onDispose {
            if (full) {
                lightStatus?.let { controller?.isAppearanceLightStatusBars = it }
                lightNavigation?.let { controller?.isAppearanceLightNavigationBars = it }
            }
        }
    }
    DisposableEffect(state.full, tablet) {
        val activity = context.cameraActivity()
        val old = activity?.requestedOrientation
        val locked = state.full && !tablet
        if (locked) activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        onDispose { if (locked && old != null) activity?.requestedOrientation = old }
    }
    fun visibleTile(): Rect? {
        if (!visible) return null
        state.tilePosition ?: return null
        val rect = state.bounds() ?: return null
        val height = state.root?.size?.height?.toFloat() ?: return null
        // A tile under the caption/tab bar is not a camera surface. Keep the full rect for
        // aspect fill, while its visible portion is clipped by the gallery below.
        return rect.takeIf { it.bottom > state.viewportTop() && it.top < height - bottom }
    }
    fun clip(rect: Rect): Rect = rect.copy(top = rect.top.coerceAtLeast(state.viewportTop()), bottom = rect.bottom.coerceAtMost((state.root?.size?.height ?: 0) - bottom))
    fun close() {
        if (!state.full || motion.closing) return
        capturing?.cancel()
        transition?.cancel()
        state.frozen = visibleTile()
        state.frozenClip = state.frozen?.let(::clip)
        transition = scope.launch {
            motion.close(visibleTile() != null, review != null, reduce)
            review?.let { captured -> PhotoExecutor.execute { files.discard(captured.directory) } }
            review = null
            state.full = false
            state.frozen = null
            state.frozenClip = null
            motion.collapsed()
        }
    }
    fun open() {
        if (state.full || !room()) return
        state.frozen = visibleTile()
        state.frozenClip = state.frozen?.let(::clip)
        state.full = true
        transition?.cancel()
        transition = scope.launch { motion.open(state.frozen != null, reduce) }
        if (!allowed) scope.launch {
            if (!checked) { present = cameraPresent(context); checked = true }
            if (state.full && present != false) permission.launch(Manifest.permission.CAMERA)
        }
    }
    SideEffect { state.open = ::open; state.back = ::close }
    BackHandler(state.full) { close() }
    val active = checked && resumed && allowed && present != false && review == null && (state.full || visibleTile() != null)
    if (active) {
        DisposableEffect(capture) {
            val orientation = object : OrientationEventListener(context) {
                override fun onOrientationChanged(angle: Int) {
                    if (angle != ORIENTATION_UNKNOWN) capture.targetRotation = UseCase.snapToSurfaceRotation(angle)
                }
            }
            if (orientation.canDetectOrientation()) orientation.enable()
            onDispose { orientation.disable() }
        }
        key(retry) { CameraBinding(
            useCases, onSurface = { surface = it }, onCamera = { camera = it },
            onFailure = { problem = if (it == CameraFailure.NoCamera) PhotoProblem.NoCamera else PhotoProblem.Unavailable },
            frameRate = remember { Range(30, 30) }, previewResolution = resolution,
            onState = { cameraState = it },
            onFirstFrame = { scope.launch { firstFrame.animateTo(1f, if (reduce) tween(0) else tween(300, 50, LinearEasing)) } },
        ) }
    }
    LaunchedEffect(active) { if (!active) firstFrame.snapTo(0f) else problem = null }
    val issue = when {
        present == false -> PhotoProblem.NoCamera
        !allowed -> PhotoProblem.Permission
        problem != null -> problem
        cameraState?.error != null -> if (cameraState?.error?.code == CameraState.ERROR_CAMERA_IN_USE || cameraState?.error?.code == CameraState.ERROR_MAX_CAMERAS_IN_USE) PhotoProblem.InUse else PhotoProblem.Unavailable
        else -> null
    }
    Box(Modifier.fillMaxSize().onGloballyPositioned { state.root = it }) {
        PhotoCameraLayout(
            state.full, motion, tile = { if (state.full) state.frozen else visibleTile() },
            ready = cameraState?.type == CameraState.Type.OPEN && firstFrame.value > 0 && issue == null,
            busy = busy, problem = issue, review = review?.attachment, firstFrame = { firstFrame.value }, blink = { blink.value },
            onOpen = ::open, onBack = ::close,
            onTake = {
                if (!busy && !motion.closing && room()) {
                    haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
                    busy = true
                    capturing = scope.launch {
                        try {
                            review = capturePhoto(capture, files, camera?.cameraInfo?.lensFacing == CameraSelector.LENS_FACING_FRONT, maxBytes) {
                                scope.launch { blink.snapTo(1f); blink.animateTo(0f, tween(250)) }
                            }
                        } catch (e: CancellationException) { throw e }
                        catch (_: Exception) { problem = PhotoProblem.CaptureFailed }
                        finally { busy = false }
                    }
                }
            },
            onRetake = { review?.let { captured -> PhotoExecutor.execute { files.discard(captured.directory) } }; review = null },
            onUse = {
                val captured = review
                if (captured != null && !motion.closing && room() && files.transfer(captured.directory)) {
                    photo(captured.attachment)
                    transition?.cancel()
                    transition = scope.launch { motion.use(reduce); finished() }
                }
            },
            onSettings = { settings.launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))) },
            onRetry = { problem = null; retry++ },
            preview = { surface?.let { CameraXViewfinder(it, implementationMode = ImplementationMode.EMBEDDED, modifier = Modifier.fillMaxSize()) } },
            tileClip = {
                if (state.full) state.frozenClip
                else visibleTile()?.let(::clip)
            },
        )
    }
}

private tailrec fun Context.cameraActivity(): ComponentActivity? = when (this) {
    is ComponentActivity -> this
    is ContextWrapper -> baseContext.cameraActivity()
    else -> null
}
