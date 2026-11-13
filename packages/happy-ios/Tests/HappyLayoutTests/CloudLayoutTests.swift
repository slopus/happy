import XCTest
@testable import HappyLayout

final class CloudLayoutTests: XCTestCase {
    private let phone = CGSize(width: 393, height: 852)
    /// Under the bar: the status bar's 59 and the bar's 44.
    private let barred = LayoutInsets(top: 103, left: 0, bottom: 34, right: 0)

    // MARK: The welcome

    private func slides() -> [StartLayout.Slide] {
        [(1, 2), (1, 3), (1, 2), (1, 3), (1, 2)].map { lines in
            StartLayout.Slide(
                title: Measurable { CGSize(width: $0, height: CGFloat(lines.0) * 34) },
                body: Measurable { CGSize(width: $0, height: CGFloat(lines.1) * 24) }
            )
        }
    }

    /// Sign in with Apple is where the first screen's Start is and
    /// Sign in with GitHub where its Use Happy Cloud is: 12 under, 24 above
    /// the bottom inset, both as wide as the wider; the slides are where its
    /// slides are.
    func testTheWelcomesButtonsAreStartAndItsSecondary() {
        let safe = LayoutInsets(top: 59, left: 0, bottom: 34, right: 0)
        let apple = CGSize(width: 220, height: 50), github = CGSize(width: 236, height: 50)
        let start = StartLayout(size: phone, safeArea: safe, button: apple, cloud: github, slides: slides(), dots: CGSize(width: 150, height: 26))
        let welcome = CloudWelcomeLayout(size: phone, safeArea: safe, button: apple, secondary: github, slides: slides(), dots: CGSize(width: 150, height: 26))
        XCTAssertEqual(welcome.button, CGRect(x: 56.5, y: 852 - 34 - 24 - 50 - 12 - 50, width: 280, height: 50))
        XCTAssertEqual(welcome.secondary, CGRect(x: 56.5, y: 852 - 34 - 24 - 50, width: 280, height: 50))
        XCTAssertEqual(welcome.button, start.button)
        XCTAssertEqual(welcome.secondary, start.cloud)
        XCTAssertEqual(welcome.start.gallery, start.gallery)
        XCTAssertEqual(welcome.note, .zero)
    }

    /// Continue with email sits 12 under GitHub's, as wide, 24 above the
    /// bottom inset; Apple's and GitHub's rise to make room.
    func testEmailSitsUnderGitHub() {
        let safe = LayoutInsets(top: 59, left: 0, bottom: 34, right: 0)
        let apple = CGSize(width: 220, height: 50), github = CGSize(width: 236, height: 50), email = CGSize(width: 250, height: 50)
        let welcome = CloudWelcomeLayout(size: phone, safeArea: safe, button: apple, secondary: github, tertiary: email, slides: slides(), dots: CGSize(width: 150, height: 26))
        XCTAssertEqual(welcome.tertiary, CGRect(x: 56.5, y: 852 - 34 - 24 - 50, width: 280, height: 50))
        XCTAssertEqual(welcome.secondary, CGRect(x: 56.5, y: 852 - 34 - 24 - 50 - 12 - 50, width: 280, height: 50))
        XCTAssertEqual(welcome.button, CGRect(x: 56.5, y: 852 - 34 - 24 - 50 - 12 - 50 - 12 - 50, width: 280, height: 50))
        let plain = CloudWelcomeLayout(size: phone, safeArea: safe, button: apple, secondary: github, slides: slides(), dots: CGSize(width: 150, height: 26))
        XCTAssertEqual(plain.tertiary, .zero)
        XCTAssertLessThan(welcome.start.gallery.minY, plain.start.gallery.minY, "the slides centre again over the taller block")
    }

