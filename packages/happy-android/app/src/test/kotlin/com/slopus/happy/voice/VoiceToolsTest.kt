package com.slopus.happy.voice

import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class VoiceToolsTest {
    @Test fun oldCallCannotSendOrApproveAfterPermissionLookupSuspends() = runTest {
        var current = true
        var sent = false
        var approved = false
        val tools = VoiceTools({ _, _ -> sent = true }, { current = false; "owner" }, { _, _, _ -> approved = true }, {}, { current })
        assertEquals("error (voice session ended)", tools.execute("processPermissionRequest", mapOf("requestId" to "r", "decision" to "allow")))
        assertEquals("error (voice session ended)", tools.execute("sendMessageToSession", mapOf("sessionId" to "s", "message" to "hi")))
        assertFalse(sent); assertFalse(approved)
    }

    @Test fun validatesParametersAndRoutesToolsToExplicitSessionAndPermissionOwner() = runTest {
        val calls = mutableListOf<String>()
        val tools = VoiceTools(
            send = { id, message -> calls += "$id:$message" },
            permissionOwner = { if (it == "request") "background" else null },
            decide = { id, request, allow -> calls += "$id:$request:$allow" },
            sent = { calls += "count" },
        )
        assertEquals(VoiceTools.INVALID, tools.execute("sendMessageToSession", mapOf("sessionId" to 3, "message" to "test")))
        assertEquals(VoiceTools.INVALID, tools.execute("sendMessageToSession", mapOf("sessionId" to "s", "message" to "")))
        assertEquals(VoiceTools.INVALID, tools.execute("processPermissionRequest", mapOf("requestId" to "request", "decision" to "approve")))
        assertEquals("error (permission request not found)", tools.execute("processPermissionRequest", mapOf("requestId" to "gone", "decision" to "allow")))
        assertTrue(calls.isEmpty())
        assertEquals("sent [DO NOT say anything else, simply say 'sent']", tools.execute("sendMessageToSession", mapOf("sessionId" to "target", "message" to "work")))
        assertEquals("done [DO NOT say anything else, simply say 'done']", tools.execute("processPermissionRequest", mapOf("requestId" to "request", "decision" to "deny")))
        assertEquals(listOf("target:work", "count", "background:request:false"), calls)
    }

    @Test fun failedMessageDoesNotIncrementCounterAndFailedPermissionReturnsRnError() = runTest {
        var counted = false
        val tools = VoiceTools({ _, _ -> error("offline") }, { "s" }, { _, _, _ -> error("RPC failed") }, { counted = true })
        try { tools.execute("sendMessageToSession", mapOf("sessionId" to "s", "message" to "hello")); fail() } catch (_: IllegalStateException) {}
        assertFalse(counted)
        assertEquals("error (failed to allow permission)", tools.execute("processPermissionRequest", mapOf("requestId" to "r", "decision" to "allow")))
    }
}