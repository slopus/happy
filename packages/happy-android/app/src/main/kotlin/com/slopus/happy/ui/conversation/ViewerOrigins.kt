package com.slopus.happy.ui.conversation

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.positionOnScreen
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.GlobalPositionAwareModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.node.requireDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.conversation.PictureViewing
import kotlinx.coroutines.CompletableDeferred

/**
 * Where each thumbnail the viewer opens from sits on the screen, by the
 * viewer's key (Telegram's PhotoViewer asks its `PhotoViewerProvider` for
 * the `PlaceProviderObject` of the photo it shows). The viewer flies its
 * picture out of the thumbnail and back into it, and while it shows one the
 * thumbnail under it is [hidden], so the picture isn't there twice.
 * Positions are read as they are laid out, not as state: only the viewer's
 * opening and closing read them.
 */
@Stable
class ViewerOrigins {
    /** A thumbnail's bounds on the screen and its corners, in px. */
    data class Origin(val bounds: PictureViewing.Box, val radius: Float)

    private val placed = HashMap<String, Origin>()
    private val awaited = HashMap<String, CompletableDeferred<Unit>>()

    /** The thumbnail the viewer is showing, drawn as nothing meanwhile. */
    var hidden by mutableStateOf<String?>(null)

    operator fun get(key: String): Origin? = synchronized(placed) { placed[key] }

    internal fun place(key: String, origin: Origin) = synchronized(placed) { placed[key] = origin }

    internal fun forget(key: String) = synchronized(placed) { placed.remove(key) }

    /** Done once the thumbnail on [key] has drawn itself again: the viewer goes only then, so it never leaves a hole. */
    fun drawn(key: String): CompletableDeferred<Unit> = synchronized(awaited) { awaited.getOrPut(key) { CompletableDeferred() } }

    internal fun drew(key: String) {
        synchronized(awaited) { awaited.remove(key) }?.complete(Unit)
    }

    companion object {
        /** The app's one: keys name their conversation, artifact or gallery, so they don't meet. */
        val Shared = ViewerOrigins()
    }
}

/** This thumbnail opens the viewer on [key]: the viewer flies from it and back into it ([ViewerOrigins]). */
fun Modifier.viewerOrigin(key: String, radius: Dp = 0.dp): Modifier =
    this.then(ViewerOriginElement(key, radius))

/** Says where its thumbnail is as it is laid out, forgets it once the thumbnail is gone, not as it recomposes, and draws nothing while it is [ViewerOrigins.hidden]. */
private data class ViewerOriginElement(val key: String, val radius: Dp) : ModifierNodeElement<ViewerOriginNode>() {
    override fun create() = ViewerOriginNode(key, radius)

    override fun update(node: ViewerOriginNode) {
        if (node.key != key) node.forget()
        node.key = key
        node.radius = radius
        node.invalidateDraw()
    }
}

private class ViewerOriginNode(var key: String, var radius: Dp) : Modifier.Node(), GlobalPositionAwareModifierNode, DrawModifierNode {
    private val origins = ViewerOrigins.Shared

    override fun ContentDrawScope.draw() {
        if (origins.hidden == key) return
        drawContent()
        origins.drew(key)
    }

    override fun onGloballyPositioned(coordinates: LayoutCoordinates) {
        if (!coordinates.isAttached) return
        val at = coordinates.positionOnScreen()
        val corner = with(requireDensity()) { radius.toPx() }
        origins.place(key, ViewerOrigins.Origin(PictureViewing.Box(at.x, at.y, coordinates.size.width.toFloat(), coordinates.size.height.toFloat()), corner))
    }

    fun forget() {
        if (isAttached) origins.forget(key)
    }

    override fun onDetach() {
        origins.forget(key)
    }
}
