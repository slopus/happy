package com.slopus.happy.ui.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AppearanceLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun appearanceCyclesTheTheme() {
        var theme = ThemePreference.Adaptive
        rule.setHappyContent { AppearanceScreen(theme = theme, onThemeChange = { theme = it }, onBack = {}) }
        rule.onNodeWithText("Adaptive").assertIsDisplayed()
        val row = rule.node(ItemTags.ROW).bounds
        assertDp("theme row: icon, title and subtitle", 76, row.bottom - row.top)
        rule.node(ItemTags.ROW).performClick()
        assertEquals(ThemePreference.Light, theme)
    }
}
