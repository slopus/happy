package com.slopus.happy.vaults

/** How a file or an artifact opens on the phone. */
enum class VaultPreviewKind {
    /** A picture in the viewer, paged with the folder's other pictures and recordings. */
    Picture,
    /** A recording in the viewer, read a range at a time. */
    Video,
    Pdf,
    /** Text or source with its syntax; Markdown rendered with its source a tab away. */
    Text,
    /** An artifact entry, a live site. */
    Site,
    /** Nothing here reads it: share it, open it in another app or save it. */
    Other,
}

object VaultPreview {
    /** The most of a file read whole to show it as text (desktop's 2 MB). */
    const val TEXT_LIMIT = 2L * 1024 * 1024

    private val PICTURES = setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/heic", "image/heif", "image/avif")
    private val TEXT_TYPES = setOf(
        "application/json", "application/xml", "application/javascript", "application/x-javascript", "application/typescript",
        "application/x-sh", "application/x-yaml", "application/yaml", "application/toml", "application/sql", "image/svg+xml",
    )
    private val TEXT_EXTENSIONS = setOf(
        "txt", "text", "log", "csv", "tsv", "md", "markdown", "mdx", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
        "xml", "html", "htm", "css", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h",
        "cpp", "cc", "hpp", "m", "mm", "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "graphql", "proto", "lua", "r", "pl",
        "dart", "vue", "svelte", "scala", "gradle", "diff", "patch", "tex", "rst", "adoc", "svg",
    )

    fun kind(entry: VaultItem, size: Long? = entry.size): VaultPreviewKind {
        if (entry.isArtifact) return VaultPreviewKind.Site
        if (!entry.isFile) return VaultPreviewKind.Other
        val type = entry.mediaType?.substringBefore(';')?.trim()?.lowercase().orEmpty()
        val extension = entry.name.substringAfterLast('.', "").lowercase()
        return when {
            type in PICTURES -> VaultPreviewKind.Picture
            type.startsWith("video/") -> VaultPreviewKind.Video
            type == "application/pdf" -> VaultPreviewKind.Pdf
            (type.startsWith("text/") || type in TEXT_TYPES || extension in TEXT_EXTENSIONS) && (size ?: 0L) <= TEXT_LIMIT -> VaultPreviewKind.Text
            else -> VaultPreviewKind.Other
        }
    }

    /** Whether it opens in the picture viewer rather than on a page of its own. */
    fun inViewer(entry: VaultItem): Boolean = kind(entry).let { it == VaultPreviewKind.Picture || it == VaultPreviewKind.Video }
}
