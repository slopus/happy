#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The adminBot gate: naming the server's admin bot, the Chief of Staff.
/// Its picture over the server's own words for it (`title`,
/// `description`: an admin bot with expanded capabilities that can adapt
/// Happy and build a system around how the team works), what it can do
/// (`points`) over its name in a field, the current one offered, and the
/// server's closing `note` under it. Continue keeps
/// the name, changed or not (`PATCH /v0/bots/:id` with its version); the
/// flow moves on as the server says. Skip for Now while the gate is
/// optional.
final class OnboardingAdminBotViewController: CloudStageViewController, UITextFieldDelegate, OnboardingStepScreen {
    typealias Save = @MainActor (String) async throws -> Void

    private let save: Save
    /// Its picture, where it has one; else the robot scene stands in.
    let picture: UIImageView?
    let nameField = CloudField(prefix: nil, placeholder: Strings.CloudOnboarding.botNamePlaceholder)
    let status = StartGalleryView.bodyLabel("")
    /// What it can do, a line each.
    private let points = StyledLabel(style: TextStyles.startSlideBody, color: Palette.startText)
    private let note = StartGalleryView.bodyLabel("")

    init(context: AppContext, bot: OnboardingGate.AdminBot, optional: Bool, picture load: ((UIImageView) -> Void)?, save: @escaping Save) {
        self.save = save
        picture = load == nil ? nil : UIImageView()
        super.init(context: context, scene: load == nil ? .robot : nil, title: bot.title ?? Strings.CloudOnboarding.botTitle,
                   body: bot.description ?? Strings.CloudOnboarding.botBody,
                   primary: Strings.CloudConnect.continueAction, secondary: optional ? Strings.CloudOnboarding.skip : nil)
        nameField.text.text = bot.name
        points.string = (bot.points ?? []).filter { !$0.isEmpty }.map { "•  \($0)" }.joined(separator: "\n")
        note.string = bot.note ?? ""
        if let picture { load?(picture) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "onboarding-admin-bot"
        primary.accessibilityIdentifier = "onboarding-primary"
        secondary?.accessibilityIdentifier = "onboarding-secondary"
        primary.action = { [weak self] in await self?.submit() }
        if let picture {
            picture.clipsToBounds = true
            picture.contentMode = .scaleAspectFill
            picture.layer.cornerRadius = CloudProfileLayout.Metrics.avatar / 2
            picture.backgroundColor = UIColor(Palette.startDot)
            picture.isAccessibilityElement = false
            scroll.addSubview(picture)
        }
        let field = nameField.text
        field.autocapitalizationType = .words
        field.autocorrectionType = .no
        field.returnKeyType = .continue
        field.clearButtonMode = .whileEditing
        field.accessibilityIdentifier = "onboarding-bot-name"
        field.accessibilityLabel = Strings.CloudOnboarding.botNamePlaceholder
        field.delegate = self
        field.addTarget(self, action: #selector(edited), for: .editingChanged)
        status.textColor = UIColor(Palette.textDestructive)
        for subview in [points, nameField, note, status] { content.addSubview(subview) }
        edited()
    }

    /// The name is offered as it is, and most keep it: the keyboard waits
    /// for a tap on the field, so the bot and its words show whole first.
    override var typingField: UITextField? { nil }

    // MARK: Layout

    override var artSide: CGFloat { picture == nil ? super.artSide : CloudProfileLayout.Metrics.avatar }
    override func layoutArt(_ art: CGRect, caption: CGRect) { picture?.setLayoutFrame(art) }

    /// Its points, the field, its note, then the status line; a missing
    /// point list or note takes no room.
    private func items(width: CGFloat, steady: Bool = false) -> [CloudColumnLayout.Item] {
        let inset = CloudStageLayout.Metrics.pointsInset
        let points = self.points.string.isEmpty ? 0 : self.points.measurable.height(fitting: width - 2 * inset)
        let note = self.note.string.isEmpty ? 0 : self.note.measurable.height(fitting: width)
        return [
            .init(height: points),
            .init(height: CloudField.height, gap: points > 0 ? 20 : 0),
            .init(height: note, gap: note > 0 ? 12 : 0),
            .init(height: steady ? Self.statusRoom : Self.statusHeight(status, width: width), gap: 12),
        ]
    }

    override func contentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }
    override func steadyContentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width, steady: true), width: width).height }

    override func layoutContent() {
        let frames = CloudColumnLayout.stack(items(width: content.bounds.width), width: content.bounds.width).frames
        points.setLayoutFrame(frames[0].insetBy(dx: CloudStageLayout.Metrics.pointsInset, dy: 0))
        nameField.setLayoutFrame(frames[1])
        note.setLayoutFrame(frames[2])
        status.setLayoutFrame(frames[3])
    }

    // MARK: The name

    private var name: String { (nameField.text.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

    @objc func edited() {
        primary.isEnabled = !name.isEmpty
        if !status.string.isEmpty { say(nil) }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if primary.isEnabled { primary.tapped() }
        return false
    }

    func submit() async {
        let name = name
        guard !name.isEmpty else { return }
        say(nil)
        nameField.text.isEnabled = false
        secondary?.isEnabled = false
        defer { nameField.text.isEnabled = true; secondary?.isEnabled = true }
        do { try await save(name) }
        catch { say(Strings.CloudOnboarding.botNameFailed) }
    }

    func say(_ problem: String?) {
        status.string = problem ?? ""
        relayout()
    }
}
#endif