    /// The note sits 12 over Apple's button in the slides' column, and
    /// coming or going it moves nothing: the room `noteRoom` asks for is
    /// kept under the slides whether or not there is a note. With no room
    /// asked, a note where the slides leave none still makes its own.
    func testTheNoteSitsOverTheButtonsAndMovesNothing() {
        let safe = LayoutInsets(top: 59, left: 0, bottom: 34, right: 0)
        let apple = CGSize(width: 220, height: 50), github = CGSize(width: 236, height: 50), dots = CGSize(width: 150, height: 26)
        let plain = CloudWelcomeLayout(size: phone, safeArea: safe, button: apple, secondary: github, noteRoom: 48, slides: slides(), dots: dots)
        let noted = CloudWelcomeLayout(size: phone, safeArea: safe, button: apple, secondary: github, note: .fixed(width: 300, height: 40),
                                       noteRoom: 48, slides: slides(), dots: dots)
        XCTAssertEqual(noted.button, plain.button)
        XCTAssertEqual(noted.secondary, plain.secondary)
        XCTAssertEqual(noted.note, CGRect(x: 24, y: noted.button.minY - 12 - 40, width: 345, height: 40))
        XCTAssertEqual(noted.start, plain.start, "the slides stay where they are")
        XCTAssertLessThanOrEqual(noted.start.gallery.minY + noted.start.dots.maxY, noted.note.minY, "clear of the dots")

        // On a short phone the slides leave no room over the buttons: it is kept anyway.
        let short = CGSize(width: 375, height: 667), flat = LayoutInsets(top: 20, left: 0, bottom: 0, right: 0)
        let shortPlain = CloudWelcomeLayout(size: short, safeArea: flat, button: apple, secondary: github, noteRoom: 48, slides: slides(), dots: dots)
        let shortNoted = CloudWelcomeLayout(size: short, safeArea: flat, button: apple, secondary: github, note: .fixed(width: 300, height: 48),
                                            noteRoom: 48, slides: slides(), dots: dots)
        XCTAssertEqual(shortNoted.start, shortPlain.start)
        XCTAssertLessThanOrEqual(shortNoted.start.gallery.minY + shortNoted.start.dots.maxY, shortNoted.note.minY)
    }

    /// Continue with Google sits 12 under Apple's in Start's block, which
    /// rises to make room; GitHub's stays where Use Happy Cloud is, and all
    /// three are as wide as the widest. The note still sits 12 over Apple's.
    func testGooglesButtonSitsUnderApplesAndAllThreeShareAWidth() {
        let safe = LayoutInsets(top: 59, left: 0, bottom: 34, right: 0)
        let apple = CGSize(width: 0, height: 50), github = CGSize(width: 236, height: 50)
        let dots = CGSize(width: 150, height: 26)
        let plain = CloudWelcomeLayout(size: phone, safeArea: safe, button: apple, secondary: github, slides: slides(), dots: dots)
        let welcome = CloudWelcomeLayout(size: phone, safeArea: safe, button: apple, google: CGSize(width: 252, height: 50), secondary: github,
                                         slides: slides(), dots: dots)
        XCTAssertEqual(welcome.button, CGRect(x: 56.5, y: 852 - 34 - 24 - 50 - 12 - 50 - 12 - 50, width: 280, height: 50))
        XCTAssertEqual(welcome.google, CGRect(x: 56.5, y: 852 - 34 - 24 - 50 - 12 - 50, width: 280, height: 50))
        XCTAssertEqual(welcome.secondary, plain.secondary)
        XCTAssertEqual(welcome.start.gallery.minY, plain.start.gallery.minY - 31)
        XCTAssertEqual(plain.google, .zero)

        let wide = CloudWelcomeLayout(size: phone, safeArea: safe, button: apple, google: CGSize(width: 300, height: 50), secondary: github,
                                      note: .fixed(width: 300, height: 40), slides: slides(), dots: dots)
        XCTAssertEqual([wide.button.width, wide.google.width, wide.secondary.width], [300, 300, 300])
        XCTAssertEqual(wide.button.minX, 46.5)
        XCTAssertEqual(wide.google.minY, welcome.google.minY)
        XCTAssertEqual(wide.note, CGRect(x: 24, y: wide.button.minY - 12 - 40, width: 345, height: 40))
    }

