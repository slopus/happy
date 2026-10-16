package com.slopus.happy.ui.components

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import coil3.ImageLoader
import coil3.intercept.Interceptor
import coil3.request.ImageResult
import coil3.test.FakeImage
import coil3.test.FakeImageLoaderEngine
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.awaitCancellation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Avatar.tsx's `placeholder={{ thumbhash }}`: the hash stands in while the picture loads. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ThumbHashPlaceholderTest {
    @get:Rule
    val rule = createComposeRule()

    private val hanging = "https://example.com/slow.png"
    private val hash = "nvgJPJpwd3eAh4d3d4eAcAj4eA=="

    private val loader = ImageLoader.Builder(ApplicationProvider.getApplicationContext())
        .components {
            add(
                FakeImageLoaderEngine.Builder()
                    .intercept({ it == hanging }, object : FakeImageLoaderEngine.OptionalInterceptor {
                        override suspend fun intercept(chain: Interceptor.Chain): ImageResult = awaitCancellation()
                    })
                    .default(FakeImage(width = 64, height = 64))
                    .build(),
            )
        }
        .build()

    @Test
    fun theHashCoversTheAvatarWhileItLoads() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Avatar(id = "s", size = 48.dp, imageUri = hanging, thumbhash = hash)
            }
        }
        rule.waitUntil(5_000) { rule.node(RemoteImageTags.PLACEHOLDER).isDisplayedSafely() }
        assertBox("placeholder", rule.node(RemoteImageTags.PLACEHOLDER).getUnclippedBoundsInRoot(), 0.dp, 0.dp, 48.dp, 48.dp)
        // Drawn, not the surfaceHigh fill (#F8F8F8): the hash's own colour fills the middle.
        val pixels = rule.node(AvatarTags.AVATAR).captureToImage().toPixelMap()
        val middle = pixels[pixels.width / 2, pixels.height / 2]
        assertEquals(1f, middle.alpha, 0.01f)
        assertNotEquals(Color(0xFFF8F8F8), middle)
    }

    @Test
    fun theHashGoesOnceThePictureLands() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Avatar(id = "s", size = 48.dp, imageUri = "https://example.com/fast.png", thumbhash = hash)
            }
        }
        rule.waitUntil(5_000) { !rule.node(RemoteImageTags.PLACEHOLDER).isDisplayedSafely() && rule.node(RemoteImageTags.IMAGE).isDisplayedSafely() }
    }

    @Test
    fun noHashNoPlaceholder() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Avatar(id = "s", size = 48.dp, imageUri = hanging)
            }
        }
        rule.waitForIdle()
        rule.node(RemoteImageTags.IMAGE).assertExists()
        rule.node(RemoteImageTags.PLACEHOLDER).assertDoesNotExist()
    }

    @Test
    fun aGeneratedAvatarIgnoresTheHash() {
        rule.setHappyContent { Avatar(id = "s", size = 48.dp, thumbhash = hash) }
        rule.waitForIdle()
        rule.node(AvatarTags.PLACEHOLDER).assertDoesNotExist()
        rule.node(RemoteImageTags.PLACEHOLDER).assertDoesNotExist()
    }

    private fun androidx.compose.ui.test.SemanticsNodeInteraction.isDisplayedSafely(): Boolean =
        runCatching { fetchSemanticsNode() }.isSuccess
}
