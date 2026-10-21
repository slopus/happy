package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import com.slopus.happy.R
import com.slopus.happy.ui.theme.RnLineHeightStyle

/**
 * The Ionicons glyphs happy-app uses, from the same icon font
 * (@expo/vector-icons 15.0.x, glyphmaps/Ionicons.json; MIT). Add entries as screens need them.
 */
enum class Ionicon(val codepoint: Int) {
    Add(0xf103), // add
    AddOutline(0xf107), // add-outline
    AlertCircleOutline(0xf114), // alert-circle-outline
    AnalyticsOutline(0xf11c), // analytics-outline
    AppsOutline(0xf122), // apps-outline
    Archive(0xf124), // archive
    ArchiveOutline(0xf125), // archive-outline
    ArrowBack(0xf127), // arrow-back
    ArrowUp(0xf145), // arrow-up
    BugOutline(0xf1bb), // bug-outline
    BulbOutline(0xf1c1), // bulb-outline
    CalendarOutline(0xf1d6), // calendar-outline
    ChatbubbleEllipsesOutline(0xf213), // chatbubble-ellipses-outline
    ChatbubblesOutline(0xf218), // chatbubbles-outline
    Checkbox(0xf21a), // checkbox
    CheckboxOutline(0xf21b), // checkbox-outline
    Checkmark(0xf21d), // checkmark
    CheckmarkCircle(0xf21e), // checkmark-circle
    CheckmarkCircleOutline(0xf21f), // checkmark-circle-outline
    ChevronBack(0xf229), // chevron-back
    ChevronDown(0xf232), // chevron-down
    ChevronForward(0xf23b), // chevron-forward
    ChevronUp(0xf241), // chevron-up
    Close(0xf24a), // close
    CloseCircle(0xf24b), // close-circle
    CloudOfflineOutline(0xf25b), // cloud-offline-outline
    CodeOutline(0xf26c), // code-outline
    CodeSlash(0xf26e), // code-slash
    CodeWorkingOutline(0xf272), // code-working-outline
    ColorPaletteOutline(0xf27e), // color-palette-outline
    ConstructOutline(0xf287), // construct-outline
    ContractOutline(0xf28a), // contract-outline
    ContrastOutline(0xf28d), // contrast-outline
    CopyOutline(0xf290), // copy-outline
    CreateOutline(0xf293), // create-outline
    CubeOutline(0xf299), // cube-outline
    DesktopOutline(0xf29f), // desktop-outline
    DiceOutline(0xf2a5), // dice-outline
    DocumentTextOutline(0xf2b4), // document-text-outline
    DownloadOutline(0xf2ba), // download-outline
    EllipseOutline(0xf2cc), // ellipse-outline
    ExitOutline(0xf2de), // exit-outline
    ExtensionPuzzleOutline(0xf2e4), // extension-puzzle-outline
    EyeOffOutline(0xf2e8), // eye-off-outline
    EyeOutline(0xf2ea), // eye-outline
    Filter(0xf301), // filter
    FingerPrintOutline(0xf308), // finger-print-outline
    FlashOutline(0xf31a), // flash-outline
    FlaskOutline(0xf320), // flask-outline
    Folder(0xf325), // folder
    FolderOpenOutline(0xf327), // folder-open-outline
    FolderOutline(0xf329), // folder-outline
    GitBranchOutline(0xf33b), // git-branch-outline
    GitCommitOutline(0xf33e), // git-commit-outline
    GitNetworkOutline(0xf347), // git-network-outline
    GlobeOutline(0xf350), // globe-outline
    HardwareChipOutline(0xf365), // hardware-chip-outline
    Heart(0xf36a), // heart
    HelpCircleOutline(0xf37e), // help-circle-outline
    HomeOutline(0xf383), // home-outline
    HourglassOutline(0xf386), // hourglass-outline
    ImageOutline(0xf38f), // image-outline
    InformationCircle(0xf398), // information-circle
    InformationCircleOutline(0xf399), // information-circle-outline
    KeyOutline(0xf3a4), // key-outline
    LanguageOutline(0xf3aa), // language-outline
    LaptopOutline(0xf3ad), // laptop-outline
    LayersOutline(0xf3b0), // layers-outline
    LinkOutline(0xf3b9), // link-outline
    ListOutline(0xf3bf), // list-outline
    LocateOutline(0xf3c2), // locate-outline
    LockClosed(0xf3c7), // lock-closed
    LockClosedOutline(0xf3c8), // lock-closed-outline
    LogIn(0xf3cd), // log-in
    LogOut(0xf3d0), // log-out
    LogOutOutline(0xf3d1), // log-out-outline
    LogoGithub(0xf3f3), // logo-github
    Mic(0xf454), // mic
    MicOutline(0xf45e), // mic-outline
    HeartOutline(0xf377), // heart-outline
    SearchOutline(0xf563), // search-outline
    MoonOutline(0xf461), // moon-outline
    NotificationsOutline(0xf47f), // notifications-outline
    OptionsOutline(0xf48b), // options-outline
    PauseOutline(0xf497), // pause-outline
    Pencil(0xf49c), // pencil
    PeopleOutline(0xf4a3), // people-outline
    PersonAddOutline(0xf4a7), // person-add-outline
    PersonCircleOutline(0xf4aa), // person-circle-outline
    PersonOutline(0xf4ac), // person-outline
    PhonePortraitOutline(0xf4b5), // phone-portrait-outline
    PlayCircleOutline(0xf4ce), // play-circle-outline
    PowerOutline(0xf4e8), // power-outline
    PulseOutline(0xf4f7), // pulse-outline
    QrCodeOutline(0xf4fd), // qr-code-outline
    Refresh(0xf514), // refresh
    RefreshOutline(0xf518), // refresh-outline
    ReloadOutline(0xf51e), // reload-outline
    RemoveCircleOutline(0xf522), // remove-circle-outline
    ReturnUpBackOutline(0xf53f), // return-up-back-outline
    Search(0xf55f), // search
    ServerOutline(0xf569), // server-outline
    SettingsOutline(0xf56c), // settings-outline
    ShieldCheckmarkOutline(0xf579), // shield-checkmark-outline
    ShieldOutline(0xf57e), // shield-outline
    SparklesOutline(0xf58d), // sparkles-outline
    SpeedometerOutline(0xf590), // speedometer-outline
    SquareOutline(0xf593), // square-outline
    Stop(0xf59e), // stop
    StopCircle(0xf59f), // stop-circle
    TerminalOutline(0xf5c9), // terminal-outline
    TimeOutline(0xf5de), // time-outline
    TimerOutline(0xf5e1), // timer-outline
    TrashOutline(0xf5f6), // trash-outline
    Warning(0xf628), // warning
    WarningOutline(0xf629), // warning-outline
}

