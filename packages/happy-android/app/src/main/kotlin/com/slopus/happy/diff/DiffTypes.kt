package com.slopus.happy.diff

/*
 * happy-app components/diff/engine/types.ts: the diff renderer's data
 * model. Everything here is theme-independent and immutable: the expensive
 * work (parsing, tokenizing, word diffs) happens once per input and is
 * cached, and the UI only maps a SpanKind to a colour and draws.
 */

/** Prism-ish token classes, collapsed to a small palette. [wire] is happy-app's name. */
enum class SpanKind(val wire: String) {
    Plain("plain"),
    Keyword("keyword"),
    Str("string"),
    Comment("comment"),
    Number("number"),
    Function("function"),
    Operator("operator"),
    Punctuation("punctuation"),
    Type("type"),
    Variable("variable"),
    Tag("tag"),
    Attr("attr"),
}

/** Word-diff emphasis on a run: none, inserted or deleted (happy-app's 0, 1, 2). */
enum class SpanEmphasis { None, Inserted, Deleted }

/** One styled run of text inside a rendered line. */
data class DiffSpan(val text: String, val kind: SpanKind, val emphasis: SpanEmphasis)

enum class DiffLineType(val wire: String) { Add("add"), Del("del"), Ctx("ctx") }

/** One rendered row. Rows are flat so a list can show them directly. */
sealed interface DiffRow {
    /** Stable, unique within a file. */
    val key: String

    data class Line(
        override val key: String,
        val type: DiffLineType,
        /** 1-based line on the old side, null for additions. */
        val oldNo: Int?,
        /** 1-based line on the new side, null for deletions. */
        val newNo: Int?,
        /** Without the +/- marker; tabs expanded. */
        val text: String,
        val spans: List<DiffSpan>,
    ) : DiffRow

    data class Hunk(
        override val key: String,
        /** `@@ -1,7 +1,9 @@` */
        val text: String,
        /** What git puts after the `@@`, e.g. a function name. */
        val section: String,
        /** Unchanged lines hidden above this hunk, when known. */
        val hidden: Int?,
    ) : DiffRow

    data class Message(override val key: String, val code: Code) : DiffRow {
        enum class Code(val wire: String) { Binary("binary"), Empty("empty") }
    }
}

enum class FileChangeKind(val wire: String) {
    Modified("modified"),
    Added("added"),
    Deleted("deleted"),
    Renamed("renamed"),
    Binary("binary"),
}

/** One file's diff, ready to render. */
data class DiffFile(
    /** Shown to the user: the new path for renames. */
    val path: String,
    /** The previous path, only for renames. */
    val oldPath: String?,
    val kind: FileChangeKind,
    /** Prism grammar id, for syntax colouring. */
    val language: String?,
    val additions: Int,
    val deletions: Int,
    val rows: List<DiffRow>,
    /** Longest row in characters: the horizontal scroll width. */
    val maxColumns: Int,
    /** Widest line number: the gutter width. */
    val maxLineNo: Int,
)

data class DiffDocument(
    val files: List<DiffFile>,
    val additions: Int,
    val deletions: Int,
    /** Wall-clock milliseconds spent building it. */
    val buildMs: Double = 0.0,
    /** Informational failure, such as a contents diff that ran out of budget. */
    val error: String? = null,
) {
    companion object {
        val Empty = DiffDocument(emptyList(), 0, 0)
    }
}