    // MARK: A step

    /// Sign in: the scene, the title and its line centred over Apple's and
    /// GitHub's buttons, which sit 16 above the bottom inset, 12 apart.
    func testAStepIsCentredOverItsActions() {
        let layout = CloudStageLayout(size: phone, safeArea: barred, art: 96, title: .fixed(width: 300, height: 34), body: .fixed(width: 300, height: 48),
                                      content: .fixed(width: 0, height: 0), actions: [.init(height: 50), .init(height: 50, gap: 12)])
        XCTAssertEqual(layout.art, CGRect(x: 148.5, y: 289.5, width: 96, height: 96))
        XCTAssertEqual(layout.title, CGRect(x: 24, y: 409.5, width: 345, height: 34))
        XCTAssertEqual(layout.body, CGRect(x: 24, y: 455.5, width: 345, height: 48))
        XCTAssertEqual(layout.content.height, 0)
        XCTAssertEqual(layout.actions, [CGRect(x: 24, y: 690, width: 345, height: 50), CGRect(x: 24, y: 752, width: 345, height: 50)])
        XCTAssertEqual(layout.actions[1].maxY, 852 - 34 - 16)
        XCTAssertEqual(layout.contentHeight, 852)
        XCTAssertEqual(layout.keyboardInset, 0)
    }

    /// Typing a name: the action rides the keyboard, 16 over it, and what
    /// is above stays centred in the room left over it.
    func testTheActionRidesTheKeyboardAndTheRestCentresOverIt() {
        let layout = CloudStageLayout(size: phone, safeArea: barred, keyboardTop: 516, title: .fixed(width: 300, height: 34), body: .fixed(width: 300, height: 24),
                                      content: .fixed(width: 345, height: 90), actions: [.init(height: 50)])
        XCTAssertEqual(layout.title, CGRect(x: 24, y: 180.5, width: 345, height: 34))
        XCTAssertEqual(layout.body, CGRect(x: 24, y: 226.5, width: 345, height: 24))
        XCTAssertEqual(layout.content, CGRect(x: 24, y: 282.5, width: 345, height: 90))
        XCTAssertEqual(layout.actions, [CGRect(x: 24, y: 450, width: 345, height: 50)])
        XCTAssertEqual(layout.title.minY - (103 + 24), layout.actions[0].minY - 24 - layout.content.maxY)
        XCTAssertEqual(layout.keyboardInset, 852 - 516 - 34)
        XCTAssertEqual(layout.keyboardOffset, 0, "it fits: nothing scrolls")
    }

    /// Centred by its steady measure, a step moves nothing above what comes
    /// and goes: a status line longer than its room, a list where the
    /// spinner was, a failure in the body's place all grow down from where
    /// the block is, the actions where they were.
    func testWhatComesAndGoesGrowsDownAndMovesNothingAbove() {
        func step(body: CGFloat, content: CGFloat) -> CloudStageLayout {
            CloudStageLayout(size: phone, safeArea: barred, keyboardTop: 516, title: .fixed(width: 300, height: 34), body: .fixed(width: 300, height: body),
                             content: .fixed(width: 345, height: content), steadyBody: .fixed(width: 300, height: 24),
                             steadyContent: .fixed(width: 345, height: 130), actions: [.init(height: 50)])
        }
        let steady = step(body: 24, content: 130)
        for grown in [step(body: 24, content: 154), step(body: 48, content: 130), step(body: 24, content: 100)] {
            XCTAssertEqual(grown.title, steady.title)
            XCTAssertEqual(grown.body.minY, steady.body.minY)
            XCTAssertEqual(grown.actions, steady.actions)
        }
        XCTAssertEqual(step(body: 24, content: 154).content.minY, steady.content.minY)
    }

