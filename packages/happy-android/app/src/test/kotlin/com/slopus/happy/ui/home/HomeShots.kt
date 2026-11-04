package com.slopus.happy.ui.home

import android.graphics.Bitmap
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.HomeModelFixtures.metadata
import com.slopus.happy.model.HomeModelFixtures.session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.MenuGroup
import com.slopus.happy.ui.components.MenuOption
import com.slopus.happy.ui.components.OptionMenuTags
import com.slopus.happy.ui.components.SettingsMenu
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.LocalDate
import java.time.ZoneOffset

/** Home renders for review: the header, the rows, the account menu; written only when HAPPY_SHOTS_DIR is set. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeShots {
    @get:Rule val rule = createComposeRule()
    private val dir = System.getenv("HAPPY_SHOTS_DIR")?.let(::File)
    private val noon = LocalDate.of(2026, 10, 16).atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val studio = machine("m1", machineMetadata { put("displayName", "Studio") })
    private val callbacks = HomeListCallbacks({}, {}, {}, {}, {}, {}, {}, { _, _ -> })
    private val actions = HomeScreenActions({}, {}, {}, {}, {})
    private val accounts = AccountMenu(listOf(
        AccountMenuEntry("0123456789abcdef", "Steve", active = true),
        AccountMenuEntry("fedcba9876543210", null, detail = "selfhost.test"),
        AccountMenuEntry("agent-connection-1", "Studio", agent = true),
        AccountMenuEntry("agent-connection-2", "Old Mac", agent = true, attention = true),
    ))
    private val titles = listOf(
        "Fix the flaky sync test", "Glass header for Android", "Refactor the outbox", "Release notes for 1.6",
        "Investigate cold start", "Port the diff viewer", "Tablet sidebar polish", "Voice reconnects",
        "Crash in markdown tables", "Update dependencies",
    )

    private fun state() = deriveHomeList(
        HomeListInputs(
            HomeSnapshot(
                titles.mapIndexed { i, title ->
                    session(
                        "s$i",
                        metadata = metadata(path = "/Users/dev/happy") {
                            put("machineId", "m1")
                            putJsonObject("summary") { put("text", title); put("updatedAt", 0) }
                        },
                        lastMessageSentAt = noon - i * 3_600_000L,
                    )
                },
                listOf(studio),
            ),
            SessionListGrouping.Flat, true, emptySet(), setOf("s1"), emptySet(),
        ),
        ZoneOffset.UTC,
        LocalDate.of(2026, 10, 16),
    )

    private fun save(name: String) {
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun show(dark: Boolean = false, scrolled: Boolean = false) {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        val home = state()
        rule.setHappyContent(dark) {
            HomeScreen(
                home, ConnectionStatus.CONNECTED, home.grouping, callbacks, actions,
                accounts = accounts,
                listState = if (scrolled) LazyListState(1, 40) else LazyListState(),
            )
        }
    }

    @Test fun listLight() { show(); save("home-light") }
    @Test fun listDark() { show(dark = true); save("home-dark") }
    @Test fun scrolledLight() { show(scrolled = true); save("home-scrolled-light") }
    @Test fun scrolledDark() { show(dark = true, scrolled = true); save("home-scrolled-dark") }
    @Test fun accountMenuLight() { show(); rule.node(AccountMenuTags.BUTTON).performClick(); save("home-account-menu-light") }
    @Test fun accountMenuDark() { show(dark = true); rule.node(AccountMenuTags.BUTTON).performClick(); save("home-account-menu-dark") }

    /** The Happy account's settings, for its glass header beside the agent screens'. */
    private fun settings(dark: Boolean, scrolled: Boolean) {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        rule.setHappyContent(dark) {
            com.slopus.happy.ui.settings.SettingsScreen(
                profile = com.slopus.happy.ui.settings.SettingsFixtures.profile,
                about = com.slopus.happy.ui.settings.AboutInfo("1.6.0"),
                accounts = com.slopus.happy.ui.settings.SettingsFixtures.accounts,
                accountActions = com.slopus.happy.ui.settings.AccountsCardActions({}, {}),
                actions = com.slopus.happy.ui.settings.HappySettingsActions(),
            )
        }
        if (scrolled) rule.onRoot().performTouchInput { swipeUp(startY = centerY, endY = centerY - 300f) }
        save("happy-settings" + (if (dark) "-dark" else "-light") + (if (scrolled) "-scrolled" else ""))
    }

    @Test fun happySettingsLight() = settings(dark = false, scrolled = false)
    @Test fun happySettingsDark() = settings(dark = true, scrolled = false)
    @Test fun happySettingsScrolled() = settings(dark = false, scrolled = true)

    @Test fun settingsMenu() {
        assumeTrue(dir != null)
        dir!!.mkdirs()
        rule.setHappyContent {
            var open by remember { mutableStateOf(true) }
            SettingsMenu(
                listOf(MenuGroup("theme", "Theme", listOf(MenuOption("a", "Adaptive"), MenuOption("l", "Light"), MenuOption("d", "Dark")), "a") {}),
                expanded = open,
                onDismiss = { open = false },
            ) { androidx.compose.material3.Text("Theme") }
        }
        rule.node(OptionMenuTags.MENU)
        save("settings-menu")
    }
}
