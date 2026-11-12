package com.slopus.happy.ui.connection

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Create your profile on a Happy Cloud server: the name from the server's
 * suggestion, with the keyboard up, never sent blank; the picture chosen
 * from its circle or the text under it; a name that wouldn't save said in
 * plain words.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudProfileScreenTest {
    @get:Rule val rule = createComposeRule()

    private fun screen(
        suggested: String? = null,
        photo: ImageBitmap? = null,
        saving: Boolean = false,
        failed: Boolean = false,
        onChoose: () -> Unit = {},
        onSubmit: (String) -> Unit = {},
    ) = rule.setHappyContent {
        CloudProfileScreen("@acme", seed = "acme", suggested = suggested, photo = photo, saving = saving, failed = failed, onChoosePhoto = onChoose, onSubmit = onSubmit, onBack = {})
    }

    @Test
    fun emptyItAsksForANameAndSendsItTrimmedAsTyped() {
        val sent = mutableListOf<String>()
        screen(onSubmit = { sent += it })
        rule.onNodeWithText("Create your profile").assertIsDisplayed()
        rule.onNodeWithText("This is how your team and agents see you on @acme.").assertIsDisplayed()
        rule.onNodeWithText("Your name").assertIsDisplayed()
        rule.onNodeWithTag(ServerSignInTags.NAME).assertIsFocused()
        rule.onNodeWithTag(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.onNodeWithTag(ServerSignInTags.NAME).performTextInput("   ")
        rule.onNodeWithTag(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.onNodeWithTag(ServerSignInTags.NAME).performTextClearance()
        rule.onNodeWithTag(ServerSignInTags.NAME).performTextInput("Ada Lovelace")
        rule.onNodeWithTag(CloudTags.PRIMARY).assertIsEnabled().performClick()
        assertEquals(listOf("Ada Lovelace"), sent)
    }

    @Test
    fun theSuggestedNameIsFilledInAndDoneSendsIt() {
        val sent = mutableListOf<String>()
        screen(suggested = "Steve K", onSubmit = { sent += it })
        rule.onNodeWithTag(ServerSignInTags.NAME).assertTextContains("Steve K")
        // The cursor after the name, as on iOS, not before it.
        rule.onNodeWithTag(ServerSignInTags.NAME).assert(SemanticsMatcher.expectValue(SemanticsProperties.TextSelectionRange, TextRange(7)))
        rule.onNodeWithTag(ServerSignInTags.NAME).performTextInput("orshakov")
        rule.onNodeWithTag(ServerSignInTags.NAME).assertTextContains("Steve Korshakov")
        rule.onNodeWithTag(CloudTags.PRIMARY).assertIsEnabled()
        rule.onNodeWithTag(ServerSignInTags.NAME).performImeAction()
        assertEquals(listOf("Steve Korshakov"), sent)
    }

    @Test
    fun thePictureAndItsButtonOpenThePickerAndTheButtonSaysChangeOnceChosen() {
        var opened = 0
        var photo by mutableStateOf<ImageBitmap?>(null)
        rule.setHappyContent {
            CloudProfileScreen("@acme", "acme", null, photo, saving = false, failed = false, onChoosePhoto = { opened++ }, onSubmit = {}, onBack = {})
        }
        rule.onNodeWithText("Add photo").assertIsDisplayed()
        rule.onNodeWithTag(CloudProfileTags.PICTURE).performClick()
        rule.onNodeWithTag(CloudProfileTags.PHOTO).performClick()
        assertEquals(2, opened)
        photo = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888).asImageBitmap()
        rule.onNodeWithText("Change photo").assertIsDisplayed()
    }

    @Test
    fun savingSpinsAndTakesNothingNew() {
        var opened = 0
        screen(suggested = "Ada", saving = true, onChoose = { opened++ })
        rule.onNodeWithTag(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.onNodeWithTag(ServerSignInTags.NAME).assertIsNotEnabled()
        rule.onNodeWithTag(CloudProfileTags.PICTURE).assertIsNotEnabled()
        assertEquals(0, opened)
    }

    @Test
    fun aNameThatWouldntSaveSaysSoInPlainWords() {
        screen(suggested = "Ada", failed = true)
        rule.onNodeWithText("Couldn't save your name. Check your connection and try again.").assertIsDisplayed()
    }
}
