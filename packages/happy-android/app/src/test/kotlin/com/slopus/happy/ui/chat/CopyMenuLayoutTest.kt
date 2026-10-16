package com.slopus.happy.ui.chat

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CopyMenuLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val gray = userMessageBubblePalette("gray", dark = false)

    private fun userRow(text: String) =
        ChatReduction.buildRow(ChatMessage.UserText("u", "l", 0, text), isClaudeFlavor = false) as ChatRow.User

    // AnimatedPopup: in over 190 ms, out over 140 ms; still drawn while it fades out.
    @Test
    fun theMenuFadesInAndOut() {
        rule.setHappyContent { UserMessage(userRow("Hello there"), gray, MessageCallbacks()) }
        rule.node(MessageTags.USER_BODY).performTouchInput { longClick() }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.node(CopyMenuTags.COPY).performClick()
        rule.mainClock.advanceTimeBy(70)
        rule.node(CopyMenuTags.MENU).assertExists()
        rule.mainClock.advanceTimeBy(200)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.node(CopyMenuTags.MENU).assertDoesNotExist()
    }

    // Long press opens the menu rather than copying; Copy copies and closes it.
    @Test
    fun longPressOffersCopy() {
        rule.setHappyContent { UserMessage(userRow("Hello there"), gray, MessageCallbacks()) }
        rule.node(CopyMenuTags.MENU).assertDoesNotExist()
        rule.node(MessageTags.USER_BODY).performTouchInput { longClick() }
        rule.waitForIdle()
        rule.node(CopyMenuTags.MENU).assertExists()
        val clipboard = RuntimeEnvironment.getApplication().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        assertEquals(null, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        rule.node(CopyMenuTags.COPY).performClick()
        rule.waitForIdle()
        rule.node(CopyMenuTags.MENU).assertDoesNotExist()
        assertEquals("Hello there", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
    }

    // 152 wide, one 44 row.
    @Test
    fun menuGeometry() {
        rule.setHappyContent { CopyMenuContent(onCopy = {}, onClose = {}) }
        val menu = rule.node(CopyMenuTags.MENU).bounds
        assertBox("menu", menu, menu.left, menu.top, 152.dp, 44.dp)
        val row = rule.node(CopyMenuTags.COPY).bounds
        assertEquals(44f, row.height.value, 0.5f)
        assertEquals(152f, row.width.value, 0.5f)
    }

    // Above the message with an 8 gap, right edges aligned; below it near the top; 12 from the sides.
    @Test
    fun placement() {
        val density = Density(1f)
        val window = IntSize(411, 891)
        assertEquals(IntOffset(399 - 152, 400 - 44 - 8), copyMenuPosition(IntRect(200, 400, 399, 450), window, density))
        assertEquals(IntOffset(399 - 152, 40 + 8), copyMenuPosition(IntRect(200, 20, 399, 40), window, density))
        assertEquals(IntOffset(12, 348), copyMenuPosition(IntRect(0, 400, 100, 450), window, density))
        assertEquals(IntOffset(411 - 152 - 12, 348), copyMenuPosition(IntRect(0, 400, 411, 450), window, density))
        // A tall message at the top: below it, but never past the window's bottom margin.
        assertEquals(IntOffset(247, 891 - 44 - 12), copyMenuPosition(IntRect(0, 0, 399, 880), window, density))
    }
}
