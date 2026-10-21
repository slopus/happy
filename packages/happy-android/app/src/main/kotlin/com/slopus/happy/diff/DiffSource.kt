package com.slopus.happy.diff

/**
 * useDiffDocument.ts `DiffSource`: what a diff is drawn from, a unified
 * patch or a before/after pair. A pair may carry its own context, whitespace
 * and budget; the options passed to [build] win over them.
 */
sealed interface DiffSource {
    data class Patch(val patch: String) : DiffSource

    data class Contents(
        val path: String,
        val oldText: String,
        val newText: String,
        val contextLines: Int? = null,
        val ignoreWhitespace: Boolean? = null,
        val diffBudget: DiffBudget? = null,
    ) : DiffSource

    /** UTF-16 units of input, to decide whether building can happen in place. */
    val size: Int get() = when (this) {
        is Patch -> patch.length
        is Contents -> oldText.length + newText.length
    }

    /**
     * `useDiffDocument`'s build. [contextLines] and [ignoreWhitespace] are the
     * caller's overrides (null: the source's own, then the defaults).
     */
    fun build(contextLines: Int? = null, ignoreWhitespace: Boolean? = null): DiffDocument = when (this) {
        is Patch -> DiffBuilder.fromPatch(patch, BuildOptions(contextLines = contextLines ?: 3, ignoreWhitespace = ignoreWhitespace ?: false))
        is Contents -> DiffBuilder.fromContents(
            path,
            oldText,
            newText,
            BuildOptions(
                contextLines = contextLines ?: this.contextLines ?: 3,
                ignoreWhitespace = ignoreWhitespace ?: this.ignoreWhitespace ?: false,
                diffBudget = diffBudget,
            ),
        )
    }
}
