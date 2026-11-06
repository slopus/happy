package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.PasswordSignIn
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.StateAnimationTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The welcome's test-account sign-in: absent until the sparkles are pressed ten times within four seconds. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudWelcomeTest {
    @get:Rule val rule = createComposeRule()

    private val tries = mutableListOf<Pair<String, String>>()
    private val answers = ArrayDeque<PasswordSignIn>()

    private fun welcome() = rule.setHappyContent {
        CloudScreen(
            state = CloudAccountState.SignedOut(),
            servers = null,
            failure = null,
            here = emptySet(),
            image = { null },
            onOpenBrowser = {},
            signInWithPassword = { login, password -> tries += login to password; answers.removeFirst() },
            onRetrySignIn = {},
            onReload = {},
            onPick = {},
            onCreate = {},
            onJoin = {},
            onSignOut = {},
            onBack = {},
        )
    }

    /** The clock moves only as told: left to itself, it would run out each replay of the scene between presses. */
    private fun press(times: Int, apartMillis: Long = 100) {
        rule.mainClock.autoAdvance = false
        repeat(times) {
            rule.node(StateAnimationTags.ANIMATION).performClick()
            rule.mainClock.advanceTimeBy(apartMillis)
        }
        rule.mainClock.autoAdvance = true
    }

    @Test
    fun nineQuickPressesOrTenSlowOnesRevealNothing() {
        welcome()
        press(9)
        rule.node(CloudTags.LOGIN).assertDoesNotExist()
        rule.onNodeWithText("Sign in with a test account.").assertDoesNotExist()
        // A pause, then ten more spread over five seconds: never ten within four.
        rule.mainClock.advanceTimeBy(5_000)
        press(10, apartMillis = 500)
        rule.node(CloudTags.LOGIN).assertDoesNotExist()
        rule.node(CloudTags.PRIMARY).assertExists()
    }

    @Test
    fun tenQuickPressesRevealTheFormAndItsErrorsShowInline() {
        welcome()
        press(10)
        rule.onNodeWithText("Sign in with a test account.").assertExists()
        rule.node(CloudTags.LOGIN).performTextInput(" qa-android ")
        rule.node(CloudTags.PASSWORD).performTextInput("hunter22")
        rule.node(CloudTags.PASSWORD).assertTextEquals("••••••••")

        answers += PasswordSignIn.Wrong
        rule.node(CloudTags.PRIMARY).performClick()
        rule.onNodeWithText("That login or password is wrong.").assertExists()
        assertEquals(listOf("qa-android" to "hunter22"), tries)

        answers += PasswordSignIn.Locked(15)
        rule.node(CloudTags.PRIMARY).performClick()
        rule.onNodeWithText("Too many tries. Try again in 15 min.").assertExists()

        answers += PasswordSignIn.Failed(CloudException.Reason.Unreachable)
        rule.node(CloudTags.PRIMARY).performClick()
        rule.onNodeWithText("Too many tries", substring = true).assertDoesNotExist()
        assertEquals(3, tries.size)
        // The browser's sign-in is still there, under it.
        rule.node(CloudTags.SECONDARY).assertExists()
    }
}
