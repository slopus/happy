package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComponentLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    // ItemGroup.tsx: 4 outer padding; header 16/8 with 24 sides, 14/20 text;
    // card 12 further in; a 1 px border around the content; footer 8/16.

    @Test
    fun itemGroupWithTitleAndFooter() {
        var hairline = 0.dp
        rule.setHappyContent {
            hairline = with(LocalDensity.current) { 1f.toDp() }
            Column(Modifier.fillMaxWidth()) {
                ItemGroup(title = "Features", footer = "Footer") {
                    Item(title = "Account", onClick = {})
                }
            }
        }
        assertBox("header", rule.node(ItemGroupTags.HEADER).bounds, 4.dp, 0.dp, (PHONE_WIDTH - 8).dp, 44.dp)
        assertBox("card", rule.node(ItemGroupTags.CARD).bounds, 16.dp, 44.dp, (PHONE_WIDTH - 32).dp, 56.dp + hairline * 2)
        val row = rule.node(ItemTags.ROW).bounds
        assertDp("row inset by the border", 16.dp + hairline, row.left)
        assertDp("row top", 44.dp + hairline, row.top)
        assertDp("row width", (PHONE_WIDTH - 32).dp - hairline * 2, row.right - row.left)
        val footer = rule.node(ItemGroupTags.FOOTER).bounds
        assertBox("footer", footer, 4.dp, 44.dp + 56.dp + hairline * 2, (PHONE_WIDTH - 8).dp, (8 + 20 + 16).dp)
    }

    @Test
    fun itemGroupWithoutTitleStartsWithASixteenSpacer() {
        rule.setHappyContent {
            Column(Modifier.fillMaxWidth()) {
                ItemGroup { Item(title = "Account") }
            }
        }
        assertDp("card top", 16, rule.node(ItemGroupTags.CARD).bounds.top)
    }

    // RoundButton.tsx: full width, heights 50/44/32, label centred.

    @Test
    fun roundButtonSizes() {
        rule.setHappyContent {
            Column(Modifier.width(300.dp)) {
                RoundButtonSize.entries.forEach { RoundButton(title = "Create account", onClick = {}, size = it) }
            }
        }
        val buttons = rule.onAllNodesWithTag(RoundButtonTags.CONTAINER, useUnmergedTree = true)
        val labels = rule.onAllNodesWithTag(RoundButtonTags.LABEL, useUnmergedTree = true)
        var top = 0.dp
        RoundButtonSize.entries.forEachIndexed { i, size ->
            assertBox("$size button", buttons[i].bounds, 0.dp, top, 300.dp, size.height)
            val label = labels[i].bounds
            assertDp("$size label line height", size.lineHeight, label.bottom - label.top)
            assertDp("$size label centred vertically", top + size.height / 2, (label.top + label.bottom) / 2)
            assertDp("$size label centred horizontally", 150, (label.left + label.right) / 2)
            top += size.height
        }
    }

    @Test
    fun invertedButtonKeepsTheMinimumHeightAndWrapsLongLabels() {
        rule.setHappyContent {
            Column(Modifier.width(200.dp)) {
                RoundButton(title = "Restore existing account", onClick = {}, size = RoundButtonSize.Normal, display = RoundButtonDisplay.Inverted)
            }
        }
        val button = rule.node(RoundButtonTags.CONTAINER).bounds
        val label = rule.node(RoundButtonTags.LABEL).bounds
        // 200 wide, 20 side padding: the 15/20 label wraps to two lines; 8 vertical padding around it.
        assertDp("label height", 40, label.bottom - label.top)
        assertDp("button height", 56, button.bottom - button.top)
    }

    // navigation/Header.tsx on an Android phone.

    @Test
    fun headerWithStartTitleAndBothControls() {
        rule.setHappyContent {
            Header(
                title = "Settings",
                left = { HeaderBackButton(onClick = {}) },
                right = { HeaderIconButton(icon = Ionicon.SettingsOutline, contentDescription = "x", onClick = {}) },
            )
        }
        assertBox("bar", rule.node(HeaderTags.BAR).bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, 64.dp)
        assertBox("left slot", rule.node(HeaderTags.LEFT).bounds, 16.dp, 8.dp, 48.dp, 48.dp)
        assertBox("right slot", rule.node(HeaderTags.RIGHT).bounds, (PHONE_WIDTH - 16 - 48).dp, 8.dp, 48.dp, 48.dp)
        // The title takes what is left between the controls, 8 from each.
        assertBox("title box", rule.node(HeaderTags.TITLE_BOX).bounds, 72.dp, 0.dp, (PHONE_WIDTH - 144).dp, 64.dp)
        val title = rule.node(HeaderTags.TITLE).bounds
        assertDp("title left", 72, title.left)
        assertDp("title line height", 20, title.bottom - title.top)
        assertDp("title centred vertically", 32, (title.top + title.bottom) / 2)
    }

    @Test
    fun centredTitleIsInsetSixtyFourFromBothEdgesWhateverTheControls() {
        rule.setHappyContent {
            Header(title = "Restore Account", alignment = TitleAlignment.Center, left = { HeaderBackButton(onClick = {}) })
        }
        assertBox("title box", rule.node(HeaderTags.TITLE_BOX).bounds, 64.dp, 0.dp, (PHONE_WIDTH - 128).dp, 64.dp)
        val title = rule.node(HeaderTags.TITLE).bounds
        assertDp("title centred horizontally", PHONE_WIDTH / 2f, ((title.left + title.right) / 2).value)
    }

    private fun assertDp(message: String, expected: Float, actual: Float) = assertDp(message, expected.dp, actual.dp)
}
