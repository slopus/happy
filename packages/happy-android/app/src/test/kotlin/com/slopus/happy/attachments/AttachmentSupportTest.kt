package com.slopus.happy.attachments

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** attachmentSupport.test.ts */
class AttachmentSupportTest {
    @Test
    fun flavorsThatTakeImages() {
        listOf(null, "", "claude", "codex").forEach { assertTrue("$it", supportsImageAttachmentsForFlavor(it)) }
        listOf("gemini", "openclaw", "custom-agent").forEach { assertFalse(it, supportsImageAttachmentsForFlavor(it)) }
    }

    @Test
    fun sendPlans() {
        assertEquals(
            ImageAttachmentSendPlan(supportsAttachments = true, shouldUseAttachments = true, shouldShowUnsupportedAlert = false, shouldSendText = true),
            imageAttachmentSendPlan(flavor = "codex", text = "", attachmentCount = 1),
        )
        assertEquals(
            ImageAttachmentSendPlan(supportsAttachments = false, shouldUseAttachments = false, shouldShowUnsupportedAlert = true, shouldSendText = true),
            imageAttachmentSendPlan(flavor = "gemini", text = "describe this", attachmentCount = 1),
        )
        assertEquals(
            ImageAttachmentSendPlan(supportsAttachments = false, shouldUseAttachments = false, shouldShowUnsupportedAlert = true, shouldSendText = false),
            imageAttachmentSendPlan(flavor = "openclaw", text = "   ", attachmentCount = 2),
        )
    }

    @Test
    fun rigPolicy() {
        assertTrue(imageAttachmentSendPlan(flavor = "custom", text = "", attachmentCount = 1, supportsAttachments = true).shouldUseAttachments)
        val policy = AttachmentPolicy(maxBytes = 10.0, mediaTypes = listOf("image/*"))
        assertTrue(isAttachmentAllowedByPolicy("image/png", 10, policy))
        assertFalse(isAttachmentAllowedByPolicy("image/png", 11, policy))
        assertFalse(isAttachmentAllowedByPolicy("application/pdf", 5, policy))
        // An unknown size passes; exact types match exactly.
        assertTrue(isAttachmentAllowedByPolicy("image/jpeg", 0, AttachmentPolicy(1.0, listOf("image/jpeg"))))
        assertFalse(isAttachmentAllowedByPolicy("image/png", 0, AttachmentPolicy(1.0, listOf("image/jpeg"))))
    }
}
