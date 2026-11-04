package com.slopus.happy.ui.attach

import android.content.pm.PackageManager
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.core.app.ActivityOptionsCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.camera.PhotoTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AttachCameraTest {
    @get:Rule val rule = createComposeRule()

    @Test fun `without a camera opening says why and never asks for camera permission`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        // Hardware features alone are insufficient: the emulator keeps these with cameras disabled.
        shadowOf(context.packageManager).setSystemFeature(PackageManager.FEATURE_CAMERA_ANY, true)
        val requests = mutableListOf<Any?>()
        val registry = object : ActivityResultRegistry() {
            override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {
                requests += input
            }
        }
        val registryOwner = object : ActivityResultRegistryOwner { override val activityResultRegistry = registry }
        rule.setHappyContent {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides registryOwner) {
                val state = remember { AttachCameraState() }
                Box {
                    TextButton(onClick = { state.open() }) { Text("Open test camera") }
                    AttachCamera(state, visible = false, maxBytes = 10_000_000, hasRoom = { true }, onPhoto = {}, onFinished = {})
                }
            }
        }
        rule.onNodeWithText("Open test camera").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("This device has no camera.").fetchSemanticsNodes().isNotEmpty() }
        rule.node(PhotoTags.SHUTTER).assertIsNotEnabled()
        assertTrue("no permission or settings activity was launched", requests.isEmpty())
    }
}
