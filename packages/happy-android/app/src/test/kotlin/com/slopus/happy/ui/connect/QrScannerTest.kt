package com.slopus.happy.ui.connect

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityOptionsCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Our QR scanner: its result plumbing, the camera permission, and the screen's spec. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class QrScannerTest {
    @get:Rule
    val rule = createComposeRule()

    private val denied = "Camera permissions are required to scan QR codes"

    @Test
    fun aPhoneWithoutACameraFailsAtOnce() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        shadowOf(context.packageManager).setSystemFeature(PackageManager.FEATURE_CAMERA_ANY, false)
        val result = runBlocking { CameraQrScanner(context).scan() }
        assertTrue(result is ScanResult.Failed)
    }

    @Test
    fun theActivityResultBecomesAScanResult() {
        val contract = QrScannerActivity.Contract
        assertEquals(
            ScanResult.Scanned("happy://terminal?abc"),
            contract.parseResult(Activity.RESULT_OK, Intent().putExtra(QrScannerActivity.EXTRA_VALUE, "happy://terminal?abc")),
        )
        assertEquals(ScanResult.Cancelled, contract.parseResult(Activity.RESULT_CANCELED, null))
        assertEquals(
            ScanResult.Failed("no camera"),
            contract.parseResult(QrScannerActivity.RESULT_FAILED, Intent().putExtra(QrScannerActivity.EXTRA_FAILURE, "no camera")),
        )
    }

    /** Refusing the camera leaves the scanner open, saying why, with the way to settings; back cancels. */
    @Test
    fun aRefusedCameraSaysSoAndBackCancels() {
        val asked = mutableListOf<Any?>()
        val registry = object : ActivityResultRegistry() {
            override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {
                asked += input
                dispatchResult(requestCode, false)
            }
        }
        val owner = object : ActivityResultRegistryOwner {
            override val activityResultRegistry = registry
        }
        val results = mutableListOf<ScanResult>()
        rule.setHappyContent(dark = true) {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides owner) {
                QrScannerRoute(onResult = { results += it })
            }
        }
        rule.waitForIdle()
        assertEquals(listOf<Any?>(android.Manifest.permission.CAMERA), asked)
        rule.onNodeWithText(denied).assertExists()
        rule.onNodeWithText("Open Settings").assertExists()
        rule.node(QrScannerTags.VIEWFINDER).assertDoesNotExist()
        assertTrue(results.isEmpty())
        rule.onNodeWithContentDescription("Close").performClick()
        assertEquals(listOf<ScanResult>(ScanResult.Cancelled), results)
    }

    @Test
    fun theDeniedScreenOpensSettings() {
        var settings = 0
        rule.setHappyContent(dark = true) {
            QrScannerScreen(CameraAccess.Denied, torchOn = null, onTorch = {}, onBack = {}, onOpenSettings = { settings++ }) {}
        }
        rule.onNodeWithText("Open Settings").performClick()
        assertEquals(1, settings)
    }

    @Test
    fun scannerSpec() {
        var torches = 0
        rule.setHappyContent(dark = true) {
            QrScannerScreen(CameraAccess.Granted, torchOn = false, onTorch = { torches++ }, onBack = {}, onOpenSettings = {}) {}
        }
        // No header: the camera fills the window, the close button floats top right.
        rule.node(HeaderTags.BAR).assertDoesNotExist()
        assertBox("camera", rule.node(QrScannerTags.CAMERA).bounds, 0.dp, 0.dp, 411.dp, 891.dp)
        assertBox("close", rule.node(QrScannerTags.CLOSE).bounds, 351.dp, 10.dp, 44.dp, 44.dp)
        // 260 square, centred in the window.
        assertBox("viewfinder", rule.node(QrScannerTags.VIEWFINDER).bounds, 75.5.dp, 315.5.dp, 260.dp, 260.dp)
        val hint = rule.node(QrScannerTags.HINT).bounds
        assertBox("hint", hint, 0.dp, 599.5.dp, 411.dp, hint.bottom - hint.top)
        rule.onNodeWithText("Point the camera at the QR code").assertExists()
        assertBox("torch", rule.node(QrScannerTags.TORCH).bounds, 177.5.dp, 803.dp, 56.dp, 56.dp)
        rule.onNodeWithContentDescription("Turn on flashlight").performClick()
        assertEquals(1, torches)
    }

    @Test
    fun noFlashNoTorch() {
        rule.setHappyContent(dark = true) {
            QrScannerScreen(CameraAccess.Granted, torchOn = null, onTorch = {}, onBack = {}, onOpenSettings = {}) {}
        }
        rule.node(QrScannerTags.TORCH).assertDoesNotExist()
    }

    @Test
    fun theSquareShrinksToFitAndNeverBelow120() {
        assertEquals(260.dp, viewfinderSide(411.dp, 891.dp))
        assertEquals(204.dp, viewfinderSide(300.dp, 891.dp))
        assertEquals(120.dp, viewfinderSide(891.dp, 300.dp))
    }
}
