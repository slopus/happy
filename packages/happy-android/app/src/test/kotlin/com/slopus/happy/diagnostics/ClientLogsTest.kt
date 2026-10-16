package com.slopus.happy.diagnostics

import org.junit.Assert.assertEquals
import org.junit.Test

/** copySessionMetadataAndLogsToClipboard's text. */
class ClientLogsTest {
    @Test
    fun metadataThenTheLogsWhenThereAreAny() {
        assertEquals("=== Session Metadata ===\n{}", ClientLogs.metadataAndLogs("{}", emptyList()))
        assertEquals(
            "=== Session Metadata ===\n{}\n\n=== Client Logs (2 entries) ===\na\nb",
            ClientLogs.metadataAndLogs("{}", listOf("a", "b")),
        )
    }
}