    /// Too tall for the room over the keyboard: it starts at its top margin,
    /// the action follows it, and the keyboard's inset lets it scroll there.
    func testTooTallOverTheKeyboardItScrolls() {
        let layout = CloudStageLayout(size: phone, safeArea: barred, keyboardTop: 516, title: .fixed(width: 300, height: 34), body: .fixed(width: 300, height: 24),
                                      content: .fixed(width: 345, height: 400), actions: [.init(height: 50)])
        XCTAssertEqual(layout.title.minY, 103 + 24)
        XCTAssertEqual(layout.content, CGRect(x: 24, y: 229, width: 345, height: 400))
        XCTAssertEqual(layout.actions, [CGRect(x: 24, y: 653, width: 345, height: 50)])
        XCTAssertEqual(layout.contentHeight, 852)
        XCTAssertGreaterThanOrEqual(layout.contentHeight + layout.keyboardInset - 516, layout.actions[0].maxY + 16 - 516)
    }

    /// A tablet: the column keeps to 440, and with no action (Join a server
    /// before anything is joined) the list is centred in the screen.
    func testATabletCentresTheColumn() {
        let layout = CloudStageLayout(size: CGSize(width: 1024, height: 1366), safeArea: LayoutInsets(top: 74, left: 0, bottom: 20, right: 0), art: 96,
                                      title: .fixed(width: 300, height: 34), body: .fixed(width: 300, height: 24), content: .fixed(width: 440, height: 164), actions: [])
        XCTAssertEqual(CloudStageLayout.column(size: CGSize(width: 1024, height: 1366), safeArea: .zero), 440)
        XCTAssertEqual(layout.art, CGRect(x: 464, y: 509, width: 96, height: 96))
        XCTAssertEqual(layout.title, CGRect(x: 292, y: 629, width: 440, height: 34))
        XCTAssertEqual(layout.content, CGRect(x: 292, y: 731, width: 440, height: 164))
        XCTAssertEqual(layout.actions, [])
        XCTAssertEqual(layout.contentHeight, 1366)
    }

    /// Join a server with five servers: it starts at its top margin and
    /// scrolls whole, title and all, while Continue stays where every
    /// step's action rests; scrolled to its end, the list stops 24 over it.
    func testALongListScrollsUnderItsPinnedAction() {
        func servers(_ content: CGFloat, keyboardTop: CGFloat? = nil) -> CloudStageLayout {
            CloudStageLayout(size: phone, safeArea: barred, keyboardTop: keyboardTop, title: .fixed(width: 300, height: 34), body: .fixed(width: 300, height: 48),
                             content: .fixed(width: 345, height: content), steadyContent: .fixed(width: 345, height: 174),
                             pinsActions: true, actions: [.init(height: 50)])
        }
        let long = servers(616)
        XCTAssertEqual(long.title, CGRect(x: 24, y: 103 + 24, width: 345, height: 34))
        XCTAssertEqual(long.body, CGRect(x: 24, y: 173, width: 345, height: 48))
        XCTAssertEqual(long.content, CGRect(x: 24, y: 253, width: 345, height: 616))
        XCTAssertEqual(long.actions, [CGRect(x: 24, y: 752, width: 345, height: 50)])
        XCTAssertEqual(long.actions[0].maxY, 852 - 34 - 16, "inside the safe area, where every step's rests")
        XCTAssertEqual(long.pinnedInset, 34 + 16 + 50 + 24)
        XCTAssertEqual(long.contentHeight, 253 + 616 + 124)
        XCTAssertEqual(long.content.maxY - (long.contentHeight - 852) + 24, long.actions[0].minY, "scrolled to its end, 24 over Continue")
        XCTAssertEqual(long.keyboardOffset, 0)
        // However long the list, nothing else moves.
        for list in [servers(174), servers(300), servers(1200)] {
            XCTAssertEqual(list.title, long.title)
            XCTAssertEqual(list.actions, long.actions)
            XCTAssertEqual(list.content.minY, long.content.minY)
        }
        XCTAssertEqual(servers(300).contentHeight, 852, "a short one doesn't scroll")
        // Over a keyboard the action rides it and the keyboard's inset adds the rest.
        let typing = servers(616, keyboardTop: 516)
        XCTAssertEqual(typing.actions, [CGRect(x: 24, y: 450, width: 345, height: 50)])
        let end = typing.contentHeight + typing.keyboardInset - 852
        XCTAssertEqual(typing.content.maxY - end + 24, typing.actions[0].minY, "scrolled to its end, 24 over Continue")
    }