private val IoniconsFamily = FontFamily(Font(R.font.ionicons))

/**
 * One glyph in a [size] x [size] box, like `<Ionicons size={size} />`. Unlike
 * RN text, the glyph does not grow with the system font scale: every icon
 * here sits in a fixed-size slot.
 */
@Composable
fun Icon(
    icon: Ionicon,
    size: Dp,
    color: Color,
    modifier: Modifier = Modifier,
    contentDescription: String? = null,
) = GlyphIcon(icon.codepoint, IoniconsFamily, size, color, modifier, contentDescription)

/** A glyph from an icon font, drawn the way [Icon] draws Ionicons. */
@Composable
fun GlyphIcon(
    codepoint: Int,
    family: FontFamily,
    size: Dp,
    color: Color,
    modifier: Modifier = Modifier,
    contentDescription: String? = null,
) {
    val fontSize = with(LocalDensity.current) { size.toSp() }
    Box(
        modifier = modifier
            .size(size)
            .then(if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = String(Character.toChars(codepoint)),
            style = TextStyle(
                fontFamily = family,
                fontSize = fontSize,
                lineHeight = fontSize,
                lineHeightStyle = RnLineHeightStyle,
                color = color,
            ),
            maxLines = 1,
            softWrap = false,
        )
    }
}
