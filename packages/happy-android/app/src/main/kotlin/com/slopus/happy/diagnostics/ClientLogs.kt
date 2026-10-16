package com.slopus.happy.diagnostics

/**
 * log.ts `log.getLogs()`, for copySessionMetadataAndLogsToClipboard.
 * happy-app keeps its own console in a 5,000-line buffer; on Android the
 * app's log is logcat, and an app may read its own lines from it. Empty
 * when logcat can't be read.
 */
object ClientLogs {
    /** log.ts MAX_APP_LOG_ENTRIES. */
    const val MAX_ENTRIES = 5000

    /** Blocking: run it off the main thread. */
    fun read(): List<String> = try {
        val process = ProcessBuilder("logcat", "-d", "-v", "threadtime", "-t", MAX_ENTRIES.toString(), "--pid=${android.os.Process.myPid()}")
            .redirectErrorStream(true)
            .start()
        val lines = process.inputStream.bufferedReader().use { it.readLines() }
        process.waitFor()
        if (process.exitValue() != 0) emptyList() else lines.filter { it.isNotBlank() && !it.startsWith("--------- beginning of") }
    } catch (_: Exception) {
        emptyList()
    }

    /** copySessionMetadataAndLogsToClipboard's text: the metadata, then the logs when there are any. */
    fun metadataAndLogs(metadataJson: String, logs: List<String>): String = buildList {
        add("=== Session Metadata ===")
        add(metadataJson)
        if (logs.isNotEmpty()) {
            add("")
            add("=== Client Logs (${logs.size} entries) ===")
            add(logs.joinToString("\n"))
        }
    }.joinToString("\n")
}
