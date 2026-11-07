package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** A new member names themselves on a Happy Cloud server, on its gradient: nothing filled in, nothing sent blank. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudNameScreenTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun theNameIsAskedForEmptyAndSentAsTyped() {
        val sent = mutableListOf<String>()
        rule.setHappyContent { CloudNameScreen("@acme", saving = false, failed = false, onSubmit = { sent += it }, onBack = {}) }
        rule.onNodeWithText("What's your name?").assertIsDisplayed()
        rule.onNodeWithText("People on @acme see this name.").assertIsDisplayed()
        rule.onNodeWithTag(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.onNodeWithTag(ServerSignInTags.NAME).performTextInput("Ada Lovelace")
        rule.onNodeWithTag(CloudTags.PRIMARY).assertIsEnabled().performClick()
        assertEquals(listOf("Ada Lovelace"), sent)
    }

    @Test
    fun aNameThatWouldntSaveSaysSo() {
        rule.setHappyContent { CloudNameScreen("@acme", saving = false, failed = true, onSubmit = {}, onBack = {}) }
        rule.onNodeWithText("Couldn't save your name. Try again.").assertIsDisplayed()
    }
}
