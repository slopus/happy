package com.slopus.happy.ui.attach

import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import com.slopus.happy.attachments.PickedMedia

/**
 * What is picked in the attachment sheet, in the order it was picked:
 * Telegram numbers each pick by that order, and unpicking one renumbers
 * the rest at once. At most [maxItems].
 */
@Stable
class AttachSelection(val maxItems: Int) {
    private val picks = mutableStateListOf<PickedMedia>()

    val items: List<PickedMedia> get() = picks
    val count: Int get() = picks.size

    /** The pick's number, from 1; 0 when it isn't picked. */
    fun number(key: String): Int = picks.indexOfFirst { it.key == key } + 1

    fun isPicked(key: String): Boolean = number(key) > 0

    /** Picks [item], or unpicks it when it is picked. False when it can't be picked: [maxItems] are. */
    fun toggle(item: PickedMedia): Boolean {
        val at = picks.indexOfFirst { it.key == item.key }
        if (at >= 0) {
            picks.removeAt(at)
            return true
        }
        if (picks.size >= maxItems) return false
        picks += item
        return true
    }

    /** Picks [item] if it isn't already. False when there is no room. */
    fun pick(item: PickedMedia): Boolean = isPicked(item.key) || toggle(item)

    fun clear() = picks.clear()
}
