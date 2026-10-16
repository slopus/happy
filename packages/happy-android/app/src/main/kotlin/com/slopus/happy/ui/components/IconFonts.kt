package com.slopus.happy.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import com.slopus.happy.R

// The icon fonts happy-app uses beyond Ionicons, from @expo/vector-icons
// 15.0.x (react-native-vector-icons' Fonts/ and glyphmaps/, MIT). The fonts'
// own licences: Octicons, MIT (GitHub); Material Design Icons
// (MaterialCommunityIcons), Apache 2.0 (Pictogrammers). MaterialIcons,
// Feather and FontAwesome are only used by happy-app's dev screens, so they
// are not bundled.

/** The Octicons glyphs happy-app uses (glyphmaps/Octicons.json). */
enum class Octicon(val codepoint: Int) {
    ArrowDown(0xf107), // arrow-down
    ArrowUp(0xf10d), // arrow-up
    Check(0xf11f), // check
    ChevronRight(0xf126), // chevron-right
    CommentDiscussion(0xf138), // comment-discussion
    Cpu(0xf13e), // cpu
    DiffRemoved(0xf14f), // diff-removed
    Eye(0xf159), // eye
    File(0xf16e), // file
    FileDiff(0xf173), // file-diff
    FileDirectory(0xf174), // file-directory
    Gear(0xf184), // gear
    GitBranch(0xf186), // git-branch
    LightBulb(0xf1ac), // light-bulb
    Pencil(0xf1d3), // pencil
    Plus(0xf1dd), // plus
    Rocket(0xf1f3), // rocket
    ScreenFull(0xf1f7), // screen-full
    Search(0xf1f9), // search
    Stop(0xf215), // stop
    Terminal(0xf220), // terminal
    X(0xf23b), // x
}

/** The MaterialCommunityIcons glyphs happy-app uses (glyphmaps/MaterialCommunityIcons.json). */
enum class MaterialCommunityIcon(val codepoint: Int) {
    Tree(0xf0531), // tree
}

private val OcticonsFamily = FontFamily(Font(R.font.octicons))
private val MaterialCommunityIconsFamily = FontFamily(Font(R.font.material_community_icons))

/** `<Octicons size={size} />` */
@Composable
fun Icon(icon: Octicon, size: Dp, color: Color, modifier: Modifier = Modifier, contentDescription: String? = null) =
    GlyphIcon(icon.codepoint, OcticonsFamily, size, color, modifier, contentDescription)

/** `<MaterialCommunityIcons size={size} />` */
@Composable
fun Icon(icon: MaterialCommunityIcon, size: Dp, color: Color, modifier: Modifier = Modifier, contentDescription: String? = null) =
    GlyphIcon(icon.codepoint, MaterialCommunityIconsFamily, size, color, modifier, contentDescription)
