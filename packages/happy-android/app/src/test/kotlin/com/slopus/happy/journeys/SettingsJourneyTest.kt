package com.slopus.happy.journeys

import android.content.Context
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.push.ExpoPushTokenClient
import com.slopus.happy.push.PushApi
import com.slopus.happy.push.PushRegistrar
import com.slopus.happy.push.RegisteredPushTokenStore
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.settings.SettingsTags
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Journey 5, Settings and back: Dark theme, Pixelated avatars, Russian and
 * developer mode, each set where Settings puts it and each holding on Home,
 * in the chat and in Settings; the account's settings reach the server.
 * Logout then drops this phone's push token on the server and wipes the
 * account, back to Welcome in the device's language.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val journey = Journey()
    private val server = journey.server
    private lateinit var graph: AppGraph
    private var dark: Boolean? = null

    @After
    fun tearDown() {
        graph.language.apply(null)
        journey.close()
    }

    private fun clickable(text: String) = rule.onNode(hasText(text) and hasClickAction())

    private fun dialogButton(text: String) = rule.onNode(hasText(text) and hasClickAction() and hasAnyAncestor(isDialog()))

    private fun back() = rule.node(HeaderTags.LEFT).performClick()

    @Test
    fun themeLanguageAvatarsAndDevModeHoldEverywhere_thenLogoutWipes() {
        journey.machine()
        journey.session("s1", updatedAt = 100, title = "Settings chat")
        graph = journey.graph()
        journey.signIn(graph)
        // HappyApplication's hook, over this graph: logout drops this phone's registered token.
        val context = ApplicationProvider.getApplicationContext<Context>()
        val tokens = RegisteredPushTokenStore(context.getSharedPreferences(RegisteredPushTokenStore.PREFS_NAME, Context.MODE_PRIVATE))
        tokens.save("ExponentPushToken[phone]")
        val registrar = PushRegistrar({ null }, ExpoPushTokenClient(OkHttpClient()), PushApi(graph.http), tokens, { "id" }, "com.slopus.happy.dev")
        graph.beforeLogout { registrar.unregisterOnLogout(it) }
        rule.setContent { HappyApp(graph, onDarkThemeChange = { dark = it }) }
        rule.waitFor(FlatRowTags.ROW)
        assertEquals(false, dark)

        // Settings › Appearance: Dark (Adaptive → Light → Dark), Pixelated avatars.
        rule.node(HomeTags.SETTINGS).performClick()
        rule.waitFor(SettingsTags.VERSION)
        rule.assertActionsLabelled()
        clickable("Appearance").performScrollTo().performClick()
        rule.waitForText("Avatar Style")
        clickable("Appearance").performClick()
        clickable("Appearance").performClick()
        rule.waitUntil(5_000) { dark == true }
        assertEquals(ThemePreference.Dark, graph.localSettings.themePreference.value)
        clickable("Avatar Style").performScrollTo().performClick()
        rule.onNodeWithText("Pixelated").performScrollTo().performClick()
        rule.waitUntil(10_000) { server.settingsJson()?.get("avatarStyle")?.jsonPrimitive?.content == "pixelated" }
        rule.assertActionsLabelled()

        // Language: Russian, confirmed; the screen speaks it at once.
        clickable("Current Language").performScrollTo().performClick()
        rule.waitForText("Русский")
        clickable("Русский").performScrollTo().performClick()
        dialogButton("OK").performClick()
        rule.waitUntil(10_000) { server.settingsJson()?.get("preferredLanguage")?.jsonPrimitive?.content == "ru" }
        back()
        rule.waitForText("Внешний вид")
        back()
        rule.waitForText("Настройки")

        // Developer mode: ten taps on the version.
        rule.node(SettingsTags.VERSION).performScrollTo()
        repeat(10) { rule.node(SettingsTags.VERSION).performClick() }
        rule.waitForText("Режим разработчика включен")
        dialogButton("ОК").performClick()
        assertTrue(graph.localSettings.values.value.devModeEnabled)

        // Home and the chat, in Russian and dark; the session's row and settings unchanged.
        back()
        rule.waitForText("Сессии")
        assertEquals(true, dark)
        rule.node(FlatRowTags.ROW).performClick()
        rule.waitFor(ChatScreenTags.SCREEN)
        rule.waitForText("Введите сообщение...")
        rule.assertActionsLabelled()
        assertEquals("pixelated", graph.settings.settings.value.avatarStyle)
        rule.node(ComposerTags.INPUT).assertExists()
        back()
        rule.waitFor(FlatRowTags.ROW)

        // Logout, from Settings › Account, confirmed.
        rule.node(HomeTags.SETTINGS).performClick()
        clickable("Аккаунт").performScrollTo().performClick()
        clickable("Выйти").performScrollTo().performClick()
        dialogButton("Выйти").performClick()
        // The language was the account's setting: Welcome is back in the device's, as after happy-app's reload.
        rule.waitForText("Create account")
        rule.waitUntil(10_000) { server.requestsTo("/v1/push-tokens/ExponentPushToken%5Bphone%5D").any { it.method == "DELETE" } }
        assertNull(tokens.load())
        assertNull(graph.store.profile())
        assertTrue(graph.store.sessions().isEmpty())
        assertEquals(ThemePreference.Adaptive, graph.localSettings.themePreference.value)
        assertTrue(!graph.localSettings.values.value.devModeEnabled)
        rule.waitUntil(5_000) { dark == false }
    }
}
