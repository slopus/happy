package com.slopus.happy.ui.files

import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.PathParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * components/FileIcon.tsx's icons: @peoplesgrocers/seti-ui-file-icons
 * 1.11.3's lookup (the cases happy-ios checks against the package's own
 * `getIcon`) and the outlines tools/fileicons/generate-file-icons.py wrote.
 */
class FileIconsTest {
    @Test
    fun lookupMatchesThePackage() {
        val expected = listOf(
            Triple("package.json", "json", SetiColor.Yellow),
            Triple("index.ts", "typescript", SetiColor.Blue),
            Triple("App.tsx", "react", SetiColor.Blue),
            Triple("README.md", "info", SetiColor.Blue),
            Triple("Makefile", "makefile", SetiColor.Orange),
            Triple("Dockerfile", "docker", SetiColor.Blue),
            Triple("foo.test.ts", "typescript", SetiColor.Orange),
            Triple("a.d.ts", "typescript", SetiColor.Blue),
            Triple("archive.tar.gz", "default", SetiColor.White),
            Triple(".gitignore", "git", SetiColor.Ignore),
            Triple(".env", "config", SetiColor.GreyLight),
            Triple(".env.local", "default", SetiColor.White),
            Triple("Cargo.toml", "config", SetiColor.GreyLight),
            Triple("main.rs", "rust", SetiColor.GreyLight),
            Triple("notes", "default", SetiColor.White),
            Triple("", "default", SetiColor.White),
            Triple(".", "default", SetiColor.White),
            Triple("x.", "default", SetiColor.White),
            Triple("weird.unknownext", "default", SetiColor.White),
            Triple("TODO.md", "markdown", SetiColor.Blue),
            Triple("my.TODO.txt", "default", SetiColor.White),
            Triple("CMakeLists.txt", "default", SetiColor.White),
            Triple("Procfile", "heroku", SetiColor.Purple),
            Triple("docker-compose.yml", "yml", SetiColor.Purple),
            Triple("logo.png", "image", SetiColor.Purple),
            Triple("icon.svg", "svg", SetiColor.Purple),
            Triple("style.module.css", "css", SetiColor.Blue),
            Triple("view.html", "html", SetiColor.Orange),
            Triple("main.go", "go2", SetiColor.Blue),
            Triple("yarn.lock", "yarn", SetiColor.Blue),
            Triple("pnpm-lock.yaml", "yml", SetiColor.Purple),
            Triple("tsconfig.json", "tsconfig", SetiColor.Blue),
            Triple("tsconfig.base.json", "json", SetiColor.Yellow),
            Triple("vite.config.ts", "vite", SetiColor.Yellow),
            Triple("webpack.config.js", "webpack", SetiColor.Blue),
            Triple("Gemfile", "ruby", SetiColor.Red),
            Triple("build.gradle", "gradle", SetiColor.Blue),
            Triple("x.kt", "kotlin", SetiColor.Orange),
            Triple("a.R", "R", SetiColor.Blue),
            Triple("mix.exs", "elixir_script", SetiColor.Purple),
            Triple("z.ex", "elixir", SetiColor.Purple),
            Triple("q.pl", "perl", SetiColor.Blue),
            Triple("karma.conf.js", "karma", SetiColor.Green),
            Triple("spec.rb", "ruby", SetiColor.Red),
            Triple("é.swift", "swift", SetiColor.Orange),
            Triple("Ｋ.md", "markdown", SetiColor.Blue),
            Triple("gulpfile.js", "javascript", SetiColor.Yellow),
            Triple("LICENSE", "license", SetiColor.Yellow),
            Triple("license.txt", "default", SetiColor.White),
            Triple("jest.config.ts", "typescript", SetiColor.Blue),
        )
        for ((name, icon, color) in expected) {
            assertEquals(name, FileIcons.Entry(icon, color), FileIcons.lookup(name))
        }
    }

    @Test
    fun everyIconParses() {
        assertEquals("1.11.3", FileIcons.SOURCE_VERSION)
        assertEquals(151, FileIcons.allIcons.size)
        for (name in FileIcons.allIcons) {
            val outline = requireNotNull(FileIcons.outline(name))
            assertTrue(name, outline.viewBox.width > 0f && outline.shapes.isNotEmpty())
            for (shape in outline.shapes) {
                assertTrue(name, PathParser().parsePathString(shape.pathData).toNodes().isNotEmpty())
                assertTrue(name, shape.opacity > 0f && shape.opacity <= 1f)
            }
        }
    }

    @Test
    fun shapesKeepTheirRuleAndOpacity() {
        // font.svg: a 60% shape under a solid one.
        assertEquals(listOf(0.6f, 1f), FileIcons.outline("font")!!.shapes.map { it.opacity })
        // gradle draws through <use fill-rule="evenodd">.
        assertEquals(listOf(true), FileIcons.outline("gradle")!!.shapes.map { it.evenOdd })
        // prolog's two circles became closed curves.
        val prolog = FileIcons.outline("prolog")!!
        assertEquals(3, prolog.shapes.size)
        assertEquals(PathNode.Close, PathParser().parsePathString(prolog.shapes[1].pathData).toNodes().last())
        assertNotNull(FileIcons.outline(FileIcons.lookup("anything").icon))
    }
}
