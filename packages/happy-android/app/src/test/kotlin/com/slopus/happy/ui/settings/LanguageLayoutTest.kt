package com.slopus.happy.ui.settings

import androidx.compose.material3.Text
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.R
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemTags
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.Locale

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LanguageLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun choosingALanguageAsksToRestartFirst() {
        val selected = mutableListOf<String?>()
        rule.setHappyContent { LanguageScreen(preferredLanguage = null, detectedLanguageName = "English", onSelect = { selected += it }, onBack = {}) }
        rule.onNodeWithText("Detect from device settings (English)").assertIsDisplayed()
        rule.onNodeWithText("日本語").performScrollTo().performClick()
        rule.onNodeWithText("The app needs to restart to apply the new language setting.").assertIsDisplayed()
        rule.onNodeWithText("Cancel").performClick()
        assertEquals(emptyList<String?>(), selected)
        rule.onNodeWithText("日本語").performScrollTo().performClick()
        rule.onNodeWithText("OK").performClick()
        assertEquals(listOf<String?>("ja"), selected)
    }

    @Test
    fun theCurrentChoiceDoesNothing() {
        val selected = mutableListOf<String?>()
        rule.setHappyContent { LanguageScreen(preferredLanguage = "ru", detectedLanguageName = "English", onSelect = { selected += it }, onBack = {}) }
        rule.onNodeWithText("Русский").performScrollTo().performClick()
        rule.onNodeWithText("Automatic").performClick()
        rule.onNodeWithText("OK").performClick()
        assertEquals(listOf<String?>(null), selected)
    }

    @Test
    fun rowsAreStandardItems() {
        rule.setHappyContent { LanguageScreen(preferredLanguage = "en", detectedLanguageName = "English", onSelect = {}, onBack = {}) }
        val row = rule.onNodeWithText("English").performScrollTo()
        assertDp("title-only row: 16 + 32 icon + 16", 64, rule.onAllNodes(androidx.compose.ui.test.hasTestTag(ItemTags.ROW), useUnmergedTree = true)[1].bounds.let { it.bottom - it.top })
        row.assertIsDisplayed()
    }

    @Test
    fun localizedContentSwitchesTheResources() {
        rule.setHappyContent {
            LocalizedContent(Locale.forLanguageTag("ru")) { Text(stringResource(R.string.common_cancel)) }
        }
        rule.onNodeWithText("Отмена").assertIsDisplayed()
    }
}
