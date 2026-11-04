package com.slopus.happy.ui.todos

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TodoItemRowTest {
    @get:Rule val rule = createComposeRule()

    @Test fun ringTextAndAuthorFollowTheFirstLineAndLeadingSlotChecks() {
        var checks = 0
        rule.setHappyContent {
            Column {
                TodoLine("short", HomeCardPlace(true, false), author = "Ada Lovelace", onCheck = { checks++ },
                    mark = { TodoCheck(false) }, text = { TodoTextLabel("Milk", false) {} })
                TodoLine("long", HomeCardPlace(false, true), author = "Ada Lovelace", onCheck = { checks++ },
                    mark = { TodoCheck(false) }, text = { TodoTextLabel("A long task that wraps onto several lines and keeps its author and checkbox beside the first line", false) {} })
            }
        }
        assertBox("leading target", rule.node("todo.hit.short").bounds, 16.dp, 0.dp, 50.dp, 44.dp)
        assertDp("ring left", 32, rule.node("todo.check.short").bounds.left)
        assertDp("text left", 66, rule.node("todo.text.short").bounds.left)
        assertDp("author left", 357, rule.node("todo.author.short").bounds.left)
        val long = rule.node("todo.row.long.body").bounds
        assertTrue("wrapped row grows", long.height > 44.dp)
        assertDp("ring stays at first line", 9.dp, rule.node("todo.check.long").bounds.top - long.top)
        assertDp("author shares ring baseline", rule.node("todo.check.long").bounds.top, rule.node("todo.author.long").bounds.top)
        rule.node("todo.hit.short").performClick()
        assertEquals(1, checks)
    }

    @Test fun doubleSizeTextGrowsWithoutShrinkingTheControls() {
        rule.setHappyContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 2f)) {
                TodoLine("large", HomeCardPlace(true, true), author = "Ada", mark = { TodoCheck(false) },
                    text = { TodoTextLabel("Milk", false) {} })
            }
        }
        // Android's nonlinear font scaling maps this 20 sp line to 35 dp.
        assertDp("scaled row", 55, rule.node("todo.row.large.body").bounds.height)
        assertDp("ring size", 22, rule.node("todo.check.large").bounds.height)
        assertDp("ring first line", 16, rule.node("todo.check.large").bounds.top)
        assertDp("scaled text inset", 66, rule.node("todo.text.large").bounds.left)
    }

    @Test @Config(qualifiers = "w900dp-h891dp-xxhdpi")
    fun openingAFoldReplansTheSameRowWithoutLosingItsAction() {
        var pane by mutableStateOf(411.dp)
        var checks = 0
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.width(pane)) {
                TodoLine("fold", HomeCardPlace(true, true), author = "Ada", onCheck = { checks++ }, mark = { TodoCheck(false) },
                    text = { TodoTextLabel("A long task that wraps across several lines on the folded phone and takes less room after the screen opens, while keeping its checkbox and author on the first line.", false) {} })
            }
        }
        val folded = rule.node("todo.row.fold.body").bounds
        assertDp("folded card width", 379, folded.width)
        rule.runOnIdle { pane = 700.dp }
        val opened = rule.node("todo.row.fold.body").bounds
        assertDp("opened card width", 640, opened.width)
        assertTrue("text rewraps at the new width", opened.height < folded.height)
        assertDp("author remains on first line", rule.node("todo.check.fold").bounds.top, rule.node("todo.author.fold").bounds.top)
        rule.node("todo.hit.fold").performClick()
        assertEquals(1, checks)
    }
}