    /// A phone on its side: the column stays inside the safe area.
    func testTheColumnKeepsInsideTheSafeArea() {
        let layout = CloudStageLayout(size: CGSize(width: 852, height: 393), safeArea: LayoutInsets(top: 32, left: 59, bottom: 21, right: 59),
                                      title: .fixed(width: 300, height: 34), body: .fixed(width: 0, height: 0), content: .fixed(width: 0, height: 0),
                                      actions: [.init(height: 50)])
        XCTAssertEqual(layout.title.minX, 59 + (734 - 440) / 2)
        XCTAssertEqual(layout.title.width, 440)
        XCTAssertEqual(layout.body.height, 0)
        XCTAssertEqual(layout.actions[0].maxY, 393 - 21 - 16)
    }

    // MARK: The column and a server's row

    /// Rows fill the column; the links are their own width, centred; a part
    /// with nothing in it takes no room and no gap.
    func testTheColumnStacksAndSkipsWhatIsEmpty() {
        let (frames, height) = CloudColumnLayout.stack([
            .init(height: 76),
            .init(height: 76, gap: 12),
            .init(height: 0, gap: 12),
            .init(size: CGSize(width: 180, height: 44), gap: 8, centred: true),
            .init(size: CGSize(width: 160, height: 44), gap: 0, centred: true),
        ], width: 345)
        XCTAssertEqual(frames, [
            CGRect(x: 0, y: 0, width: 345, height: 76),
            CGRect(x: 0, y: 88, width: 345, height: 76),
            CGRect(x: 0, y: 164, width: 345, height: 0),
            CGRect(x: 82.5, y: 172, width: 180, height: 44),
            CGRect(x: 92.5, y: 216, width: 160, height: 44),
        ])
        XCTAssertEqual(height, 260)
        XCTAssertEqual(CloudColumnLayout.stack([.init(height: 0), .init(height: 20, gap: 12)], width: 100).height, 20)
    }

    /// The picture at the left, Join at the right (desktop's 104 at least),
    /// the name over `@name` between, all centred down the row.
    func testAServersRow() {
        let row = CloudServerRowLayout(width: 345, button: CGSize(width: 80, height: 32))
        XCTAssertEqual(row.picture, CGRect(x: 14, y: 14, width: 48, height: 48))
        XCTAssertEqual(row.button, CGRect(x: 227, y: 22, width: 104, height: 32))
        XCTAssertEqual(row.title, CGRect(x: 74, y: 17, width: 141, height: 22))
        XCTAssertEqual(row.subtitle, CGRect(x: 74, y: 39, width: 141, height: 20))
        let wide = CloudServerRowLayout(width: 345, button: CGSize(width: 120, height: 32))
        XCTAssertEqual(wide.button.width, 120)
    }

    // MARK: Create your profile

    /// The picture's caption: "Add photo" as measured, with room for a thumb.
    private let caption = CloudProfileLayout.caption(textWidth: 85.3)
    /// The name's field and the line under it.
    private let profileContent = Measurable.fixed(width: 345, height: 58)

