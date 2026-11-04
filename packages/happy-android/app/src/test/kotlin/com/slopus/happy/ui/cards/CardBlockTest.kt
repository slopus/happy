package com.slopus.happy.ui.cards

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.layout.ProvideWindowLayout
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
class CardBlockTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun customRowsKeepTheCardInsetAndTheirOwnHeight() {
        rule.setHappyContent {
            Column {
                CardBlock(HomeCardPlace(true, false), dividerStart = 50.dp, tag = "first") { Box(Modifier.fillMaxWidth().height(44.dp)) }
                CardBlock(HomeCardPlace(false, true), tag = "last") { Box(Modifier.fillMaxWidth().height(76.dp)) }
            }
        }
        assertBox("first card", rule.node("first.body").bounds, 16.dp, 0.dp, 379.dp, 44.dp)
        assertBox("last card", rule.node("last.body").bounds, 16.dp, 44.dp, 379.dp, 76.dp)
        assertDp("hairline starts under content", 66, rule.node("first.divider").bounds.left)
        rule.node("last.divider").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun customCardsUseTheTabletReadableColumn() {
        rule.setHappyContent {
            ProvideWindowLayout {
                CardBlock(HomeCardPlace(true, true), tag = "tablet") { Box(Modifier.fillMaxWidth().height(44.dp)) }
            }
        }
        assertDp("card edge", 256, rule.node("tablet.body").bounds.left)
        assertDp("card measure", 768, rule.node("tablet.body").bounds.width)
    }
}