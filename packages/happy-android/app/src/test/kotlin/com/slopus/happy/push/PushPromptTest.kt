package com.slopus.happy.push

import android.app.NotificationManager
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * sync.ts `pushTokenSync` with syncCurrentPushToken's permission rule: the
 * prompt only while it can still be shown, registration only once allowed,
 * nothing at all where push is unsupported, forgetting on sign-out.
 */
@RunWith(AndroidJUnit4::class)
class PushPromptTest {
    @get:Rule
    val rule = createComposeRule()

    private class FakePermission(var current: PushPermissionInfo, val answer: PushPermissionInfo = current) : PushPermission {
        val infos = AtomicInteger()
        val requests = AtomicInteger()
        var settingsOpened = 0

        override fun info(): PushPermissionInfo {
            infos.incrementAndGet()
            return current
        }

        override suspend fun request(): PushPermissionInfo {
            requests.incrementAndGet()
            current = answer
            return answer
        }

        override fun openSettings() {
            settingsOpened++
        }
    }

    private val granted = PushPermissionInfo(PushPermissionStatus.Granted, canAskAgain = true)
    private val undetermined = PushPermissionInfo(PushPermissionStatus.Undetermined, canAskAgain = true)
    private val blocked = PushPermissionInfo(PushPermissionStatus.Denied, canAskAgain = false)

    private val synced = CopyOnWriteArrayList<String>()
    private val supportedChecks = AtomicInteger()
    private var forgets = 0
    private var authToken by mutableStateOf<String?>("token-1")

    private fun setEffect(permission: PushPermission, supported: Boolean = true) {
        rule.setContent {
            PushRegistrationEffect(
                authToken = authToken,
                supported = { supportedChecks.incrementAndGet(); supported },
                permission = permission,
                sync = { synced += it },
                forget = { forgets++ },
            )
        }
    }

    /** The effect's work hops to Dispatchers.IO and back; wait for [done], then let it finish. */
    private fun settle(done: () -> Boolean) {
        // Recompose for a state the test changed before polling.
        rule.waitForIdle()
        rule.waitUntil(5_000) { done() }
        Thread.sleep(100)
        rule.waitForIdle()
    }

    @Test
    fun allowedRegistersWithoutAsking() {
        val permission = FakePermission(granted)
        setEffect(permission)
        settle { synced.isNotEmpty() }
        assertEquals(listOf("token-1"), synced)
        assertEquals(0, permission.requests.get())
    }

    @Test
    fun undeterminedAsksThenRegisters() {
        val permission = FakePermission(undetermined, answer = granted)
        setEffect(permission)
        settle { synced.isNotEmpty() }
        assertEquals(1, permission.requests.get())
        assertEquals(listOf("token-1"), synced)
    }

    @Test
    fun aRefusalRegistersNothing() {
        val permission = FakePermission(undetermined, answer = blocked)
        setEffect(permission)
        settle { permission.requests.get() > 0 }
        assertEquals(1, permission.requests.get())
        assertTrue(synced.isEmpty())
    }

    @Test
    fun blockedNeverPromptsOrOpensSettings() {
        val permission = FakePermission(blocked)
        setEffect(permission)
        settle { permission.infos.get() > 0 }
        assertEquals(0, permission.requests.get())
        assertEquals(0, permission.settingsOpened)
        assertTrue(synced.isEmpty())
    }

    @Test
    fun unsupportedSkipsEverything() {
        val permission = FakePermission(undetermined, answer = granted)
        setEffect(permission, supported = false)
        settle { supportedChecks.get() > 0 }
        assertEquals(0, permission.infos.get())
        assertEquals(0, permission.requests.get())
        assertTrue(synced.isEmpty())
        // The channels exist all the same, as happy-app creates them at start.
        val manager = ApplicationProvider.getApplicationContext<Context>().getSystemService(NotificationManager::class.java)
        assertNotNull(manager.getNotificationChannel(NotificationChannels.MESSAGES))
    }

    @Test
    fun signingOutForgetsTheRegistration() {
        setEffect(FakePermission(granted))
        settle { synced.isNotEmpty() }
        assertEquals(0, forgets)
        authToken = null
        rule.waitForIdle()
        assertEquals(1, forgets)

        authToken = "token-2"
        settle { synced.size == 2 }
        assertEquals(listOf("token-1", "token-2"), synced)
    }

    @Test
    fun settingsRowsAskOrOpenSettings() = runBlocking {
        val allowed = FakePermission(granted)
        assertEquals(granted, allowed.requestOrOpenSettings())
        assertEquals(0, allowed.requests.get())

        val askable = FakePermission(undetermined, answer = granted)
        assertEquals(granted, askable.requestOrOpenSettings())
        assertEquals(1, askable.requests.get())

        val refused = FakePermission(blocked)
        assertEquals(blocked, refused.requestOrOpenSettings())
        assertEquals(0, refused.requests.get())
        assertEquals(1, refused.settingsOpened)
    }
}
