package com.slopus.happy.ui.connect

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Links from outside the app, routed as expo-router routes them for happy-app. */
@RunWith(AndroidJUnit4::class)
class DeepLinksTest {
    private val key = "Q2xpZW50LXB1YmxpYy1rZXktZm9yLXRlc3RzLTEyMw"

    @After
    fun tearDown() {
        DeepLinks.pending.value?.let(DeepLinks::consume)
    }

    @Test
    fun theTerminalSchemeOpensTheConfirmScreen() {
        assertEquals(DeepLink.Terminal(key), parseDeepLink("happy://terminal?$key"))
        assertEquals(DeepLink.Terminal(key), parseDeepLink("happy:///terminal?$key"))
        assertEquals(DeepLink.Terminal(key), parseDeepLink("  happy://terminal?$key&extra=1  "))
        // The first search parameter's name is the key, whatever its value.
        assertEquals(DeepLink.Terminal(key), parseDeepLink("happy://terminal?$key="))
        // No key: the screen says the link is invalid.
        assertEquals(DeepLink.Terminal(null), parseDeepLink("happy://terminal"))
        assertEquals(DeepLink.Terminal(null), parseDeepLink("happy://terminal?"))
    }

    @Test
    fun productionAppLinksMapToTheSamePaths() {
        assertEquals(DeepLink.Terminal(key), parseDeepLink("https://app.happy.engineering/terminal?$key"))
        assertEquals(DeepLink.TerminalWeb, parseDeepLink("https://app.happy.engineering/terminal/connect#key=$key"))
        assertEquals(DeepLink.Session("abc 1"), parseDeepLink("https://app.happy.engineering/session/abc%201"))
        assertEquals(DeepLink.Session("s1"), parseDeepLink("happy://session/s1"))
    }

    @Test
    fun anythingElseIsIgnored() {
        listOf(
            "https://example.com/terminal?$key",
            "http://app.happy.engineering/terminal?$key",
            "happy:///account?$key",
            "happy://settings",
            "https://app.happy.engineering/",
            "mailto:someone@example.com",
            "not a url",
            "",
        ).forEach { assertNull(it, parseDeepLink(it)) }
    }

    @Test
    fun viewIntentsWaitInTheInboxUntilTaken() {
        assertFalse(DeepLinks.offer(Intent(Intent.ACTION_MAIN)))
        assertFalse(DeepLinks.offer(Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"))))
        assertNull(DeepLinks.pending.value)

        assertTrue(DeepLinks.offer(Intent(Intent.ACTION_VIEW, Uri.parse("happy://terminal?$key"))))
        val link = DeepLinks.pending.value!!
        assertEquals(DeepLink.Terminal(key), link)
        assertTrue(DeepLinks.consume(link))
        assertFalse(DeepLinks.consume(link))
        assertNull(DeepLinks.pending.value)
    }
}