    /// The picture, 120 and round, Add photo 8 under it, then the title,
    /// its line, the field and Continue, centred over Continue.
    func testAProfileOnAPhone() {
        XCTAssertEqual(caption, CGSize(width: 110, height: 32))
        let layout = CloudStageLayout(size: phone, safeArea: barred, art: CloudProfileLayout.Metrics.avatar, caption: caption,
                                      title: .fixed(width: 300, height: 34), body: .fixed(width: 300, height: 48), content: profileContent, actions: [.init(height: 50)])
        XCTAssertEqual(layout.art, CGRect(x: 136.5, y: 243.5, width: 120, height: 120))
        XCTAssertEqual(layout.caption, CGRect(x: 141.5, y: 371.5, width: 110, height: 32))
        XCTAssertEqual(layout.title, CGRect(x: 24, y: 427.5, width: 345, height: 34))
        XCTAssertEqual(layout.body, CGRect(x: 24, y: 473.5, width: 345, height: 48))
        XCTAssertEqual(layout.content, CGRect(x: 24, y: 553.5, width: 345, height: 58))
        XCTAssertEqual(layout.actions, [CGRect(x: 24, y: 752, width: 345, height: 50)])
        XCTAssertEqual(layout.keyboardOffset, 0)
        XCTAssertEqual(CloudProfileLayout.badge(avatar: layout.art), CGRect(x: 221, y: 328, width: 36, height: 36))
    }

    /// The keyboard up, as it is when the screen shows: everything rises to
    /// the top margin, Continue 24 under the field, and the screen scrolls
    /// so Continue rests 16 over the keyboard.
    func testAProfileOverTheKeyboard() {
        let layout = CloudStageLayout(size: phone, safeArea: barred, keyboardTop: 516, art: CloudProfileLayout.Metrics.avatar, caption: caption,
                                      title: .fixed(width: 300, height: 34), body: .fixed(width: 300, height: 48), content: profileContent, actions: [.init(height: 50)])
        XCTAssertEqual(layout.art, CGRect(x: 136.5, y: 127, width: 120, height: 120))
        XCTAssertEqual(layout.caption, CGRect(x: 141.5, y: 255, width: 110, height: 32))
        XCTAssertEqual(layout.title, CGRect(x: 24, y: 311, width: 345, height: 34))
        XCTAssertEqual(layout.content, CGRect(x: 24, y: 437, width: 345, height: 58))
        XCTAssertEqual(layout.actions, [CGRect(x: 24, y: 519, width: 345, height: 50)])
        XCTAssertEqual(layout.contentHeight, 852)
        XCTAssertEqual(layout.keyboardInset, 302)
        XCTAssertEqual(layout.keyboardOffset, 69)
        XCTAssertEqual(layout.actions[0].maxY - layout.keyboardOffset, 516 - 16)
        // The scroll view can go that far.
        XCTAssertGreaterThanOrEqual(layout.contentHeight + layout.keyboardInset - 852, layout.keyboardOffset)
    }

    /// A tablet: the same column, 440 wide, in the middle.
    func testAProfileOnATablet() {
        let layout = CloudStageLayout(size: CGSize(width: 1024, height: 1366), safeArea: LayoutInsets(top: 74, left: 0, bottom: 20, right: 0),
                                      art: CloudProfileLayout.Metrics.avatar, caption: caption, title: .fixed(width: 300, height: 34),
                                      body: .fixed(width: 300, height: 48), content: .fixed(width: 440, height: 94), actions: [.init(height: 50)])
        XCTAssertEqual(layout.art, CGRect(x: 452, y: 475, width: 120, height: 120))
        XCTAssertEqual(layout.caption, CGRect(x: 457, y: 603, width: 110, height: 32))
        XCTAssertEqual(layout.title, CGRect(x: 292, y: 659, width: 440, height: 34))
        XCTAssertEqual(layout.body, CGRect(x: 292, y: 705, width: 440, height: 48))
        XCTAssertEqual(layout.content, CGRect(x: 292, y: 785, width: 440, height: 94))
        XCTAssertEqual(layout.actions, [CGRect(x: 292, y: 1280, width: 440, height: 50)])
        XCTAssertEqual(CloudProfileLayout.badge(avatar: layout.art), CGRect(x: 536, y: 559, width: 36, height: 36))
    }

