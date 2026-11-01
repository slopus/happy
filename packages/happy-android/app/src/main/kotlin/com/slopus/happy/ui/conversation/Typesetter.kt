package com.slopus.happy.ui.conversation

import android.content.Context
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.createFontFamilyResolver
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.LiveText
import com.slopus.happy.conversation.RowTypesetter
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.IoniconsFamily
import com.slopus.happy.ui.layout.ContentTokens
import com.slopus.happy.ui.layout.WidthClass
import com.slopus.happy.ui.theme.DarkColors
import com.slopus.happy.ui.theme.LightColors
import com.slopus.happy.ui.theme.RnLineHeightStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.coroutines.CoroutineContext
import kotlin.math.roundToInt

/**
 * The transcript's text, laid out before the screen draws it
 * (research/telegram-chat.md, phase 3), one per process: Telegram's
 * `MessageObject.generateLayout`, run where the rows are built.
 *
 * - **Where.** A conversation calls [prepare] on its lane with each set of
 *   rows it publishes, and [live] with a streaming block's words before
 *   its row reads them. The newest rows, about two screens, are laid out
 *   there and then; the rest on this typesetter's own [lane] straight after.
 * - **What.** Each answer, person's message, collaborator's message and
 *   opened thought becomes a [Prose] for the column's [geometry]: Compose's
 *   own text layouts at their places, which the row draws without measuring.
 * - **Kept** by row key ([ProseSource.key], a message and its block), with
 *   the words and the geometry they were laid out for; the most recently
 *   drawn [MAX_ENTRIES].
 * - **A new width** (fold or unfold, rotation, a pane) makes every kept
 *   layout stale: rows draw the old one scaled to the new width while this
 *   lane lays them out again, the rows drawn last first, and [version] moves
 *   so they pick the new ones up. Nothing is laid out again on the main thread.
 * - **A miss** (a row the lane never saw, as in a component test) is laid
 *   out where it is asked, on the main thread, and [ProseThread] counts it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class Typesetter internal constructor(private val context: Context) : RowTypesetter {
    private class Entry(val source: ProseSource, val prose: Prose)

    private val resolver = createFontFamilyResolver(context)
    private val builders = ThreadLocal.withInitial { ProseBuilder(resolver) }

    /** Where the rows past the first screens, and every row after a new width, are laid out. */
    val lane: CoroutineContext = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + lane)

    private val entries = object : LinkedHashMap<String, Entry>(256, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?) = size > MAX_ENTRIES
    }
    private val glyphs = HashMap<Any, TextLayoutResult>()

    /** The column the rows are laid out for: the window's, until a row reports the one it is in. */
    @Volatile
    var geometry: ProseGeometry = estimate()
        private set

    /**
     * The colours rows are drawn ahead in ([Prose.record]): the system
     * theme's, until a row reports the theme it is drawn in.
     */
    @Volatile
    var palette: ProsePalette = ProsePalette.of(if (night()) DarkColors else LightColors)
        private set

    private val _version = mutableIntStateOf(0)

    /** Moves when layouts for a new geometry are in; rows read it so they draw them. */
    val version: Int get() = _version.intValue

    private var rest: Job? = null
    private var relayout: Job? = null
    private var redraw: Job? = null

    private fun night(): Boolean =
        context.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK == android.content.res.Configuration.UI_MODE_NIGHT_YES

    /** The window's content column as this process's configuration has it, before anything is measured. */
    private fun estimate(): ProseGeometry {
        val configuration = context.resources.configuration
        val density = Density(context)
        val window = configuration.screenWidthDp.dp
        val tokens = ContentTokens.of(WidthClass.of(window))
        val px = with(density) { window.roundToPx() }
        val column = with(density) {
            val held = px - 2 * tokens.gutter.coerceAtLeast(0.dp).roundToPx()
            if (tokens.columnMaxWidth == Dp.Infinity) held else minOf(held, tokens.columnMaxWidth.roundToPx())
        }
        return ProseGeometry(column, density, configuration.layoutDirection == android.view.View.LAYOUT_DIRECTION_RTL)
    }

    private val screenHeight: Int get() = (context.resources.configuration.screenHeightDp * context.resources.displayMetrics.density).roundToInt()

    private fun builder(): ProseBuilder = builders.get()!!

    /** The layout kept for [source] at [geometry], if it is that one. */
    private fun fresh(source: ProseSource, geometry: ProseGeometry): Prose? {
        val entry = synchronized(entries) { entries[source.key] } ?: return null
        return entry.prose.takeIf { entry.source.same(source) && it.geometry == geometry }
    }

    private fun put(prose: Prose) {
        synchronized(entries) { entries[prose.source.key] = Entry(prose.source, prose) }
    }

    /**
     * Lays [source] out at [geometry] here, on the layout kept for its row
     * where blocks are the same, and with [drawn], draws it ahead in [palette].
     */
    internal fun build(source: ProseSource, geometry: ProseGeometry, drawn: Boolean = true): Prose {
        val previous = synchronized(entries) { entries[source.key] }?.prose
        val prose = builder().build(source, geometry, previous)
        if (drawn) prose.record(palette)
        put(prose)
        return prose
    }

    /**
     * A row is drawn in [next]: from now on rows are drawn ahead in it, and
     * every kept row is drawn again on [lane], the most recently drawn first.
     * Until then rows draw their texts themselves.
     */
    fun reportPalette(next: ProsePalette) {
        if (next == palette) return
        palette = next
        redraw?.cancel()
        redraw = scope.launch {
            for (entry in synchronized(entries) { entries.values.toList() }.asReversed()) {
                ensureActive()
                entry.prose.record(next)
            }
        }
    }

    /**
     * What a row draws for [source] at [geometry]: the layout made ahead, a
     * stale one (another width) while the new one is made on [lane], or, for
     * a row nothing laid out, one made here.
     */
    fun prose(source: ProseSource, geometry: ProseGeometry): Prose {
        val entry = synchronized(entries) { entries[source.key] }
        if (entry != null && entry.source.same(source)) {
            if (entry.prose.geometry == geometry) return entry.prose
            report(geometry)
            return entry.prose
        }
        // Drawing it ahead here would only shape its glyphs on the main thread twice.
        return build(source, geometry, drawn = false)
    }

    /** The prose kept for [source] at [geometry], or null; never lays anything out. */
    fun peek(source: ProseSource, geometry: ProseGeometry = this.geometry): Prose? = fresh(source, geometry)

    /**
     * A row found itself in [next]: from now on rows are laid out for it, and
     * every kept row is laid out again on [lane], the most recently drawn first.
     */
    fun report(next: ProseGeometry) {
        if (next == geometry) return
        geometry = next
        relayout?.cancel()
        relayout = scope.launch {
            val stale = synchronized(entries) { entries.values.toList() }.asReversed().filter { it.prose.geometry != next }
            stale.forEachIndexed { index, entry ->
                ensureActive()
                if (fresh(entry.source, next) == null) build(entry.source, next)
                // The rows on screen were drawn last: they come back first.
                if (index == FIRST_BATCH) _version.intValue++
            }
            warm(next)
            _version.intValue++
        }
    }

    /** A row of the column [column] wide reports it ([report]) if it isn't the one rows are laid out for. */
    fun reportColumn(column: Int, density: Density, rtl: Boolean) {
        val now = geometry
        val next = now.withColumn(column).at(density, rtl)
        if (next != now) report(next)
    }

    override fun prepare(rows: List<ConversationRow>) {
        val geometry = geometry
        warm(geometry)
        var height = 0
        val budget = 2 * screenHeight
        var later: ArrayList<ProseSource>? = null
        for (row in rows) {
            val source = sourceOf(row)
            if (source == null) {
                height += geometry.px(OTHER_ROW)
                continue
            }
            // A streaming answer draws its words in as they come, not ahead ([live]).
            val drawn = !(row is ConversationRow.Text && row.live != null)
            val prose = fresh(source, geometry)
            when {
                height >= budget -> if (prose == null || (drawn && !prose.recorded(palette))) (later ?: ArrayList<ProseSource>().also { later = it }) += source
                prose != null -> {
                    if (drawn) prose.record(palette)
                    height += prose.height()
                }
                else -> height += build(source, geometry, drawn).height()
            }
        }
        val rest = later ?: return
        this.rest?.cancel()
        this.rest = scope.launch {
            for (source in rest) {
                ensureActive()
                val now = this@Typesetter.geometry
                val prose = fresh(source, now)
                if (prose == null) build(source, now) else prose.record(palette)
            }
        }
    }

    override fun live(key: String, content: LiveText.Content, markdown: Boolean) {
        val geometry = geometry
        val source = if (markdown) {
            ProseSource(key, ProseKind.Answer, content.text, content.blocks)
        } else {
            // A thought is laid out only once its row was opened.
            if (synchronized(entries) { entries[key] } == null) return
            ProseSource(key, ProseKind.Reasoning, content.text, emptyList())
        }
        if (fresh(source, geometry) == null) build(source, geometry, drawn = false)
    }

    /** What [row] lays out, or null for a row with no prose (tools, pictures, failures). */
    fun sourceOf(row: ConversationRow): ProseSource? = when (row) {
        is ConversationRow.Text -> row.live?.content?.value?.let { ProseSource(row.key, ProseKind.Answer, it.text, it.blocks) }
            ?: ProseSource(row.key, ProseKind.Answer, row.text, row.blocks)
        is ConversationRow.User -> row.text.takeIf { it.isNotEmpty() }?.let { ProseSource(row.key, ProseKind.User, it, row.blocks) }
        is ConversationRow.Collaborator -> ProseSource(row.key, ProseKind.Collaborator, row.text, row.blocks, collaboratorLabel)
        // A thought is laid out when its row opens; until then it is its one line.
        is ConversationRow.Reasoning -> synchronized(entries) { entries[row.key] }?.let { ProseSource(row.key, ProseKind.Reasoning, row.current, emptyList()) }
        else -> null
    }

    private val collaboratorLabel: String get() = context.getString(R.string.conversation_from_agent)

    /** The collaborator row's label, as its source has it. */
    fun collaborator(row: ConversationRow.Collaborator): ProseSource = sourceOf(row)!!

    /**
     * One of the rows' own small texts (an icon glyph, the thinking line), at
     * [geometry]; made on the lane ahead of the rows ([warm]), here if not.
     */
    internal fun small(key: Any, geometry: ProseGeometry, make: (ProseBuilder) -> TextLayoutResult): TextLayoutResult {
        val full = Pair(key, geometry)
        synchronized(glyphs) { glyphs[full] }?.let { return it }
        val made = make(builder())
        synchronized(glyphs) { glyphs[full] = made }
        return made
    }

    /** [icon] as [com.slopus.happy.ui.components.Icon] draws it, [size] square. */
    fun glyph(icon: Ionicon, size: Dp, geometry: ProseGeometry): TextLayoutResult = small(GlyphKey(icon, size), geometry) { builder ->
        val fontSize = with(geometry.density) { size.toSp() }
        val style = TextStyle(fontFamily = IoniconsFamily, fontSize = fontSize, lineHeight = fontSize, lineHeightStyle = RnLineHeightStyle)
        builder.measure(AnnotatedString(String(Character.toChars(icon.codepoint))), style, Constraints(), geometry)
    }

    /** A one-line [text] in [style], unbounded, as a Text with no width limit measures it. */
    fun line(text: String, style: TextStyle, geometry: ProseGeometry): TextLayoutResult = small(LineKey(text, style), geometry) { builder ->
        builder.measure(AnnotatedString(text), style, Constraints(), geometry)
    }

    private data class GlyphKey(val icon: Ionicon, val size: Dp)
    private data class LineKey(val text: String, val style: TextStyle)

    private var warmed: ProseGeometry? = null

    /** The rows' glyphs and lines, laid out for [geometry] before a row asks. */
    private fun warm(geometry: ProseGeometry) {
        if (warmed == geometry) return
        warmed = geometry
        for (icon in WARM_GLYPHS) glyph(icon, MessageSpec16, geometry)
        line(context.getString(R.string.session_info_thinking), ConversationRowSpec.label, geometry)
    }

    companion object {
        /** Kept layouts: a long chat's answers several times over. */
        const val MAX_ENTRIES = 1_200

        /** Rows laid out again first after a new width before the screen is told: about a screen's worth. */
        private const val FIRST_BATCH = 16

        /** What a row with no prose is counted as against the first screens. */
        private val OTHER_ROW = 48.dp

        private val MessageSpec16 = 16.dp
        private val WARM_GLYPHS = listOf(Ionicon.CopyOutline, Ionicon.Checkmark, Ionicon.ChevronDown, Ionicon.ChevronUp)

        @Volatile private var instance: Typesetter? = null

        /** The process's typesetter. */
        fun of(context: Context): Typesetter {
            val app = context.applicationContext ?: context
            instance?.takeIf { it.context === app }?.let { return it }
            return synchronized(this) {
                instance?.takeIf { it.context === app } ?: Typesetter(app).also { instance = it }
            }
        }

        private fun Prose.height(): Int = segments.sumOf { (it as? DrawnSegment)?.height ?: 0 }
    }
}
