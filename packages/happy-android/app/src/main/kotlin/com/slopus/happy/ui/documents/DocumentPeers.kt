package com.slopus.happy.ui.documents

import android.icu.text.ListFormatter
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.documents.DocumentPeer
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

/**
 * iOS's `DocumentPeersLayout.Metrics` and `DocumentCursorLayout.Metrics`:
 * faces 28 across, each 8 over the one before, at most 3 then "+N" 4
 * after, ringed 2 in the page's colour; a cursor's bar 2 wide, its name on
 * a 16 tall tag 4 in, shown 3 s after they move.
 */
object DocumentPeersSpec {
    val face = 28.dp
    val overlap = 8.dp
    const val MOST = 3
    val ring = 2.dp
    val moreGap = 4.dp
    val target = 48.dp
    val bar = 2.dp
    val label = 16.dp
    val labelPadding = 4.dp
    val labelCorner = 4.dp
    val labelMost = 200.dp
    const val LABEL_SIZE = 11f
    const val LABEL_MILLIS = 3_000L
}

object DocumentPeersTags {
    const val PEERS = "document.peers"
    fun face(index: Int) = "document.peers.$index"
    const val MORE = "document.peers.more"
}

/** Desktop's `#rrggbb` as a colour; grey for anything else. */
internal fun peerColorInt(css: String): Int = runCatching { android.graphics.Color.parseColor(css) }.getOrDefault(0xFF888888.toInt())

/** iOS's `Strings.Documents.editing`: "Ann is here", "Ann, Bo and Cy are here", the names listed as the locale lists them. */
@Composable
internal fun peersHere(names: List<String>): String {
    val locale = LocalConfiguration.current.locales[0]
    return when (names.size) {
        0 -> ""
        1 -> stringResource(R.string.document_here_one, names[0])
        else -> stringResource(R.string.document_here_many, ListFormatter.getInstance(locale).format(names))
    }
}

/**
 * Who else has the document open, beside its title (iOS's
 * `DocumentPeersView`): a face for each in their cursor's colour with
 * their initial, as desktop's participant chips; choosing them lists
 * their names.
 */
@Composable
fun DocumentPeers(peers: List<DocumentPeer>) {
    if (peers.isEmpty()) return
    val colors = HappyTheme.colors
    val ground = Color(DocumentTokens.ground.of(colors.dark))
    val label = peersHere(peers.map { it.name })
    var open by remember { mutableStateOf(false) }
    val shown = minOf(peers.size, DocumentPeersSpec.MOST)
    val step = DocumentPeersSpec.face - DocumentPeersSpec.overlap
    Box {
        Box(
            Modifier
                .testTag(DocumentPeersTags.PEERS)
                .heightIn(min = DocumentPeersSpec.target)
                .clickable(role = Role.Button) { open = true }
                .semantics(mergeDescendants = true) { contentDescription = label }
                .padding(horizontal = 4.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            peers.take(shown).forEachIndexed { i, peer ->
                Box(
                    Modifier
                        .offset(x = step * i)
                        .testTag(DocumentPeersTags.face(i))
                        .size(DocumentPeersSpec.face)
                        .background(ground, CircleShape)
                        .padding(DocumentPeersSpec.ring)
                        .background(Color(peerColorInt(peer.color)), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        peer.name.take(1).uppercase().ifEmpty { "?" },
                        style = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.SemiBold),
                        color = Color.White,
                    )
                }
            }
            val facesWidth = step * (shown - 1) + DocumentPeersSpec.face
            if (peers.size > DocumentPeersSpec.MOST) {
                Text(
                    "+${peers.size - DocumentPeersSpec.MOST}",
                    style = happyTextStyle(fontSize = 12, lineHeight = 16, weight = FontWeight.SemiBold),
                    color = colors.textSecondary,
                    modifier = Modifier.padding(start = facesWidth + DocumentPeersSpec.moreGap).testTag(DocumentPeersTags.MORE),
                )
            } else {
                Spacer(Modifier.width(facesWidth))
            }
        }
        HappyDropdownMenu(open, onDismissRequest = { open = false }) {
            peers.forEach { HappyMenuItem(it.name.ifEmpty { stringResource(R.string.document_someone) }, onClick = {}, enabled = false) }
        }
    }
}
