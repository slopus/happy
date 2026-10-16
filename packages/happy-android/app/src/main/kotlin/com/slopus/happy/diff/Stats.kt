package com.slopus.happy.diff

/** happy-app engine/stats.ts: `+N −M` without building a document. */
object DiffStats {
    data class Counts(val additions: Int, val deletions: Int)

    /** countPatchStats: changed lines in a patch, in one pass. */
    fun countPatch(patch: String): Counts {
        var additions = 0
        var deletions = 0
        var inHunk = false
        var index = 0
        while (index < patch.length) {
            var end = patch.indexOf('\n', index)
            if (end == -1) end = patch.length
            val first = patch[index]
            if (first == '@' && patch.startsWith("@@", index)) {
                inHunk = true
            } else if (inHunk) {
                when {
                    first == '+' && !patch.startsWith("+++", index) -> additions++
                    first == '-' && !patch.startsWith("---", index) -> deletions++
                    first == 'd' && patch.startsWith("diff ", index) -> inHunk = false
                }
            }
            index = end + 1
        }
        return Counts(additions, deletions)
    }

    /** countContentStats: the same numbers for two blobs, from the line diff the renderer uses. */
    fun countContents(oldText: String, newText: String): Counts {
        var additions = 0
        var deletions = 0
        for (change in MyersDiff.diffLines(oldText, newText).orEmpty()) {
            if (!change.added && !change.removed) continue
            val count = JsText.lines(change.value, dropTrailingEmpty = true).size
            if (change.added) additions += count else deletions += count
        }
        return Counts(additions, deletions)
    }
}
