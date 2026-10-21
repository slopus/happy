package com.slopus.happy.ui.files

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import com.slopus.happy.ui.theme.HappyTheme

/** A Seti theme colour name; [FileIcons.color] maps each to FileIcon.tsx's light or dark colour. */
enum class SetiColor(val wire: String) {
    Blue("blue"), Grey("grey"), GreyLight("grey-light"), Green("green"), Orange("orange"), Pink("pink"),
    Purple("purple"), Red("red"), White("white"), Yellow("yellow"), Ignore("ignore");

    companion object {
        fun of(wire: String) = entries.firstOrNull { it.wire == wire }
    }
}

/** One filled shape of a Seti icon, in its view box. */
class FileIconShape(val pathData: String, val evenOdd: Boolean, val opacity: Float)

class FileIconOutline(val viewBox: Rect, val shapes: List<FileIconShape>)

/**
 * components/FileIcon.tsx: @peoplesgrocers/seti-ui-file-icons 1.11.3's icon
 * for a file name, from the outlines tools/fileicons/generate-file-icons.py
 * wrote to resources/fileicons/seti.txt.
 */
object FileIcons {
    const val SOURCE_VERSION = "1.11.3"

    data class Entry(val icon: String, val color: SetiColor)

    private class Tables(
        val outlines: Map<String, FileIconOutline>,
        val files: Map<String, Entry>,
        val extensions: Map<String, Entry>,
        val partials: List<Pair<String, Entry>>,
        val default: Entry,
    )

    private val tables by lazy { load() }

    val allIcons: List<String> get() = tables.outlines.keys.sorted()

    fun outline(icon: String): FileIconOutline? = tables.outlines[icon]

    /**
     * The package's `getIcon(fileName)` (`getDetails`): an exact file name,
     * then the extension from the first dot, moving past one dot at a time,
     * then the first partial the name contains, then the default. Kotlin
     * strings compare code unit for code unit, as JavaScript's do.
     */
    fun lookup(fileName: String): Entry {
        val t = tables
        t.files[fileName]?.let { return it }
        var ext = jsSlice(fileName, fileName.indexOf('.'))
        while (ext.isNotEmpty()) {
            t.extensions[ext]?.let { return it }
            ext = ext.substring(1)
            ext = jsSlice(ext, ext.indexOf('.'))
        }
        for ((partial, entry) in t.partials) if (fileName.contains(partial)) return entry
        return t.default
    }

    /** `String.prototype.slice(start)`: a negative start counts from the end. */
    private fun jsSlice(s: String, start: Int) = s.substring(if (start < 0) maxOf(0, s.length + start) else minOf(start, s.length))

    /** FileIcon.tsx `lightColorTheme` / `darkColorTheme`. */
    fun color(color: SetiColor, dark: Boolean): Color = Color(
        (if (dark) {
            when (color) {
                SetiColor.Blue -> 0x268BD2; SetiColor.Grey -> 0xEEEEEE; SetiColor.GreyLight -> 0x839496
                SetiColor.Green -> 0x4BAE4F; SetiColor.Orange -> 0xCB4B16; SetiColor.Pink -> 0xD33682
                SetiColor.Purple -> 0x6C71C4; SetiColor.Red -> 0xDC322F; SetiColor.White -> 0xFDF6E3
                SetiColor.Yellow -> 0xFFCB29; SetiColor.Ignore -> 0x586E75
            }
        } else {
            when (color) {
                SetiColor.Blue -> 0x268BD2; SetiColor.Grey -> 0x6B7280; SetiColor.GreyLight -> 0x9CA3AF
                SetiColor.Green -> 0x059669; SetiColor.Orange -> 0xD97706; SetiColor.Pink -> 0xDB2777
                SetiColor.Purple -> 0x7C3AED; SetiColor.Red -> 0xDC2626; SetiColor.White -> 0x374151
                SetiColor.Yellow -> 0xEAB308; SetiColor.Ignore -> 0x9CA3AF
            }
        }).toLong() or 0xFF000000L,
    )

    private fun load(): Tables {
        val stream = requireNotNull(FileIcons::class.java.classLoader?.getResourceAsStream("fileicons/seti.txt")) { "fileicons/seti.txt missing" }
        val outlines = HashMap<String, FileIconOutline>()
        val files = HashMap<String, Entry>()
        val extensions = HashMap<String, Entry>()
        val partials = ArrayList<Pair<String, Entry>>()
        var default: Entry? = null
        var section = ""
        fun entry(icon: String, color: String) = Entry(icon, requireNotNull(SetiColor.of(color)) { "unknown Seti colour $color" })
        stream.bufferedReader().useLines { lines ->
            for (line in lines) {
                if (line.startsWith("#")) {
                    if (!line.startsWith("# ") && line != "#") section = line.substring(1)
                    continue
                }
                if (line.isEmpty()) continue
                when (section) {
                    "icons" -> {
                        val parts = line.split(' ', limit = 3)
                        val box = parts[1].split(',').map { it.toFloat() }
                        val shapes = parts[2].split(';').map { shape ->
                            val fields = shape.split(',', limit = 3)
                            FileIconShape(fields[2], fields[0] == "e", fields[1].toFloat())
                        }
                        outlines[parts[0]] = FileIconOutline(Rect(box[0], box[1], box[0] + box[2], box[1] + box[3]), shapes)
                    }
                    "files", "extensions", "partials" -> {
                        val (key, icon, color) = line.split(' ')
                        val value = entry(icon, color)
                        when (section) {
                            "files" -> files.putIfAbsent(key, value)
                            "extensions" -> extensions.putIfAbsent(key, value)
                            else -> partials += key to value
                        }
                    }
                    "default" -> line.split(' ').let { default = entry(it[0], it[1]) }
                }
            }
        }
        return Tables(outlines, files, extensions, partials, requireNotNull(default) { "fileicons/seti.txt has no #default" })
    }
}

object FileIconTags {
    const val ICON = "fileIcon"
}

/**
 * FileIcon.tsx: the Seti icon for [fileName], [size] square, filled with its
 * theme colour, the view box fitted and centred (`xMidYMid meet`).
 */
@Composable
fun FileIcon(fileName: String, size: Dp, modifier: Modifier = Modifier) {
    val entry = remember(fileName) { FileIcons.lookup(fileName) }
    val shapes = remember(entry.icon) {
        val outline = FileIcons.outline(entry.icon)
        outline to outline?.shapes?.map { shape ->
            PathParser().parsePathString(shape.pathData).toPath(Path()).apply {
                fillType = if (shape.evenOdd) PathFillType.EvenOdd else PathFillType.NonZero
            } to shape.opacity
        }.orEmpty()
    }
    val fill = FileIcons.color(entry.color, HappyTheme.colors.dark)
    Canvas(modifier = modifier.size(size).testTag(FileIconTags.ICON)) {
        val box = shapes.first?.viewBox ?: return@Canvas
        if (box.width <= 0f || box.height <= 0f) return@Canvas
        val scale = minOf(this.size.width / box.width, this.size.height / box.height)
        translate((this.size.width - box.width * scale) / 2f, (this.size.height - box.height * scale) / 2f) {
            withTransform({
                scale(scale, scale, pivot = androidx.compose.ui.geometry.Offset.Zero)
                translate(-box.left, -box.top)
            }) {
                for ((path, opacity) in shapes.second) drawPath(path, fill, alpha = opacity)
            }
        }
    }
}
