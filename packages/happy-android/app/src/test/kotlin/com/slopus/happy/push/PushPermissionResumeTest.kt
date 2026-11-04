package com.slopus.happy.push

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.settings.PushPermission
import com.slopus.happy.model.settings.PushPermissionStatus
import com.slopus.happy.model.settings.PushRegistration
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.settings.AccountScreen
import com.slopus.happy.ui.settings.PushState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PushPermissionResumeTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun returningFromSystemSettingsRefreshesThePermissionWithoutRegisteringAToken() {
        val owner = object : LifecycleOwner {
            val registry = LifecycleRegistry.createUnsafe(this).apply { currentState = Lifecycle.State.RESUMED }
            override val lifecycle: Lifecycle get() = registry
        }
        var systemPermission = PushPermission(PushPermissionStatus.Denied, granted = false, canAskAgain = false)
        var reads = 0
        val registration = object : PushRegistration {
            override suspend fun permission(): PushPermission { reads++; return systemPermission }
            override suspend fun requestPermissionOrOpenSettings() = error("must not request permission")
            override suspend fun currentToken() = error("must not load a token")
            override suspend fun syncCurrentToken() = error("must not register a token")
            override suspend fun removeToken(token: String) = error("must not remove a token")
        }
        var push by mutableStateOf(PushState(loading = false))
        rule.setHappyContent {
            CompositionLocalProvider(LocalLifecycleOwner provides owner) {
                RefreshPushPermissionOnResume(registration) { push = push.copy(permission = it) }
                AccountScreen(anonId = null, publicId = null, analyticsOptOut = false, onAnalyticsOptOutChange = {}, onBack = {}, push = push)
            }
        }
        rule.onNodeWithText("Denied").performScrollTo().assertIsDisplayed()
        assertEquals(1, reads)
        rule.runOnIdle { owner.registry.currentState = Lifecycle.State.CREATED }
        rule.runOnIdle { systemPermission = PushPermission(PushPermissionStatus.Granted, granted = true, canAskAgain = false) }
        assertEquals(1, reads)
        rule.runOnIdle { owner.registry.currentState = Lifecycle.State.RESUMED }
        rule.onNodeWithText("Allowed").assertIsDisplayed()
        assertEquals(2, reads)
        rule.runOnIdle { owner.registry.currentState = Lifecycle.State.CREATED }
        rule.runOnIdle { systemPermission = systemPermission.copy(status = PushPermissionStatus.Denied, granted = false) }
        rule.runOnIdle { owner.registry.currentState = Lifecycle.State.RESUMED }
        rule.onNodeWithText("Denied").assertIsDisplayed()
        assertEquals(3, reads)
    }
}