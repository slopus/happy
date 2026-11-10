package com.slopus.happy.conversation.ui

/**
 * A `file_tree`'s paths as lines under their folders: each folder once,
 * with everything in it under it, in the order the paths first name them.
 * A path that ends in "/" is a folder.
 */
object UiFileTree {
    data class Line(val name: String, val depth: Int, val folder: Boolean)

    private class Node(val folder: Boolean) {
        val children = LinkedHashMap<String, Node>()
    }

    fun lines(paths: List<String>): List<Line> {
        val root = Node(true)
        for (path in paths) {
            val parts = path.split('/').filter { it.isNotEmpty() }
            var node = root
            parts.forEachIndexed { index, name ->
                val folder = index < parts.lastIndex || path.endsWith("/")
                // A folder and a file may share a name: they are two lines.
                node = node.children.getOrPut((if (folder) "/" else "") + name) { Node(folder) }
            }
        }
        val lines = ArrayList<Line>()
        fun walk(node: Node, depth: Int) {
            for ((key, child) in node.children) {
                lines += Line(key.removePrefix("/"), depth, child.folder)
                walk(child, depth + 1)
            }
        }
        walk(root, 0)
        return lines
    }
}
