package com.slopus.happy.ui.connect

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.RestoreManualRoute
import com.slopus.happy.ui.RestoreRoute
import com.slopus.happy.ui.ServerRoute
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.files.MessageDetailRoute
import com.slopus.happy.ui.files.SessionChangesRoute
import com.slopus.happy.ui.files.SessionFileRoute
import com.slopus.happy.ui.home.NewSessionRoute
import com.slopus.happy.ui.machine.MachineRoute
import com.slopus.happy.ui.onboarding.OnboardingSettingsRoute
import com.slopus.happy.ui.onboarding.TroubleshootRoute
import com.slopus.happy.ui.session.SessionInfoRoute
import com.slopus.happy.ui.settings.AccountRoute
import com.slopus.happy.ui.settings.AgentsRoute
import com.slopus.happy.ui.settings.AppearanceRoute
import com.slopus.happy.ui.settings.ChangelogRoute
import com.slopus.happy.ui.settings.LanguageRoute
import com.slopus.happy.ui.voice.VoiceSettingsRoute
import com.slopus.happy.ui.voice.VoiceLanguageRoute
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

    /** happy-ios docs/APP-CLIP.md: only the exact invitation path is a guest chat; the host's other paths keep their routes. */
    @Test
    fun aBotInvitationOpensTheGuestChatAndNothingElseDoes() {
        val link = "https://app.happy.engineering/bot/invite/abcdefghijklmnop_123-456"
        assertEquals(DeepLink.GuestInvite(link), parseDeepLink(link))
        assertEquals("GuestInvite(…)", parseDeepLink(link).toString())
        assertEquals(DeepLink.Home, parseDeepLink("https://app.happy.engineering/bot/invite/short"))
        assertEquals(DeepLink.Home, parseDeepLink("$link/extra"))
        assertEquals(DeepLink.Home, parseDeepLink("$link?server=https://evil.example"))
        assertNull(parseDeepLink("https://evil.example/bot/invite/abcdefghijklmnop"))
        assertTrue(DeepLinks.offer(Intent(Intent.ACTION_VIEW, Uri.parse(link))))
        assertEquals(DeepLink.GuestInvite(link), DeepLinks.pending.value)
    }

    /** A Happy Cloud invite opens its Join screen, from the build's invite host; its token never prints. */
    @Test
    fun aCloudInviteOpensItsJoinScreen() {
        val token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"
        val host = com.slopus.happy.connection.HappyCloud.inviteHost!!
        val link = "https://$host/#$token"
        val invite = DeepLink.CloudServerInvite(com.slopus.happy.connection.CloudInvite(token))
        assertEquals(invite, parseDeepLink(link))
        assertEquals(invite, parseDeepLink("https://${com.slopus.happy.connection.HappyCloud.webHost}/join#$token"))
        assertEquals("CloudServerInvite(invite=CloudInvite(…))", parseDeepLink(link).toString())
        assertNull(parseDeepLink("https://$host/#short"))
        assertTrue(DeepLinks.offer(Intent(Intent.ACTION_VIEW, Uri.parse(link))))
        assertEquals(invite, DeepLinks.pending.value)
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
    fun pairingCodesOpenPairingAndNeverPrint() {
        val code = "happy://direct?eyJ2IjoxfQ"
        assertEquals(DeepLink.AgentPairing(code), parseDeepLink(" $code\n"))
        assertEquals(DeepLink.AgentPairing("HAPPY://direct?x"), parseDeepLink("HAPPY://direct?x"))
        assertFalse(DeepLink.AgentPairing(code).toString().contains("eyJ"))
        // Only the host itself: another path is an app path.
        assertEquals(DeepLink.Home, parseDeepLink("happy://directory"))
    }

    @Test
    fun productionAppLinksMapToTheSamePaths() {
        assertEquals(DeepLink.Terminal(key), parseDeepLink("https://app.happy.engineering/terminal?$key"))
        assertEquals(DeepLink.TerminalWeb, parseDeepLink("https://app.happy.engineering/terminal/connect#key=$key"))
        assertEquals(DeepLink.Session("abc 1"), parseDeepLink("https://app.happy.engineering/session/abc%201"))
        assertEquals(DeepLink.Session("s1"), parseDeepLink("happy://session/s1"))
    }

    @Test
    fun happyUrlsOpenFromOutsideOnlyLockedToTheirInstance() {
        val instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
        assertEquals(
            DeepLink.Instance(instance, com.slopus.happy.agent.HappyLink.Reference(com.slopus.happy.agent.HappyReferenceKind.Artifact, "abc123", version = 2)),
            parseDeepLink("happy://$instance/artifacts/abc123?version=2"),
        )
        assertEquals(
            DeepLink.Instance(instance, com.slopus.happy.agent.HappyLink.File(com.slopus.happy.agent.HappyLink.Target.Agent("a1"), "src/Foo.tsx", 42..50)),
            parseDeepLink("happy://$instance/agents/a1/files/src/Foo.tsx#L42-L50"),
        )
        // A settings link opens from outside in its instance form; unlocked, `happy://settings/…` is still happy-app's path.
        assertEquals(DeepLink.Instance(instance, com.slopus.happy.agent.HappyLink.Settings("providers")), parseDeepLink("happy://$instance/settings/providers"))
        assertNull(parseDeepLink("happy://$instance/settings/billing"))
        // Internal links, malformed ones and happy-file:// never open from outside, nor fall back to Home.
        listOf(
            "happy://artifacts/abc123",
            "happy://agents/a1/files/a.ts",
            "happy://workspaces/w1/services/s1",
            "happy://artifacts/",
            "happy://Surfaces/x",
            "happy-file://agents/a1/a.ts",
            "happy://$instance/",
            "happy://$instance/session/s1",
            "happy://${instance.uppercase()}/artifacts/abc123",
            // A team server's link is taken only from the app's own scanner (§8).
            "happy://$instance/server?url=https%3A%2F%2Fhappy.acme.example%2F",
        ).forEach { assertNull(it, parseDeepLink(it)) }
        // The mobile routes are untouched.
        assertEquals(DeepLink.Session("s1"), parseDeepLink("happy://session/s1"))
        assertEquals(DeepLink.Screen(SettingsRoute()), parseDeepLink("happy://settings"))
    }

    @Test
    fun linksThatArentTheAppsAreIgnored() {
        listOf(
            "https://example.com/terminal?$key",
            "http://app.happy.engineering/terminal?$key",
            "mailto:someone@example.com",
            "not a url",
            "",
        ).forEach { assertNull(it, parseDeepLink(it)) }
    }

    @Test
    fun everyAppScreenHasItsRoute() {
        fun screen(route: Any) = DeepLink.Screen(route)
        fun signedOut(route: Any) = DeepLink.Screen(route, signedOut = true)
        mapOf(
            "happy://session/s1/info" to screen(SessionInfoRoute("s1")),
            "https://app.happy.engineering/session/s1/changes?file=src%2Fa.kt" to screen(SessionChangesRoute("s1", "src/a.kt")),
            "happy://session/s1/changes" to screen(SessionChangesRoute("s1")),
            "happy://session/s1/message/m%202?file=b.kt" to screen(MessageDetailRoute("s1", "m 2", "b.kt")),
            "happy://session/s1/message/m1" to screen(MessageDetailRoute("s1", "m1")),
            "happy://machine/mac-1" to screen(MachineRoute("mac-1")),
            "happy://new?autoSubmit=1" to screen(NewSessionRoute),
            "happy://settings" to screen(SettingsRoute()),
            "happy://settings/account" to screen(AccountRoute()),
            "happy://settings/appearance" to screen(AppearanceRoute),
            "happy://settings/agents" to screen(AgentsRoute),
            "happy://settings/language" to screen(LanguageRoute()),
            "happy://settings/voice" to screen(VoiceSettingsRoute()),
            "happy://settings/voice/language" to screen(VoiceLanguageRoute),
            "happy://server" to signedOut(ServerRoute),
            "happy://restore" to signedOut(RestoreRoute),
            "happy://restore/manual" to signedOut(RestoreManualRoute),
            "happy://troubleshoot" to signedOut(TroubleshootRoute),
            "happy://changelog" to signedOut(ChangelogRoute),
            "happy://onboarding/settings" to signedOut(OnboardingSettingsRoute),
        ).forEach { (link, route) -> assertEquals(link, route, parseDeepLink(link)) }
        // The old Connect Claude page is gone; its link opens Home.
        assertEquals(DeepLink.Home, parseDeepLink("https://app.happy.engineering/settings/connect/claude"))
    }

    @Test
    fun filePathsAreBase64AsToolViewWritesThem() {
        // btoa("src/a+b.kt") = "c3JjL2ErYi5rdA==", sent without percent-encoding.
        assertEquals(
            DeepLink.Screen(SessionFileRoute("s1", "src/a+b.kt", 12, 3)),
            parseDeepLink("happy://session/s1/file?path=c3JjL2ErYi5rdA==&line=12&column=3"),
        )
        // btoa("src/a>b.kt") has a + that the query decodes to a space; it still decodes.
        assertEquals(DeepLink.Screen(SessionFileRoute("s1", "src/a>b.kt")), parseDeepLink("happy://session/s1/file?path=c3JjL2E+Yi5rdA%3D%3D"))
        assertEquals("/tmp/é.txt", decodeFilePath("L3RtcC/pLnR4dA=="))
        assertEquals("not base64!", decodeFilePath("not base64!"))
    }

    @Test
    fun pathsWithoutAnAndroidScreenOpenHome() {
        listOf(
            "https://app.happy.engineering/",
            "happy:///",
            "happy:///account?$key",
            "happy://session/recent",
            "happy://session/s1/files",
            "happy://session/s1/file",
            "happy://settings/usage",
            "happy://inbox",
            "happy://friends",
            // happy://artifacts/… is Happy Agent's: from outside it opens nothing (happyUrlsOpenFromOutsideOnlyLockedToTheirInstance).
            "happy://dev",
            "happy://text-selection?textId=1",
            "happy://user/u1",
            "happy://nothing/here",
        ).forEach { assertEquals(it, DeepLink.Home, parseDeepLink(it)) }
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
