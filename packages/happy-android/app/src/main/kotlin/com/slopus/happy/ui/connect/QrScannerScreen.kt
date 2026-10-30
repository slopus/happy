package com.slopus.happy.ui.connect

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.theme.happyTextStyle

/** Where the camera stands: being asked for, allowed, or refused. */
enum class CameraAccess { Asking, Granted, Denied }

object QrScannerTags {
    const val CAMERA = "qrScanner.camera"
    const val CLOSE = "qrScanner.close"
    const val VIEWFINDER = "qrScanner.viewfinder"
    const val HINT = "qrScanner.hint"
    const val TORCH = "qrScanner.torch"
    const val DENIED = "qrScanner.denied"
}

/** Our scanner's own design; happy-app shows Google Code Scanner's. */
object QrScannerSpec {
    val viewfinderMax = 260.dp
    val viewfinderMin = 120.dp

    /** The square keeps this much to either side, and half this above and below. */
    val viewfinderInset = 48.dp
    val viewfinderRadius = 24.dp
    val viewfinderStroke = 2.dp
    val closeSize = 44.dp
    val closeIcon = 24.dp
    val closeTop = 10.dp
    val closeEnd = 16.dp
    val hintGap = 24.dp
    val hintPadding = 32.dp
    val hint = happyTextStyle(fontSize = 15, lineHeight = 20)
    val torchSize = 56.dp
    val torchIcon = 26.dp
    val torchBottom = 32.dp
    val scrim = Color(0x80000000)
    val button = Color.White.copy(alpha = 0.2f)
    val deniedPadding = 32.dp
    val deniedGap = 24.dp
    val denied = happyTextStyle(fontSize = 17, lineHeight = 24)
}

/**
 * Spec: no header (Steve's call for the scanner: rule 5's exception). The
 * camera fills the window edge to edge, under the transparent status and
 * navigation bars, black until it shows. A 44 round close button (white
 * 20%, white 24 ✕) sits 10 below the status bar and 16 from the right; it
 * does what back does. Over the camera a 50% black scrim with a square cut
 * out, centred in the window: side min(260, width − 96, height − 48 × 2 −
 * 144), at least 120, its 2 white border rounded 24. The hint (15/20, white
 * 80%) is centred 24 below the square, 32 in from the sides. With a flash,
 * a 56 round torch button (white 20%, white 26 bolt, filled while on) sits
 * centred 32 above the navigation bar. Without the camera permission: no
 * scrim, the message (17/24, white, centred, 32 in) and Open Settings 24
 * under it, centred vertically. [torchOn] is null when the camera has no
 * flash.
 */
@Composable
fun QrScannerScreen(
    access: CameraAccess,
    torchOn: Boolean?,
    onTorch: () -> Unit,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    preview: @Composable () -> Unit,
) {
    BoxWithConstraints(modifier = Modifier.fillMaxSize().background(Color.Black).testTag(QrScannerTags.CAMERA)) {
        when (access) {
            CameraAccess.Asking -> Unit
            CameraAccess.Denied -> Denied(onOpenSettings)
            CameraAccess.Granted -> {
                preview()
                val side = viewfinderSide(maxWidth, maxHeight)
                Canvas(modifier = Modifier.fillMaxSize()) {
                    val s = side.toPx()
                    val hole = RoundRect(
                        left = (size.width - s) / 2,
                        top = (size.height - s) / 2,
                        right = (size.width + s) / 2,
                        bottom = (size.height + s) / 2,
                        cornerRadius = CornerRadius(QrScannerSpec.viewfinderRadius.toPx()),
                    )
                    clipPath(Path().apply { addRoundRect(hole) }, clipOp = ClipOp.Difference) {
                        drawRect(QrScannerSpec.scrim, topLeft = Offset.Zero, size = size)
                    }
                }
                Box(
                    modifier = Modifier
                        .align(Alignment.Center)
                        .size(side)
                        .testTag(QrScannerTags.VIEWFINDER)
                        .border(QrScannerSpec.viewfinderStroke, Color.White, RoundedCornerShape(QrScannerSpec.viewfinderRadius)),
                )
                Text(
                    text = stringResource(R.string.scan_hint),
                    style = QrScannerSpec.hint,
                    color = Color.White.copy(alpha = 0.8f),
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .offset(y = (maxHeight + side) / 2 + QrScannerSpec.hintGap)
                        .fillMaxWidth()
                        .testTag(QrScannerTags.HINT)
                        .padding(horizontal = QrScannerSpec.hintPadding),
                )
                if (torchOn != null) {
                    RoundIconButton(
                        icon = if (torchOn) Ionicon.Flash else Ionicon.FlashOutline,
                        iconSize = QrScannerSpec.torchIcon,
                        contentDescription = stringResource(if (torchOn) R.string.scan_torch_off else R.string.scan_torch_on),
                        role = Role.Switch,
                        onClick = onTorch,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .windowInsetsPadding(WindowInsets.navigationBars)
                            .padding(bottom = QrScannerSpec.torchBottom)
                            .size(QrScannerSpec.torchSize)
                            .testTag(QrScannerTags.TORCH),
                    )
                }
            }
        }
        RoundIconButton(
            icon = Ionicon.Close,
            iconSize = QrScannerSpec.closeIcon,
            contentDescription = stringResource(R.string.scan_close),
            role = Role.Button,
            onClick = onBack,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .windowInsetsPadding(WindowInsets.statusBars)
                .padding(top = QrScannerSpec.closeTop, end = QrScannerSpec.closeEnd)
                .size(QrScannerSpec.closeSize)
                .testTag(QrScannerTags.CLOSE),
        )
    }
}

/** The square's side in a window of [width] × [height]. */
internal fun viewfinderSide(width: Dp, height: Dp): Dp {
    val roomBelow = 144.dp
    return minOf(
        QrScannerSpec.viewfinderMax,
        width - QrScannerSpec.viewfinderInset * 2,
        height - QrScannerSpec.viewfinderInset * 2 - roomBelow,
    ).coerceAtLeast(QrScannerSpec.viewfinderMin)
}

@Composable
private fun RoundIconButton(
    icon: Ionicon,
    iconSize: Dp,
    contentDescription: String,
    role: Role,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(QrScannerSpec.button)
            .clickable(role = role, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon = icon, size = iconSize, color = Color.White, contentDescription = contentDescription)
    }
}

@Composable
private fun Denied(onOpenSettings: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.systemBars)
            .padding(horizontal = QrScannerSpec.deniedPadding)
            .testTag(QrScannerTags.DENIED),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.modals_camera_permissions_required_to_scan_qr),
            style = QrScannerSpec.denied,
            color = Color.White,
            textAlign = TextAlign.Center,
        )
        Spacer(modifier = Modifier.height(QrScannerSpec.deniedGap))
        RoundButton(title = stringResource(R.string.scan_open_settings), onClick = onOpenSettings)
    }
}
