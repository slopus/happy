package com.slopus.happy.push

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.BuildConfig
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.model.settings.PushPermission
import com.slopus.happy.model.settings.PushPermissionStatus
import com.slopus.happy.push.PushPromptTest.FakePermission
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger

/**
 * A person who paired with a Happy Agent, or signed in to a server of their
 * own, is asked for notifications once, on that connection's home, and the
 * phone registers on a yes. Nobody is asked twice, and nobody whose server
 * or account has an ask of its own is asked here.
 */
@RunWith(AndroidJUnit4::class)
class PushPermissionPromptTest {
    @get:Rule
    val rule = createComposeRule()

    private val instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
    private val cloud = AgentConnection("cloud", "Acme", addedAt = 1, server = "https://acme.${BuildConfig.HAPPY_CLOUD_BASE}", instanceId = instance, userId = "member-one")
    private val team = AgentConnection("team", "Team", addedAt = 1, server = "https://happy.team.example", instanceId = instance, userId = "member-one", pushRegistrations = true)
    private val paired = AgentConnection("paired", "Studio", addedAt = 1, instanceId = instance, pushRegistrations = true)

    @Test fun aPairedDaemonThatKeepsPhonesAsks() {
        assertTrue(asksForPushPermission(paired, happyAccount = false))
        assertTrue(asksForPushPermission(paired.copy(userId = "member-two"), happyAccount = false))
    }

    @Test fun aSignedInServerOfTheirOwnThatKeepsPhonesAsks() {
        assertTrue(asksForPushPermission(team, happyAccount = false))
    }

    @Test fun aServerThatKeepsNoPhonesNeverAsks() {
        assertFalse(asksForPushPermission(paired.copy(pushRegistrations = false), happyAccount = false))
        assertFalse(asksForPushPermission(team.copy(pushRegistrations = false), happyAccount = false))
        assertFalse(asksForPushPermission(null, happyAccount = false))
    }

    @Test fun aConnectionThatCannotRegisterNeverAsks() {
        assertFalse(asksForPushPermission(paired.copy(revoked = true), happyAccount = false))
        assertFalse(asksForPushPermission(paired.copy(instanceId = null), happyAccount = false))
        assertFalse(asksForPushPermission(team.copy(signInRequired = true), happyAccount = false))
        assertFalse(asksForPushPermission(team.copy(userId = null), happyAccount = false))
    }

    /** Happy Cloud asks in its onboarding (the mobileApp gate), a Happy account at every foreground: neither is asked a second way. */
    @Test fun whoeverHasAnAskOfTheirOwnIsLeftToIt() {
        assertFalse(asksForPushPermission(cloud, happyAccount = false))
        assertFalse(asksForPushPermission(paired, happyAccount = true))
        assertFalse(asksForPushPermission(team, happyAccount = true))
    }

    private var asks by mutableStateOf(true)
    private val grants = AtomicInteger()
    private val supportedChecks = AtomicInteger()

    private fun setEffect(permission: NotificationPermission, supported: Boolean = true) {
        rule.setContent {
            PushPermissionPromptEffect(
                asks = asks,
                supported = { supportedChecks.incrementAndGet(); supported },
                permission = permission,
                onGranted = { grants.incrementAndGet() },
            )
        }
    }

    /** The effect's work hops to Dispatchers.IO and back; wait for [done], then let it finish. */
    private fun settle(done: () -> Boolean) {
        rule.waitForIdle()
        rule.waitUntil(5_000) { done() }
        Thread.sleep(100)
        rule.waitForIdle()
    }

    /** Home shown again: the next launch, or coming back to it. */
    private fun showAgain(permission: FakePermission) {
        val before = permission.infos.get()
        asks = false
        rule.waitForIdle()
        asks = true
        settle { permission.infos.get() > before }
    }

    @Test fun neverAskedIsAskedOnceAndAYesRegistersAtOnce() {
        val permission = FakePermission(UNDETERMINED, answer = GRANTED)
        setEffect(permission)
        settle { grants.get() > 0 }
        assertEquals(1, permission.requests.get())
        assertEquals(1, grants.get())

        showAgain(permission)
        assertEquals(1, permission.requests.get())
        assertEquals(1, grants.get())
    }

    @Test fun aNoIsNeverAskedAgainEvenWhileTheSystemWouldStillShowItsPrompt() {
        val permission = FakePermission(UNDETERMINED, answer = REFUSED_ONCE)
        setEffect(permission)
        settle { permission.requests.get() > 0 }
        assertEquals(1, permission.requests.get())
        assertEquals(0, grants.get())

        showAgain(permission)
        showAgain(permission)
        assertEquals(1, permission.requests.get())
        assertEquals(0, grants.get())
        assertEquals(0, permission.settingsOpened)
    }

    @Test fun askedBeforeByAnythingElseIsNotAskedHere() {
        val permission = FakePermission(REFUSED_ONCE, answer = GRANTED)
        setEffect(permission)
        settle { permission.infos.get() > 0 }
        for (known in listOf(BLOCKED, GRANTED)) {
            permission.current = known
            showAgain(permission)
        }
        assertEquals(0, permission.requests.get())
        assertEquals(0, permission.settingsOpened)
        assertEquals(0, grants.get())
    }

    @Test fun nothingIsAskedWhereThisIsNotTheAsk() {
        val permission = FakePermission(UNDETERMINED, answer = GRANTED)
        asks = false
        setEffect(permission)
        rule.waitForIdle()
        Thread.sleep(200)
        rule.waitForIdle()
        assertEquals(0, permission.infos.get())
        assertEquals(0, permission.requests.get())
        assertEquals(0, grants.get())
    }

    @Test fun aPhoneThatCannotGetAPushTokenIsNeverAsked() {
        val permission = FakePermission(UNDETERMINED, answer = GRANTED)
        setEffect(permission, supported = false)
        settle { supportedChecks.get() > 0 }
        assertEquals(0, permission.requests.get())
        assertEquals(0, grants.get())
    }

    private companion object {
        val GRANTED = PushPromptTest.GRANTED
        val UNDETERMINED = PushPromptTest.UNDETERMINED
        val BLOCKED = PushPromptTest.BLOCKED
        /** Android 13's state after one refusal: the system would show its prompt once more. */
        val REFUSED_ONCE = PushPermission(PushPermissionStatus.Denied, granted = false, canAskAgain = true)
    }
}
