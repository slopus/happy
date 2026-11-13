package com.slopus.happy.ui.photoedit

import android.graphics.Bitmap
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import com.slopus.happy.ui.components.WindowDialog
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.max

/** The two edits a photo takes here: Telegram's crop and its drawing. */
enum class PhotoEditMode { Crop, Draw }

/**
 * A photo's crop or drawing over everything, on black in either theme,
 * fading in over 200 ms as Telegram's editing does. [photo] is the photo
 * upright, as its edit is measured; a spinner holds its place while it is
 * read. ✕ or Back leaves [edit] as it was ([onCancel]); ✓ gives it back
 * changed ([onDone]).
 */
@Composable
fun PhotoEditor(
    photo: Bitmap?,
    edit: PhotoEdit?,
    mode: PhotoEditMode,
    saving: Boolean = false,
    onCancel: () -> Unit,
    onDone: (PhotoEdit) -> Unit,
) {
    WindowDialog(onDismissRequest = onCancel, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect {
            window?.setDimAmount(0f)
            window?.setWindowAnimations(0)
            window?.let { WindowCompat.getInsetsController(it, it.decorView).isAppearanceLightStatusBars = false }
            window?.let { WindowCompat.getInsetsController(it, it.decorView).isAppearanceLightNavigationBars = false }
        }
        val shown = remember { Animatable(0f) }
        LaunchedEffect(Unit) { shown.animateTo(1f, tween(200, easing = PhotoEditSpec.easing)) }
        HappyTheme(preference = ThemePreference.Dark) {
            Box(Modifier.fillMaxSize().graphicsLayer { alpha = shown.value }.background(Color.Black).testTag(PhotoEditTags.EDITOR)) {
                if (photo == null) {
                    CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(24.dp).align(Alignment.Center))
                } else {
                    val start = edit ?: PhotoEdit(PhotoCrop.whole(photo.width, photo.height))
                    when (mode) {
                        PhotoEditMode.Crop -> {
                            // The drawing turns and is cut with the photo.
                            val configuration = LocalConfiguration.current
                            val pixels = with(LocalDensity.current) { max(configuration.screenWidthDp, configuration.screenHeightDp).dp.roundToPx() }.coerceIn(1280, 2048)
                            val preview by produceState<Bitmap?>(null, photo, start.strokes, pixels) {
                                value = withContext(Dispatchers.Default) { PhotoPainting.preview(photo, start.strokes, pixels) }
                            }
                            preview?.let {
                                PhotoCropScreen(photo, it, start.crop, onCancel, onDone = { onDone(start.copy(crop = it)) })
                            } ?: run {
                                CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(24.dp).align(Alignment.Center))
                            }
                        }
                        PhotoEditMode.Draw -> PhotoDrawScreen(photo, start, onCancel, onDone = { onDone(start.copy(strokes = it)) })
                    }
                }
                if (saving) {
                    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.3f)).clickable(interactionSource = null, indication = null) {}, contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                    }
                }
            }
        }
    }
}
