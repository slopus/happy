package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.v2.createComposeRule
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

/** Item.tsx on Android: 56 minimum, 16 padding, 32 icon + 12, 24 chevron 4 after the detail's 6. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ItemLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun titleOnlyRowIsTheMinimumHeight() {
        rule.setHappyContent {
            Box(Modifier.fillMaxWidth()) { Item(title = "Account", onClick = {}) }
        }
        assertBox("row", rule.node(ItemTags.ROW).bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, 56.dp)
        val title = rule.node(ItemTags.TITLE).bounds
        assertDp("title left", 16, title.left)
        assertDp("title top", 16, title.top)
        assertDp("title line height", 24, title.bottom - title.top)
        // Chevron: 24 square, flush with the 16 right padding, centred.
        assertBox("chevron", rule.node(ItemTags.CHEVRON).bounds, (PHONE_WIDTH - 16 - 24).dp, 16.dp, 24.dp, 24.dp)
    }

    @Test
    fun iconTitleAndSubtitleStack() {
        rule.setHappyContent {
            Box(Modifier.fillMaxWidth()) {
                Item(
                    title = "Account",
                    subtitle = "Manage your account details",
                    icon = { Icon(Ionicon.PersonCircleOutline, 29.dp, Color.Blue) },
                    onClick = {},
                )
            }
        }
        // 16 + title 24 + subtitle 20 + 16
        assertDp("row height", 76, rule.node(ItemTags.ROW).bounds.let { it.bottom - it.top })
        assertBox("icon", rule.node(ItemTags.ICON).bounds, 16.dp, 22.dp, 32.dp, 32.dp)
        val title = rule.node(ItemTags.TITLE).bounds
        assertDp("title left (16 + 32 + 12)", 60, title.left)
        assertDp("title top", 16, title.top)
        val subtitle = rule.node(ItemTags.SUBTITLE).bounds
        assertDp("subtitle left", 60, subtitle.left)
        assertDp("subtitle top", 40, subtitle.top)
        assertDp("subtitle line height", 20, subtitle.bottom - subtitle.top)
    }

    @Test
    fun longSubtitleWrapsToTwoLinesThenEllipsizes() {
        rule.setHappyContent {
            Box(Modifier.fillMaxWidth()) {
                Item(title = "Secret Key", subtitle = "word ".repeat(80), showChevron = false)
            }
        }
        assertDp("subtitle height", 40, rule.node(ItemTags.SUBTITLE).bounds.let { it.bottom - it.top })
        assertDp("row height", 16 + 24 + 40 + 16, rule.node(ItemTags.ROW).bounds.let { it.bottom - it.top })
    }

    @Test
    fun detailSitsSixBeforeTheChevronsFourDpGap() {
        rule.setHappyContent {
            Box(Modifier.fillMaxWidth()) { Item(title = "GitHub", detail = "slopus/happy", onClick = {}) }
        }
        val chevron = rule.node(ItemTags.CHEVRON).bounds
        val detail = rule.node(ItemTags.DETAIL).bounds
        assertDp("detail right", chevron.left - 4.dp - 6.dp, detail.right)
        assertDp("detail centred", 28, (detail.top + detail.bottom) / 2)
    }

    @Test
    fun withoutChevronTheDetailIsFlushRight() {
        rule.setHappyContent {
            Box(Modifier.fillMaxWidth()) { Item(title = "Version", detail = "0.1.0", showChevron = false) }
        }
        assertDp("detail right", PHONE_WIDTH - 16, rule.node(ItemTags.DETAIL).bounds.right)
    }
}
