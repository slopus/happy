package com.slopus.happy.ui.layout

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.sqrt

enum class DeviceType { Phone, Tablet }

/**
 * utils/deviceCalculations.ts on Android: a dp is 1/160 inch, and a window
 * 9 inches or more across is a tablet. Foldables (7–8 inches unfolded) stay
 * phones. This only sizes content ([ContentWidth]); the tablet shell follows
 * [TabletBreakpoint].
 */
object DeviceCalculations {
    const val POINTS_PER_INCH = 160f
    const val TABLET_THRESHOLD_INCHES = 9f

    data class Dimensions(val widthInches: Float, val heightInches: Float, val diagonalInches: Float)

    /** `calculateDeviceDimensions`. */
    fun dimensions(widthPoints: Float, heightPoints: Float, pointsPerInch: Float = POINTS_PER_INCH): Dimensions {
        val width = widthPoints / pointsPerInch
        val height = heightPoints / pointsPerInch
        return Dimensions(width, height, sqrt(width * width + height * height))
    }

    /** `determineDeviceType` off iOS: tablets from the threshold up, inclusive. */
    fun deviceType(diagonalInches: Float, thresholdInches: Float = TABLET_THRESHOLD_INCHES): DeviceType =
        if (diagonalInches >= thresholdInches) DeviceType.Tablet else DeviceType.Phone

    /** `useDeviceType`: the window in dp. */
    fun deviceType(width: Dp, height: Dp): DeviceType = deviceType(dimensions(width.value, height.value).diagonalInches)

    /** `calculateHeaderHeight` on Android: a phone on its side gets the 48 bar, everything else 64. */
    fun headerHeight(deviceType: DeviceType, isLandscape: Boolean): Dp =
        if (deviceType == DeviceType.Phone && isLandscape) 48.dp else 64.dp
}

/**
 * responsive.ts `useIsTablet`: the tablet layout is a window rule, not a
 * device class. Width alone, so a keyboard shrinking the window never folds
 * the sidebar away. "At 768 logical pixels the sidebar is 250px and leaves
 * 518px for content."
 */
object TabletBreakpoint {
    val minWidth = 768.dp

    fun isTablet(windowWidth: Dp): Boolean = windowWidth >= minWidth

    /** `useIsLandscape`. */
    fun isLandscape(width: Dp, height: Dp): Boolean = width > height
}

/**
 * components/layout.ts: how wide content may grow. A phone gets its longest
 * side, so in effect no limit; a tablet ([DeviceCalculations]) gets 800.
 * Android has no Mac branch, so `maxWidth` and `headerMaxWidth` agree.
 */
object ContentWidth {
    val tablet = 800.dp

    fun maxWidth(deviceType: DeviceType, width: Dp, height: Dp): Dp =
        if (deviceType == DeviceType.Phone) maxOf(width, height) else tablet
}

/**
 * The window's answers to every responsive.ts and layout.ts question, read
 * through [LocalWindowLayout]. [ProvideWindowLayout] measures the window at
 * the root; without it (component tests, previews) a screen lays out as a
 * phone with no width limit.
 */
@Immutable
data class WindowLayout(
    val width: Dp,
    val height: Dp,
    val isTablet: Boolean,
    val isLandscape: Boolean,
    val deviceType: DeviceType,
    /** `layout.maxWidth`: the chat, the composer, item groups. */
    val contentMaxWidth: Dp,
    /** `useHeaderHeight`; on Android it takes the device type from [isTablet]. */
    val headerHeight: Dp,
) {
    /** `layout.headerMaxWidth`: the same as [contentMaxWidth] off the Mac. */
    val headerMaxWidth: Dp get() = contentMaxWidth

    companion object {
        fun of(width: Dp, height: Dp): WindowLayout {
            val isTablet = TabletBreakpoint.isTablet(width)
            val isLandscape = TabletBreakpoint.isLandscape(width, height)
            val deviceType = DeviceCalculations.deviceType(width, height)
            return WindowLayout(
                width = width,
                height = height,
                isTablet = isTablet,
                isLandscape = isLandscape,
                deviceType = deviceType,
                contentMaxWidth = ContentWidth.maxWidth(deviceType, width, height),
                headerHeight = DeviceCalculations.headerHeight(if (isTablet) DeviceType.Tablet else DeviceType.Phone, isLandscape),
            )
        }

        /** A portrait phone with no width limit. */
        val Unmeasured = WindowLayout(Dp.Infinity, Dp.Infinity, false, false, DeviceType.Phone, Dp.Infinity, 64.dp)
    }
}

val LocalWindowLayout = staticCompositionLocalOf { WindowLayout.Unmeasured }

/** Measures the window (the app draws edge to edge, so the root is the window) and provides it. */
@Composable
fun ProvideWindowLayout(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    BoxWithConstraints(modifier) {
        val layout = remember(maxWidth, maxHeight) { WindowLayout.of(maxWidth, maxHeight) }
        CompositionLocalProvider(LocalWindowLayout provides layout, content = content)
    }
}

/**
 * True under the tablet shell (SidebarNavigator.tsx `isDesktopLayout`): its
 * persistent header carries back, so screen headers drop their own.
 */
val LocalTabletShell = staticCompositionLocalOf { false }

/**
 * Holds a column to the content max width, centred (layout.ts `maxWidth`
 * under `alignItems: 'center'`): a no-op on a phone, 800 on a tablet.
 */
fun Modifier.contentMaxWidth(layout: WindowLayout): Modifier =
    fillMaxWidth().wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = layout.contentMaxWidth).fillMaxWidth()

/**
 * SessionView.tsx `CenteredInputWidth`: [horizontalPadding] on each side,
 * then the content held to the content max width, centred.
 */
@Composable
fun CenteredInputWidth(horizontalPadding: Dp, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val layout = LocalWindowLayout.current
    Box(modifier.fillMaxWidth().padding(horizontal = horizontalPadding)) {
        Box(Modifier.contentMaxWidth(layout)) { content() }
    }
}
