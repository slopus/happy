#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The inference gate: connecting a model provider of the team's or the
/// person's own. Connect a Provider opens the same chooser Settings ›
/// Inference does (`ProviderChooser`): ChatGPT's sign-in, Claude's, an API
/// key for OpenAI, Anthropic or Grok, or the team's own endpoint; each
/// pushes its steps on the flow, and once a connection is kept the server
/// says the gate is done and the flow moves on. Where the operator's free
/// model runs meanwhile, the words say so. Skip for Now while optional.
final class OnboardingInferenceViewController: CloudStageViewController, OnboardingStepScreen {
    private let session: Session
    private let refresh: @MainActor () async -> Void
    let status = CloudStageViewController.bodyLabel("")
    private(set) lazy var chooser = ProviderChooser(session: session, host: self, added: { [weak self] in
        guard let self else { return }
        Task { @MainActor in await self.refresh() }
    })
    private var offerRead = false

    init(context: AppContext, session: Session, inference: OnboardingGate.Inference, optional: Bool, refresh: @escaping @MainActor () async -> Void) {
        self.session = session
        self.refresh = refresh
        let body = Strings.CloudOnboarding.inferenceBody + (inference.freeModel && optional ? " " + Strings.CloudOnboarding.inferenceFree : "")
        super.init(context: context, scene: .llama, title: Strings.CloudOnboarding.inferenceTitle, body: body,
                   primary: Strings.CloudOnboarding.connectProvider, secondary: optional ? Strings.CloudOnboarding.skip : nil)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "onboarding-inference"
        primary.accessibilityIdentifier = "onboarding-primary"
        secondary?.accessibilityIdentifier = "onboarding-secondary"
        primary.action = { [weak self] in await self?.connect() }
        status.textColor = UIColor(Palette.textDestructive)
        content.addSubview(status)
        Task { await readOffer() }
    }

    override func contentHeight(width: CGFloat) -> CGFloat { Self.statusHeight(status, width: width) }
    override func steadyContentHeight(width: CGFloat) -> CGFloat { Self.statusRoom }
    override func layoutContent() { status.setLayoutFrame(content.bounds) }

    /// What the server runs, read once: the chooser offers only that.
    private func readOffer() async {
        guard !offerRead, let listing = try? await session.client.cloudProviderListing() else { return }
        chooser.offer = await ProvidersViewController.offer(listing.offer, session.client)
        offerRead = true
    }

    /// The chooser, its connection going to the team where the role lets
    /// it (the gate is the server's), else to the person.
    func connect() async {
        say(nil)
        await readOffer()
        guard offerRead else { return say(Strings.CloudOnboarding.couldntCheck) }
        let allowed = CloudProvider.destinations(session.gate)
        guard !allowed.isEmpty else { return say(Strings.CloudOnboarding.inferenceNotAllowed) }
        chooser.choose(destination: allowed.contains(.team) ? .team : allowed.first)
    }

    func say(_ problem: String?) {
        status.string = problem ?? ""
        relayout()
    }
}
#endif
