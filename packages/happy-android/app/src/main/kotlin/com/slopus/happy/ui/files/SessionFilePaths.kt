package com.slopus.happy.ui.files

/** imageFiles.ts: formats worth showing as a picture; SVG is text and diffs as text. */
object ImageFiles {
    private val mimeTypes = mapOf(
        "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
        "gif" to "image/gif", "webp" to "image/webp", "bmp" to "image/bmp",
    )

    fun mimeType(path: String): String? {
        val dot = path.lastIndexOf('.')
        if (dot == -1) return null
        return mimeTypes[path.substring(dot + 1).lowercase()]
    }

    fun isImage(path: String) = mimeType(path) != null

    /** Already-base64 content as a `data:` URI; shell output's line breaks dropped. */
    fun dataUri(path: String, base64: String): String? {
        val mime = mimeType(path) ?: return null
        val clean = base64.replace(Regex("\\s+"), "")
        if (clean.isEmpty()) return null
        return "data:$mime;base64,$clean"
    }
}

/** sessionFileLinks.ts `SessionFileLink`. */
data class SessionFileLink(
    val path: String,
    val absolutePath: String,
    val relativePath: String?,
    val withinSessionRoot: Boolean,
    val line: Int?,
    val column: Int?,
)

/** sessionFileLinks.ts `resolveSessionFilePath`: a path, maybe `:line[:column]`, against the session's root. */
object SessionFilePaths {
    private val windowsAbsolute = Regex("^[A-Za-z]:[\\\\/]")
    private val fileUrl = Regex("^file://", RegexOption.IGNORE_CASE)

    fun resolve(path: String, sessionRoot: String?): SessionFileLink? {
        val trimmed = path.trim()
        var line: Int? = null
        var column: Int? = null
        var bare = trimmed
        Regex("^(.*):(\\d+):(\\d+)$").find(trimmed)?.let { m ->
            bare = m.groupValues[1]; line = m.groupValues[2].toIntOrNull(); column = m.groupValues[3].toIntOrNull()
        } ?: Regex("^(.*):(\\d+)$").find(trimmed)?.let { m ->
            bare = m.groupValues[1]; line = m.groupValues[2].toIntOrNull()
        }
        val absolute = resolvePath(bare, sessionRoot) ?: return null
        return SessionFileLink(normalize(bare), absolute, relativePath(absolute, sessionRoot), isWithinRoot(absolute, sessionRoot), line, column)
    }

    private fun decodeFileUrl(value: String): String {
        if (!fileUrl.containsMatchIn(value)) return value
        val stripped = value.replace(fileUrl, "")
        val normalized = if (stripped.startsWith("/")) stripped else "/$stripped"
        return runCatching { java.net.URLDecoder.decode(normalized.replace("+", "%2B"), "UTF-8") }.getOrDefault(normalized)
    }

    private fun home(root: String?): String? {
        root ?: return null
        return Regex("^([A-Za-z]:/Users/[^/]+|/Users/[^/]+|/home/[^/]+)").find(normalize(root))?.groupValues?.get(1)
    }

    private fun expandHome(value: String, root: String?): String {
        if (!value.startsWith("~/")) return value
        val home = home(root) ?: return value
        return "$home/${value.substring(2)}"
    }

    fun normalize(value: String): String {
        val slashes = value.replace('\\', '/')
        val windows = Regex("^[A-Za-z]:/").containsMatchIn(slashes)
        val posix = slashes.startsWith("/")
        val prefix = if (windows) slashes.substring(0, 2) + "/" else if (posix) "/" else ""
        val remainder = if (windows) slashes.substring(3) else if (posix) slashes.trimStart('/') else slashes
        val parts = ArrayList<String>()
        for (part in remainder.split('/')) {
            if (part.isEmpty() || part == ".") continue
            if (part == "..") {
                if (parts.isNotEmpty() && parts.last() != "..") parts.removeAt(parts.lastIndex)
                else if (prefix.isEmpty()) parts += part
                continue
            }
            parts += part
        }
        if (prefix.isEmpty()) return parts.joinToString("/")
        if (parts.isEmpty()) return prefix
        return prefix + parts.joinToString("/")
    }

    private fun resolvePath(path: String, root: String?): String? {
        val expanded = expandHome(decodeFileUrl(path), root)
        if (expanded.isEmpty()) return null
        if (windowsAbsolute.containsMatchIn(expanded) || expanded.startsWith("/")) return normalize(expanded)
        root ?: return null
        return normalize("${normalize(root)}/$expanded")
    }

    private fun isWithinRoot(path: String, root: String?): Boolean {
        root ?: return false
        val p = normalize(path)
        val r = normalize(root)
        return p == r || p.startsWith("$r/")
    }

    private fun relativePath(path: String, root: String?): String? {
        if (root == null || !isWithinRoot(path, root)) return null
        val p = normalize(path)
        val r = normalize(root)
        return if (p == r) "." else p.substring(r.length + 1)
    }
}
