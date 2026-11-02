#if canImport(UIKit)
import HappyLayout
import UIKit

/// The main panel beside the sidebar with nothing open: desktop's owl,
/// without words, centred in the panel (`MainPanelPlaceholderLayout`), in
/// place of a stretched home. It plays once as the panel appears, and
/// again on a tap.
final class MainPanelPlaceholderViewController: UIViewController {
    let scene = StateSceneView(
        scene: .owl,
        size: MainPanelPlaceholderLayout.Metrics.scene,
        replayLabel: Strings.Tablet.replayIllustration
    )

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        navigationItem.largeTitleDisplayMode = .never
        scene.accessibilityIdentifier = "main-panel-placeholder"
        view.addSubview(scene)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // The shell keeps this one controller, so the scene's own first
        // play happens once; each return to an empty panel (the last chat
        // closed) is the state appearing again, and plays it again.
        if isMovingToParent { scene.replay() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scene.frame = MainPanelPlaceholderLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets)).scene
    }
}
#endif