    /// A tablet with its keyboard up: Continue rides it and the rest rises
    /// with it, centred in the room left over Continue; nothing scrolls.
    func testAProfileOverATabletsKeyboard() {
        let layout = CloudStageLayout(size: CGSize(width: 1024, height: 1366), safeArea: LayoutInsets(top: 74, left: 0, bottom: 20, right: 0), keyboardTop: 980,
                                      art: CloudProfileLayout.Metrics.avatar, caption: caption, title: .fixed(width: 300, height: 34),
                                      body: .fixed(width: 300, height: 48), content: .fixed(width: 440, height: 94), actions: [.init(height: 50)])
        XCTAssertEqual(layout.art, CGRect(x: 452, y: 292, width: 120, height: 120))
        XCTAssertEqual(layout.caption, CGRect(x: 457, y: 420, width: 110, height: 32))
        XCTAssertEqual(layout.title, CGRect(x: 292, y: 476, width: 440, height: 34))
        XCTAssertEqual(layout.body, CGRect(x: 292, y: 522, width: 440, height: 48))
        XCTAssertEqual(layout.content, CGRect(x: 292, y: 602, width: 440, height: 94))
        XCTAssertEqual(layout.actions, [CGRect(x: 292, y: 914, width: 440, height: 50)])
        XCTAssertEqual(layout.actions[0].maxY, 980 - 16)
        XCTAssertEqual(layout.art.minY - (74 + 24), layout.actions[0].minY - 24 - layout.content.maxY)
        XCTAssertEqual(layout.keyboardOffset, 0)
    }

    /// A caption needs art to sit under; without one it takes no room.
    func testACaptionWithoutArtTakesNoRoom() {
        let bare = CloudStageLayout(size: phone, safeArea: barred, title: .fixed(width: 300, height: 34), body: .fixed(width: 300, height: 48),
                                    content: .fixed(width: 0, height: 0), actions: [.init(height: 50)])
        let captioned = CloudStageLayout(size: phone, safeArea: barred, caption: caption, title: .fixed(width: 300, height: 34), body: .fixed(width: 300, height: 48),
                                         content: .fixed(width: 0, height: 0), actions: [.init(height: 50)])
        XCTAssertEqual(captioned, bare)
        XCTAssertEqual(bare.caption, .zero)
    }

    // MARK: An invite

    /// The picture centred, name and handle under it, the inviter's pair
    /// centred, and the status line as tall as asked.
    func testAnInvitesPartsSitAtFixedPlaces() {
        let layout = CloudInviteLayout(width: 345, inviterLabel: 120, status: 72)
        XCTAssertEqual(layout.picture, CGRect(x: 128.5, y: 0, width: 88, height: 88))
        XCTAssertEqual(layout.name, CGRect(x: 0, y: 102, width: 345, height: 28))
        XCTAssertEqual(layout.handle, CGRect(x: 0, y: 132, width: 345, height: 20))
        XCTAssertEqual(layout.inviterPicture, CGRect(x: 96.5, y: 170, width: 24, height: 24))
        XCTAssertEqual(layout.inviterLabel, CGRect(x: 128.5, y: 170, width: 120, height: 24))
        XCTAssertEqual(layout.status, CGRect(x: 0, y: 212, width: 345, height: 72))
        XCTAssertEqual(layout.height, 284)
    }

    /// Only the inviter's pair follows the name's width; nothing else moves.
    func testOnlyTheInvitersPairFollowsItsName() {
        let short = CloudInviteLayout(width: 345, inviterLabel: 60, status: 72)
        let long = CloudInviteLayout(width: 345, inviterLabel: 900, status: 72)
        XCTAssertEqual(long.inviterLabel, CGRect(x: 32, y: 170, width: 313, height: 24))
        XCTAssertEqual(long.inviterPicture.minX, 0)
        XCTAssertEqual(short.inviterPicture.minX, 126.5)
        XCTAssertEqual([short.picture, short.name, short.handle, short.status], [long.picture, long.name, long.handle, long.status])
    }
}
