package com.slopus.happy.conversation.ui

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

/**
 * The vendored contract is what `tools/chat-ui/vendor.sh` copied: each file
 * hashes to what the script recorded beside the commit it read. A file
 * edited by hand, or copied without the script, fails here.
 */
class UiContractTest {
    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test fun `each vendored file hashes to what was recorded with its commit`() {
        val recorded = UiContract.record.getValue("sha256").jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(setOf(UiContract.SCHEMA, UiContract.FIXTURES), recorded.keys)
        for ((name, hash) in recorded) assertEquals("$name was changed since it was vendored: run tools/chat-ui/vendor.sh", hash, sha256(UiContract.bytes(name)))
        val commit = UiContract.record.getValue("commit").jsonPrimitive.content
        assertTrue("a whole commit id, not \"$commit\"", Regex("^[0-9a-f]{40}$").matches(commit))
    }
}
