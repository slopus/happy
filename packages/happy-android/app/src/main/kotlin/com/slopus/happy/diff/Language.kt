package com.slopus.happy.diff

/** happy-app engine/language.ts: the Prism grammar id for a file name. */
object DiffLanguage {
    private val byExtension = mapOf(
        "ts" to "typescript", "tsx" to "tsx", "mts" to "typescript", "cts" to "typescript",
        "js" to "javascript", "jsx" to "jsx", "mjs" to "javascript", "cjs" to "javascript",
        "json" to "json", "jsonc" to "json", "json5" to "json",
        "py" to "python", "pyi" to "python", "rb" to "ruby", "go" to "go", "rs" to "rust",
        "java" to "java", "kt" to "kotlin", "kts" to "kotlin", "swift" to "swift",
        "m" to "objectivec", "mm" to "objectivec", "c" to "c", "h" to "c",
        "cc" to "cpp", "cpp" to "cpp", "cxx" to "cpp", "hpp" to "cpp", "cs" to "csharp", "php" to "php",
        "sh" to "bash", "bash" to "bash", "zsh" to "bash", "fish" to "bash", "ps1" to "powershell",
        "sql" to "sql", "css" to "css", "scss" to "scss", "sass" to "scss", "less" to "less",
        "html" to "markup", "htm" to "markup", "xml" to "markup", "svg" to "markup", "vue" to "markup",
        "md" to "markdown", "mdx" to "markdown", "yml" to "yaml", "yaml" to "yaml", "toml" to "toml",
        "ini" to "ini", "cfg" to "ini", "env" to "bash", "dart" to "dart", "ex" to "elixir", "exs" to "elixir",
        "erl" to "erlang", "hs" to "haskell", "lua" to "lua", "r" to "r", "scala" to "scala",
        "graphql" to "graphql", "gql" to "graphql", "proto" to "protobuf", "tf" to "hcl", "hcl" to "hcl",
        "zig" to "zig", "nim" to "nim", "pl" to "perl", "diff" to "diff", "patch" to "diff",
    )

    private val byFileName = mapOf(
        "dockerfile" to "docker", "makefile" to "makefile", "cmakelists.txt" to "cmake",
        "gemfile" to "ruby", "rakefile" to "ruby", ".gitignore" to "ignore", ".npmrc" to "ini", ".editorconfig" to "ini",
    )

    /** detectLanguage. */
    fun detect(path: String?): String? {
        if (path.isNullOrEmpty()) return null
        val name = path.substringAfterLast('/').lowercase()
        byFileName[name]?.let { return it }
        val dot = name.lastIndexOf('.')
        if (dot == -1 || dot == name.length - 1) return null
        return byExtension[name.substring(dot + 1)]
    }
}
