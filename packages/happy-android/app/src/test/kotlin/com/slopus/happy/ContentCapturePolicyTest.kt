package com.slopus.happy

import android.view.View
import android.util.SparseArray
import android.view.autofill.AutofillValue
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.contentcapture.ContentCaptureManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Content capture is not accessibility or autofill; opting out must keep both semantics. */
@OptIn(ExperimentalComposeUiApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE, sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ContentCapturePolicyTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun privateContentIsNotCapturedButActionsAndAutofillRemain() {
        assertFalse(ContentCaptureManager.isEnabled)
        var clicked = false
        lateinit var view: View
        rule.setHappyContent {
            view = LocalView.current
            var value by remember { mutableStateOf("") }
            Column {
                Text("Private conversation")
                Button(onClick = { clicked = true }) { Text("Open settings") }
                TextField(
                    value = value,
                    onValueChange = { value = it },
                    label = { Text("Username") },
                    modifier = Modifier.semantics { contentType = ContentType.Username },
                )
            }
        }
        rule.onNodeWithText("Private conversation").assertExists()
        rule.assertActionsLabelled()
        rule.onNodeWithText("Open settings").performClick()
        assertEquals(true, clicked)
        val field = rule.onNodeWithText("Username")
        assertEquals(ContentType.Username, field.fetchSemanticsNode().config[SemanticsProperties.ContentType])
        field.performTextInput("Steve")
        field.assertTextContains("Steve")
        val fieldId = field.fetchSemanticsNode().id
        rule.runOnIdle {
            assertNotEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, view.importantForAccessibility)
            assertNotEquals(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS, view.importantForAutofill)
            // The same virtual-view entry point an AutofillService uses, not test text input.
            view.autofill(SparseArray<AutofillValue>().apply { put(fieldId, AutofillValue.forText("Autofilled")) })
        }
        field.assertTextContains("Autofilled")
    }
}