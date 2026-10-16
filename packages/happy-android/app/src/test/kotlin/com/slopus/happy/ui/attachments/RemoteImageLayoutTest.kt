package com.slopus.happy.ui.attachments

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import coil3.ImageLoader
import coil3.intercept.Interceptor
import coil3.request.ErrorResult
import coil3.request.ImageResult
import coil3.test.FakeImage
import coil3.test.FakeImageLoaderEngine
import com.slopus.happy.model.Profile
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.components.Avatar
import com.slopus.happy.ui.components.LocalImageLoader
import com.slopus.happy.ui.components.MarkdownImage
import com.slopus.happy.ui.components.MarkdownImageTags
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.RemoteImageState
import com.slopus.happy.ui.components.RemoteImageTags
import com.slopus.happy.ui.components.isRemoteImageUrl
import com.slopus.happy.ui.node
import com.slopus.happy.ui.settings.ProfileAvatar
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

/** The shared image loader's three users: profile pictures, markdown images, and its own states. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class RemoteImageLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val requested = CopyOnWriteArrayList<Any>()
    private val broken = "https://example.com/broken.png"

    private val loader = ImageLoader.Builder(ApplicationProvider.getApplicationContext())
        .components {
            add(
                FakeImageLoaderEngine.Builder()
                    .intercept({ it == broken }, object : FakeImageLoaderEngine.OptionalInterceptor {
                        override suspend fun intercept(chain: Interceptor.Chain): ImageResult = ErrorResult(null, chain.request, IOException("404"))
                    })
                    .intercept({ requested += it; false }, FakeImage())
                    .default(FakeImage(width = 64, height = 64))
                    .build(),
            )
        }
        .build()

    @Test
    fun onlyHttpUrlsAreRemote() {
        assertTrue(isRemoteImageUrl("https://avatars.githubusercontent.com/u/1"))
        assertTrue(isRemoteImageUrl("HTTP://x/y.png"))
        listOf(null, "data:image/png;base64,AAAA", "file:///x.jpg", "/relative.png").forEach { assertFalse("$it", isRemoteImageUrl(it)) }
    }

    @Test
    fun statesAreReported() {
        val states = CopyOnWriteArrayList<RemoteImageState>()
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box {
                    RemoteImage("https://example.com/a.png", null, Modifier.size(10.dp), onState = { states += it })
                }
            }
        }
        rule.waitUntil(5_000) { RemoteImageState.Success in states }
    }

    @Test
    fun errorsAreReported() {
        val states = CopyOnWriteArrayList<RemoteImageState>()
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box { RemoteImage(broken, null, Modifier.size(10.dp), onState = { states += it }) }
            }
        }
        rule.waitUntil(5_000) { RemoteImageState.Error in states }
    }

    @Test
    fun theProfilePictureLoadsByUrl() {
        val profile = Profile(
            id = "account-1", timestamp = 0, firstName = "Ada", lastName = null, avatar = null,
            github = null, connectedServices = emptyList(),
        )
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                ProfileAvatar(profile.copy(avatar = com.slopus.happy.model.ImageRef(1.0, 1.0, "", "p", "https://cdn.example/a.jpg")), 90.dp)
            }
        }
        rule.waitUntil(5_000) { "https://cdn.example/a.jpg" in requested }
        assertBox("picture", rule.node(RemoteImageTags.IMAGE).getUnclippedBoundsInRoot(), 0.dp, 0.dp, 90.dp, 90.dp)
    }

    @Test
    fun aGeneratedAvatarLoadsNothing() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) { Avatar(id = "x", size = 48.dp) }
        }
        rule.waitForIdle()
        rule.node(RemoteImageTags.IMAGE).assertDoesNotExist()
    }

    @Test
    fun markdownImagesFillUpTo520() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box(Modifier.fillMaxWidth()) { MarkdownImage("A diagram", "https://example.com/d.png") }
            }
        }
        rule.waitUntil(5_000) { "https://example.com/d.png" in requested }
        val block = rule.node(MarkdownImageTags.BLOCK).getUnclippedBoundsInRoot()
        val image = rule.node(RemoteImageTags.IMAGE).getUnclippedBoundsInRoot()
        val caption = rule.node(MarkdownImageTags.CAPTION).getUnclippedBoundsInRoot()
        // 411 wide phone: the whole width; 8 above, 240 high, 8 to the caption.
        assertBox("image", image, 0.dp, 8.dp, 411.dp, 240.dp)
        assertEquals(image.bottom + 8.dp, caption.top)
        assertEquals(caption.bottom, block.bottom)
    }

    @Test
    fun markdownImagesStopAt520AndHaveNoCaptionWithoutAlt() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides loader) {
                Box(Modifier.wrapContentWidth(unbounded = true).requiredWidth(700.dp)) { MarkdownImage("", "https://example.com/e.png") }
            }
        }
        rule.waitUntil(5_000) { "https://example.com/e.png" in requested }
        assertEquals(520.dp, rule.node(RemoteImageTags.IMAGE).getUnclippedBoundsInRoot().let { it.right - it.left })
        rule.node(MarkdownImageTags.CAPTION).assertDoesNotExist()
    }
}
