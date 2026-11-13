#if canImport(UIKit)
import HappyLayout
import UIKit

/// What the drawing tools were left at, kept while the app runs as
/// Telegram keeps its tool states (their colours and sizes).
@MainActor
final class PhotoToolMemory {
    static let shared = PhotoToolMemory()
    var colors: [PhotoStroke.Tool: RGBA] = Dictionary(uniqueKeysWithValues: PhotoTools.order.map { ($0, PhotoTools.color($0)) })
    var sizes: [PhotoStroke.Tool: CGFloat] = Dictionary(uniqueKeysWithValues: PhotoTools.order.map { ($0, PhotoTools.size($0)) })
}

/// Telegram's drawing screen (`DrawingScreen` over `DrawingView`), its
/// brushes only: pen, arrow, marker, neon, blur and eraser. One finger
/// draws on the picture as the crop left it; two pan and pinch it. Undo
/// and Clear at the top, the size wedge at the left, the tools, the
/// colour and its swatches at the foot, close and done under them.
final class PhotoDrawViewController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    private let picture: UIImage
    private var edit: PhotoEdit
    /// Strokes from before this time: kept, but not undone one by one
    /// (Telegram's drawing comes back flattened).
    private var floor: Int
    private var undone: [PhotoStroke] = []
    private var tool: PhotoStroke.Tool = PhotoTools.initial
    private let memory = PhotoToolMemory.shared
    var onDone: (([PhotoStroke]) -> Void)?
    var onCancel: (() -> Void)?

    private let scroll = UIScrollView()
    private let board = UIView()
    private let base = UIImageView()
    private let ink = UIImageView()
    private var committed: UIImage?
    private var blurred: UIImage?
    private var active: PhotoStroke?
    private var link: CADisplayLink?
    private var dirty = false

    private let topShade = PhotoEditorShade(top: true)
    private let bottomShade = PhotoEditorShade(top: false)
    private let undo = PhotoEditorButton.plain("arrow.uturn.backward", identifier: "photo-draw-undo", label: Strings.PhotoEditor.undo)
    private let redo = PhotoEditorButton.plain("arrow.uturn.forward", identifier: "photo-draw-redo", label: Strings.PhotoEditor.redo)
    private lazy var history = PhotoEditorGroup([undo, redo])
    private let clear = PhotoEditorButton(.title(Strings.PhotoEditor.clear), identifier: "photo-draw-clear")
    private let zoomOut = PhotoEditorButton(.title(Strings.PhotoEditor.zoomOut), identifier: "photo-draw-zoom-out")
    private let wedge = PhotoSizeWedge()
    private let tools = PhotoToolsRow()
    private let colorButton = PhotoColorButton()
    private var swatches: [PhotoSwatch] = []
    private let close = PhotoEditorButton(.symbol("xmark"), identifier: "photo-draw-cancel", label: Strings.PhotoEditor.cancel)
    private let done = PhotoEditorButton(.symbol("checkmark"), accent: true, identifier: "photo-draw-done", label: Strings.PhotoEditor.done)
    private let brush = UIView()
    private var loupe: PhotoLoupe?
    private var controls: [UIView] = []
    private let drawRecognizer = PhotoDrawRecognizer()

    init(picture: UIImage, edit: PhotoEdit) {
        self.picture = picture
        self.edit = edit
        floor = edit.strokes.count
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalPresentationCapturesStatusBarAppearance = true
        transitioningDelegate = PhotoEditorFade.shared
        overrideUserInterfaceStyle = .dark
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }

    var strokes: [PhotoStroke] { edit.strokes }
    var currentTool: PhotoStroke.Tool { tool }

    private var layout: PhotoDrawScreenLayout {
        PhotoDrawScreenLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "photo-draw"
        view.backgroundColor = UIColor(Palette.viewerGround)

        scroll.delegate = self
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 3
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.panGestureRecognizer.minimumNumberOfTouches = 2
        scroll.delaysContentTouches = false
        view.addSubview(scroll)
        board.accessibilityIdentifier = "photo-draw-board"
        scroll.addSubview(board)
        base.contentMode = .scaleToFill
        ink.contentMode = .scaleToFill
        board.addSubview(base)
        board.addSubview(ink)
        drawRecognizer.addTarget(self, action: #selector(drew(_:)))
        drawRecognizer.delegate = self
        board.addGestureRecognizer(drawRecognizer)

        view.addSubview(topShade)
        view.addSubview(bottomShade)

        brush.isUserInteractionEnabled = false
        brush.backgroundColor = UIColor(Palette.photoEditorControl)
        brush.layer.borderColor = UIColor(Palette.photoEditorBrushRing).cgColor
        brush.layer.borderWidth = 1
        brush.layer.shadowColor = UIColor.black.cgColor
        brush.layer.shadowOpacity = 0.5
        brush.layer.shadowRadius = 20
        brush.layer.shadowOffset = .zero
        brush.alpha = 0
        view.addSubview(brush)

        undo.addTarget(self, action: #selector(undoTapped), for: .touchUpInside)
        redo.addTarget(self, action: #selector(redoTapped), for: .touchUpInside)
        clear.menu = UIMenu(children: [UIAction(title: Strings.PhotoEditor.clearAll, attributes: .destructive) { [weak self] _ in self?.clearAll() }])
        zoomOut.addTarget(self, action: #selector(zoomOutTapped), for: .touchUpInside)
        zoomOut.alpha = 0
        wedge.accessibilityIdentifier = "photo-draw-size"
        wedge.onChange = { [weak self] value in self?.resize(value) }
        wedge.onRelease = { [weak self] in self?.showBrush(nil) }
        tools.onSelect = { [weak self] tool in self?.select(tool) }
        tools.onResize = { [weak self] value in self?.resize(value) }
        tools.onRelease = { [weak self] in self?.showBrush(nil) }
        colorButton.accessibilityIdentifier = "photo-draw-color"
        colorButton.addTarget(self, action: #selector(colorTapped), for: .touchUpInside)
        for (index, color) in PhotoTools.presets.enumerated() {
            let swatch = PhotoSwatch(color: color)
            swatch.accessibilityIdentifier = "photo-draw-swatch:\(index)"
            swatch.addTarget(self, action: #selector(swatchTapped(_:)), for: .touchUpInside)
            swatches.append(swatch)
        }
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        done.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        controls = [history, clear, zoomOut, wedge, tools, colorButton, close, done, topShade, bottomShade] + swatches
        for control in controls where control !== topShade && control !== bottomShade { view.addSubview(control) }

        blurred = edit.strokes.contains { $0.tool == .blur } ? PhotoEditRenderer.blurred(picture) : nil
        showTool(animated: false)
        updateHistory()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = layout
        scroll.frame = view.bounds
        topShade.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: layout.topY + 15 + 22)
        bottomShade.frame = CGRect(x: 0, y: view.bounds.height - 155, width: view.bounds.width, height: 155)
        let historyWidth: CGFloat = undone.isEmpty ? 44 : 88
        history.frame = CGRect(x: layout.undo.x, y: layout.topY - 22, width: historyWidth, height: 44)
        history.place([CGRect(x: 0, y: 0, width: 44, height: 44), CGRect(x: 44, y: 0, width: 44, height: 44)])
        let clearSize = clear.sizeThatFits(.zero)
        clear.frame = CGRect(x: layout.clearRight - clearSize.width, y: layout.topY - 22, width: clearSize.width, height: 44)
        let zoomSize = zoomOut.sizeThatFits(.zero)
        zoomOut.frame = CGRect(x: view.bounds.midX - zoomSize.width / 2, y: layout.topY - 22, width: zoomSize.width, height: 44)
        wedge.frame = layout.wedge
        tools.frame = layout.tools
        tools.centers = layout.toolCenters
        colorButton.frame = layout.color
        for (swatch, frame) in zip(swatches, layout.swatches) { swatch.frame = frame.insetBy(dx: -6, dy: -6) }
        close.frame = layout.close
        done.frame = layout.done
        placeBoard(layout)
    }

    /// The picture as the crop left it, fitted where the preview shows it.
    private func placeBoard(_ layout: PhotoDrawScreenLayout) {
        let size = edit.crop.size
        let fitted = AttachPreviewLayout.fit(size, in: view.bounds.size)
        guard board.bounds.size != fitted.size else { return }
        scroll.zoomScale = 1
        board.frame = CGRect(origin: .zero, size: fitted.size)
        base.frame = board.bounds
        ink.frame = board.bounds
        scroll.contentSize = fitted.size
        centerBoard()
        let scale = view.window?.screen.scale ?? traitCollection.displayScale
        let pixels = CGSize(width: (fitted.width * scale).rounded(), height: (fitted.height * scale).rounded())
        let fit = min(1, 2048 / max(pixels.width, pixels.height, 1))
        inkSize = CGSize(width: max(1, (pixels.width * fit).rounded()), height: max(1, (pixels.height * fit).rounded()))
        var plain = edit
        plain.strokes = []
        base.image = PhotoEditRenderer.render(picture, plain, maxPixels: max(inkSize.width, inkSize.height))
        recommit()
    }

    private var inkSize: CGSize = .zero

    private func centerBoard() {
        let size = scroll.bounds.size, content = board.frame.size
        scroll.contentInset = UIEdgeInsets(top: max(0, (size.height - content.height) / 2), left: max(0, (size.width - content.width) / 2), bottom: 0, right: 0)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { board }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centerBoard()
        UIView.animate(withDuration: 0.2) { self.zoomOut.alpha = scrollView.zoomScale > 1.01 ? 1 : 0 }
    }

    @objc private func zoomOutTapped() { scroll.setZoomScale(1, animated: true) }

    // MARK: Drawing

    /// A board point into the picture's pixels, through the crop.
    private func canvasPoint(_ point: CGPoint) -> CGPoint {
        let crop = edit.crop
        let output = CGPoint(x: point.x * crop.size.width / max(board.bounds.width, 1), y: point.y * crop.size.height / max(board.bounds.height, 1))
        return output.applying(crop.transform.inverted())
    }

    private var size: CGFloat { memory.sizes[tool] ?? PhotoTools.size(tool) }
    private var color: RGBA { memory.colors[tool] ?? PhotoTools.color(tool) }

    private func strokeWidth(_ size: CGFloat) -> CGFloat {
        PhotoEditRenderer.width(size, tool: tool, canvas: edit.canvas) / max(scroll.zoomScale, 1)
    }

    @objc private func drew(_ recognizer: PhotoDrawRecognizer) {
        let point = canvasPoint(recognizer.location(in: board))
        switch recognizer.state {
        case .began:
            dismissLoupe()
            if tool == .blur, blurred == nil { blurred = PhotoEditRenderer.blurred(picture) }
            active = PhotoStroke(tool: tool, color: color, width: strokeWidth(size), points: [point])
            setControls(hidden: true)
            schedule()
        case .changed:
            guard var stroke = active else { return }
            // Points closer than two on the screen add nothing.
            let least = 2 * edit.crop.size.width / max(board.bounds.width * scroll.zoomScale, 1)
            if let last = stroke.points.last, hypot(point.x - last.x, point.y - last.y) < least { return }
            stroke.points.append(point)
            active = stroke
            schedule()
        case .ended:
            guard var stroke = active else { return }
            if let last = stroke.points.last, last != point { stroke.points.append(point) }
            active = nil
            edit.strokes.append(stroke)
            undone = []
            recommit()
            setControls(hidden: false)
            updateHistory()
        default:
            active = nil
            ink.image = committed
            setControls(hidden: false)
        }
    }

    /// The live stroke lands on the next frame, once however many points come.
    private func schedule() {
        dirty = true
        guard link == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(frame))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func frame() {
        guard dirty else {
            link?.invalidate()
            link = nil
            return
        }
        dirty = false
        guard let active else { return }
        ink.image = PhotoEditRenderer.drawing([], canvas: edit.canvas, crop: edit.crop, size: inkSize, picture: picture, blurred: blurred, active: active, base: committed)
    }

    /// What is drawn, in one picture the live stroke goes over.
    private func recommit() {
        guard inkSize.width > 0 else { return }
        if edit.strokes.contains(where: { $0.tool == .blur }), blurred == nil { blurred = PhotoEditRenderer.blurred(picture) }
        committed = edit.strokes.isEmpty ? nil : PhotoEditRenderer.drawing(edit.strokes, canvas: edit.canvas, crop: edit.crop, size: inkSize, picture: picture, blurred: blurred)
        ink.image = committed
    }

    /// Everything but the picture fades while a stroke is drawn.
    private func setControls(hidden: Bool) {
        UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            for control in self.controls where control !== self.zoomOut { control.alpha = hidden ? 0 : 1 }
            if hidden { self.zoomOut.alpha = 0 } else if self.scroll.zoomScale > 1.01 { self.zoomOut.alpha = 1 }
        }
    }

    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        recognizer === drawRecognizer && (other === scroll.pinchGestureRecognizer || other === scroll.panGestureRecognizer)
    }

    // MARK: History

    private func updateHistory() {
        undo.isEnabled = edit.strokes.count > floor
        redo.isHidden = undone.isEmpty
        let width: CGFloat = undone.isEmpty ? 44 : 88
        history.frame.size.width = width
        history.place([CGRect(x: 0, y: 0, width: 44, height: 44), CGRect(x: 44, y: 0, width: 44, height: 44)])
        clear.isEnabled = !edit.strokes.isEmpty
    }

    @objc private func undoTapped() {
        guard edit.strokes.count > floor, let last = edit.strokes.popLast() else { return }
        undone.append(last)
        recommit()
        updateHistory()
    }

    @objc private func redoTapped() {
        guard let stroke = undone.popLast() else { return }
        edit.strokes.append(stroke)
        recommit()
        updateHistory()
    }

    /// Telegram's Clear All: everything, and no undoing it.
    private func clearAll() {
        edit.strokes = []
        undone = []
        floor = 0
        let fading = UIImageView(image: committed)
        fading.frame = ink.frame
        board.addSubview(fading)
        recommit()
        UIView.animate(withDuration: 0.2) { fading.alpha = 0 } completion: { _ in fading.removeFromSuperview() }
        updateHistory()
    }

    // MARK: Tools

    func select(_ next: PhotoStroke.Tool) {
        dismissLoupe()
        tool = next
        showTool(animated: true)
    }

    private func showTool(animated: Bool) {
        tools.show(selected: tool, colors: memory.colors, sizes: memory.sizes, animated: animated)
        wedge.value = size
        let colored = PhotoTools.colored(tool)
        let custom = colored && !PhotoTools.presets.contains { PhotoTools.sameHue($0, color) && color.alpha > 0.99 }
        colorButton.color = custom ? color : nil
        for swatch in swatches { swatch.chosen = colored && PhotoTools.sameHue(swatch.color, color) && color.alpha > 0.99 }
    }

    private func resize(_ value: CGFloat) {
        memory.sizes[tool] = value
        wedge.value = value
        tools.show(selected: tool, colors: memory.colors, sizes: memory.sizes, animated: false)
        showBrush(value)
    }

    /// While the size changes, a circle as wide as the brush draws, in the
    /// middle of the picture.
    private func showBrush(_ value: CGFloat?) {
        guard let value else {
            UIView.animate(withDuration: 0.2) { self.brush.alpha = 0 }
            return
        }
        let width = PhotoEditRenderer.width(value, tool: tool, canvas: edit.canvas) * board.bounds.width / max(edit.crop.size.width, 1)
        brush.bounds = CGRect(x: 0, y: 0, width: width, height: width)
        brush.layer.cornerRadius = width / 2
        brush.center = board.convert(CGPoint(x: board.bounds.midX, y: board.bounds.midY), to: view)
        if brush.alpha < 1 { UIView.animate(withDuration: 0.2) { self.brush.alpha = 1 } }
    }

    func setColor(_ next: RGBA) {
        if !PhotoTools.colored(tool) { tool = .pen }
        memory.colors[tool] = next
        showTool(animated: true)
    }

    @objc private func swatchTapped(_ swatch: PhotoSwatch) {
        dismissLoupe()
        setColor(swatch.color)
    }

    @objc private func colorTapped() {
        dismissLoupe()
        let sheet = PhotoColorSheet(color: PhotoTools.colored(tool) ? color : PhotoTools.color(.pen))
        sheet.onColor = { [weak self] color in self?.setColor(color) }
        sheet.onEyedropper = { [weak self, weak sheet] in
            sheet?.dismiss(animated: true) { self?.showLoupe() }
        }
        sheet.fit(width: view.bounds.width)
        present(sheet, animated: true)
    }

    // MARK: Eyedropper

    /// Telegram's loupe in the middle of the picture: dragged, it shows
    /// the colour under its centre; let go, that is the colour.
    func showLoupe() {
        dismissLoupe()
        let source = UIGraphicsImageRenderer(size: board.bounds.size, format: {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            return format
        }()).image { _ in
            base.image?.draw(in: board.bounds)
            ink.image?.draw(in: board.bounds)
        }
        let loupe = PhotoLoupe(source: source)
        loupe.accessibilityIdentifier = "photo-draw-loupe"
        loupe.frame = view.bounds
        loupe.sample = { [weak self] center in
            guard let self else { return CGPoint.zero }
            return view.convert(center, to: board)
        }
        loupe.onPick = { [weak self] picked in
            self?.setColor(picked)
            self?.loupe = nil
        }
        view.addSubview(loupe)
        loupe.place(at: board.convert(CGPoint(x: board.bounds.midX, y: board.bounds.midY), to: view))
        self.loupe = loupe
    }

    private func dismissLoupe() {
        loupe?.dismiss()
        loupe = nil
    }

    // MARK: Leaving

    @objc private func closeTapped() {
        dismissLoupe()
        onCancel?()
    }

    @objc private func doneTapped() {
        dismissLoupe()
        onDone?(edit.strokes)
    }
}

/// One finger on the board: it starts at once and ends if a second comes
/// (that one pinches the picture instead).
final class PhotoDrawRecognizer: UIGestureRecognizer {
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if (event.allTouches?.count ?? touches.count) > 1 {
            state = state == .possible ? .failed : .cancelled
            return
        }
        state = .began
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .began || state == .changed else { return }
        if (event.allTouches?.count ?? 1) > 1 { state = .cancelled; return }
        state = .changed
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .began || state == .changed else { state = .failed; return }
        state = .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        state = .cancelled
    }
}

/// Telegram's size wedge (`TextSizeSliderComponent`): a blurred wedge,
/// wide at the top, half off the left edge until touched, a white knob
/// at the size.
final class PhotoSizeWedge: UIView {
    var onChange: ((CGFloat) -> Void)?
    var onRelease: (() -> Void)?
    var value: CGFloat = 0.5 { didSet { placeKnob() } }
    private let panel = UIVisualEffectView(effect: UIBlurEffect(style: .dark))
    private let tint = UIView()
    private let shape = CAShapeLayer()
    private let knob = UIView()
    private let holder = UIView()
    private var tracking = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityLabel = Strings.PhotoEditor.size
        accessibilityTraits = .adjustable
        holder.isUserInteractionEnabled = false
        addSubview(holder)
        tint.backgroundColor = UIColor(Palette.photoEditorWedge)
        panel.contentView.addSubview(tint)
        panel.layer.mask = shape
        holder.addSubview(panel)
        knob.backgroundColor = UIColor(Palette.photoEditorControl)
        knob.bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
        knob.layer.cornerRadius = 16
        knob.layer.shadowColor = UIColor.black.cgColor
        knob.layer.shadowOpacity = 0.3
        knob.layer.shadowRadius = 4.5
        knob.layer.shadowOffset = .zero
        holder.addSubview(knob)
        let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0.01
        press.allowableMovement = .greatestFiniteMagnitude
        addGestureRecognizer(press)
        holder.transform = CGAffineTransform(translationX: -15, y: 0)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        holder.bounds = bounds
        holder.center = CGPoint(x: bounds.midX, y: bounds.midY)
        panel.frame = bounds
        tint.frame = bounds
        let path = UIBezierPath()
        let top: CGFloat = 15, bottom: CGFloat = 3
        path.addArc(withCenter: CGPoint(x: bounds.midX, y: top), radius: top, startAngle: .pi, endAngle: 0, clockwise: true)
        path.addArc(withCenter: CGPoint(x: bounds.midX, y: bounds.height - bottom), radius: bottom, startAngle: 0, endAngle: .pi, clockwise: true)
        path.close()
        shape.path = path.cgPath
        placeKnob()
    }

    private func placeKnob() {
        knob.center = CGPoint(x: bounds.midX + (tracking ? 0 : 4), y: PhotoDrawScreenLayout.wedgeKnob(value, height: bounds.height))
        accessibilityValue = "\(Int((value * 100).rounded()))%"
    }

    @objc private func pressed(_ recognizer: UILongPressGestureRecognizer) {
        switch recognizer.state {
        case .began, .changed:
            if !tracking {
                tracking = true
                UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState]) {
                    self.holder.transform = CGAffineTransform(translationX: 8, y: 0)
                    self.placeKnob()
                }
            }
            let next = PhotoDrawScreenLayout.wedgeValue(at: recognizer.location(in: self).y, height: bounds.height)
            onChange?(next)
        default:
            tracking = false
            UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState]) {
                self.holder.transform = CGAffineTransform(translationX: -15, y: 0)
                self.placeKnob()
            }
            onRelease?()
        }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        CGRect(x: 0, y: 0, width: 30, height: bounds.height).contains(point)
    }

    override func accessibilityIncrement() { onChange?(min(1, value + 0.1)); onRelease?() }
    override func accessibilityDecrement() { onChange?(max(0, value - 0.1)); onRelease?() }
}

/// Telegram's tool row (`ToolsComponent`): the six brushes side by side,
/// the chosen one standing up out of the row, its band as wide as its
/// size; a drag up or down on the chosen one sizes it.
final class PhotoToolsRow: UIView {
    var onSelect: ((PhotoStroke.Tool) -> Void)?
    var onResize: ((CGFloat) -> Void)?
    var onRelease: (() -> Void)?
    var centers: [CGFloat] = [] { didSet { setNeedsLayout() } }
    private var views: [PhotoToolView] = []
    private var selected: PhotoStroke.Tool = PhotoTools.initial
    private var sizes: [PhotoStroke.Tool: CGFloat] = [:]
    private let fade = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        for tool in PhotoTools.order {
            let view = PhotoToolView(tool: tool)
            view.accessibilityIdentifier = "photo-draw-tool:\(tool.rawValue)"
            view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
            let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
            view.addGestureRecognizer(pan)
            addSubview(view)
            views.append(view)
        }
        fade.colors = [UIColor.white.cgColor, UIColor.white.cgColor, UIColor.white.withAlphaComponent(0).cgColor]
        fade.locations = [0, 0.88, 1]
        layer.mask = fade
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        fade.frame = bounds
        place()
    }

    private func place() {
        typealias M = PhotoDrawScreenLayout.Metrics
        for (index, view) in views.enumerated() where index < centers.count {
            view.bounds = CGRect(origin: .zero, size: M.tool)
            view.center = CGPoint(x: centers[index], y: view.tool == selected ? M.chosenToolY : M.toolY)
        }
    }

    func show(selected tool: PhotoStroke.Tool, colors: [PhotoStroke.Tool: RGBA], sizes: [PhotoStroke.Tool: CGFloat], animated: Bool) {
        let moved = tool != selected
        selected = tool
        self.sizes = sizes
        for view in views {
            view.update(color: colors[view.tool] ?? PhotoTools.color(view.tool), size: sizes[view.tool] ?? PhotoTools.size(view.tool), selected: view.tool == tool)
        }
        guard moved, animated else { return place() }
        UIView.animate(withDuration: 0.7, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.place()
        }
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        guard let view = recognizer.view as? PhotoToolView else { return }
        onSelect?(view.tool)
    }

    private var startSize: CGFloat = 0

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        guard let view = recognizer.view as? PhotoToolView, view.tool == selected else { return }
        switch recognizer.state {
        case .began:
            startSize = sizes[selected] ?? PhotoTools.size(selected)
        case .changed:
            onResize?(min(1, max(0, startSize - recognizer.translation(in: self).y / 200)))
        default:
            onRelease?()
        }
    }
}

/// One brush as Telegram draws it in the row: a white body, its tip in
/// the brush's colour, a band on the body as wide as its size.
final class PhotoToolView: UIView {
    let tool: PhotoStroke.Tool
    /// The chosen one: only it sizes with a drag.
    private(set) var chosen = false
    private var color = RGBA.white
    private var size: CGFloat = 0.5

    init(tool: PhotoStroke.Tool) {
        self.tool = tool
        super.init(frame: .zero)
        isOpaque = false
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = Strings.PhotoEditor.tool(tool.rawValue)
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.35
        layer.shadowRadius = 3
        layer.shadowOffset = .zero
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func update(color: RGBA, size: CGFloat, selected: Bool) {
        self.color = color
        self.size = size
        chosen = selected
        accessibilityTraits = selected ? [.button, .selected] : .button
        accessibilityValue = "\(Int((size * 100).rounded()))%"
        setNeedsDisplay()
    }

    override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard let pan = recognizer as? UIPanGestureRecognizer else { return true }
        let velocity = pan.velocity(in: self)
        return chosen && abs(velocity.y) > abs(velocity.x)
    }

    override func draw(_ rect: CGRect) {
        guard let cg = UIGraphicsGetCurrentContext() else { return }
        let w = bounds.width, h = bounds.height
        let tint = UIColor(color).withAlphaComponent(1)
        let body = UIBezierPath(roundedRect: CGRect(x: 1.5, y: 30, width: w - 3, height: h - 30 + 8), cornerRadius: 3)
        let bodyColors = [UIColor(white: 0.96, alpha: 1).cgColor, UIColor(white: 0.82, alpha: 1).cgColor]
        func fillBody(_ path: UIBezierPath) {
            cg.saveGState()
            path.addClip()
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: bodyColors as CFArray, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: w, y: 0), options: [])
            }
            cg.restoreGState()
        }
        fillBody(body)
        switch tool {
        case .pen, .arrow:
            let cone = UIBezierPath()
            cone.move(to: CGPoint(x: 3, y: 30))
            cone.addLine(to: CGPoint(x: w - 3, y: 30))
            cone.addLine(to: CGPoint(x: w / 2 + 1.2, y: 6))
            cone.addLine(to: CGPoint(x: w / 2 - 1.2, y: 6))
            cone.close()
            UIColor(red: 0.93, green: 0.84, blue: 0.70, alpha: 1).setFill()
            cone.fill()
            let point = UIBezierPath()
            point.move(to: CGPoint(x: w / 2 - 3.2, y: 14))
            point.addLine(to: CGPoint(x: w / 2 + 3.2, y: 14))
            point.addLine(to: CGPoint(x: w / 2 + 1.2, y: 6))
            point.addLine(to: CGPoint(x: w / 2 - 1.2, y: 6))
            point.close()
            tint.setFill()
            point.fill()
            if tool == .arrow {
                let head = UIBezierPath()
                head.move(to: CGPoint(x: w / 2 - 4, y: 6))
                head.addLine(to: CGPoint(x: w / 2, y: 1))
                head.addLine(to: CGPoint(x: w / 2 + 4, y: 6))
                head.lineWidth = 1.6
                head.lineCapStyle = .round
                head.lineJoinStyle = .round
                tint.setStroke()
                head.stroke()
            }
        case .marker, .neon:
            let neck = UIBezierPath(roundedRect: CGRect(x: 4, y: 20, width: w - 8, height: 12), cornerRadius: 1.5)
            fillBody(neck)
            let tip = UIBezierPath()
            tip.move(to: CGPoint(x: 6, y: 21))
            tip.addLine(to: CGPoint(x: w - 6, y: 21))
            tip.addLine(to: CGPoint(x: w - 6, y: 11))
            tip.addLine(to: CGPoint(x: 6, y: 15))
            tip.close()
            if tool == .neon {
                cg.saveGState()
                cg.setShadow(offset: .zero, blur: 6, color: tint.cgColor)
                tint.setFill()
                tip.fill()
                cg.restoreGState()
            } else {
                tint.setFill()
                tip.fill()
            }
        case .blur:
            let cone = UIBezierPath()
            cone.move(to: CGPoint(x: 3, y: 30))
            cone.addLine(to: CGPoint(x: w - 3, y: 30))
            cone.addQuadCurve(to: CGPoint(x: 3, y: 30), controlPoint: CGPoint(x: w / 2, y: -2))
            cg.saveGState()
            cone.addClip()
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [UIColor(white: 0.55, alpha: 1).cgColor, UIColor(white: 0.85, alpha: 1).cgColor] as CFArray, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 8), end: CGPoint(x: 0, y: 30), options: [])
            }
            cg.restoreGState()
        case .eraser:
            let rubber = UIBezierPath(roundedRect: CGRect(x: 2.5, y: 10, width: w - 5, height: 22), byRoundingCorners: [.topLeft, .topRight], cornerRadii: CGSize(width: 5, height: 5))
            UIColor(red: 0.98, green: 0.62, blue: 0.68, alpha: 1).setFill()
            rubber.fill()
            UIColor(white: 0.7, alpha: 1).setFill()
            UIRectFill(CGRect(x: 1.5, y: 30, width: w - 3, height: 2))
        }
        // The band: how big the brush draws.
        guard PhotoTools.colored(tool) else { return }
        let band = CGRect(x: 1.5, y: 32, width: w - 3, height: 12 * (0.08 + 0.92 * size))
        let dark = UIColor(red: CGFloat(color.red) * 0.7, green: CGFloat(color.green) * 0.7, blue: CGFloat(color.blue) * 0.7, alpha: 1)
        cg.saveGState()
        UIBezierPath(roundedRect: band, cornerRadius: 2).addClip()
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [dark.cgColor, tint.cgColor, tint.cgColor, dark.cgColor] as CFArray, locations: [0, 0.15, 0.85, 1]) {
            cg.drawLinearGradient(gradient, start: CGPoint(x: band.minX, y: 0), end: CGPoint(x: band.maxX, y: 0), options: [])
        }
        cg.restoreGState()
    }
}

/// Telegram's colour button (`ColorSwatchComponent`, main): a rainbow
/// disc while a preset or no colour is chosen; a rainbow ring round the
/// colour otherwise.
final class PhotoColorButton: UIControl {
    var color: RGBA? { didSet { update() } }
    private let rainbow = CAGradientLayer()
    private let ring = CAShapeLayer()
    private let fill = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = Strings.PhotoEditor.color
        rainbow.type = .conic
        rainbow.startPoint = CGPoint(x: 0.5, y: 0.5)
        rainbow.endPoint = CGPoint(x: 0.5, y: 0)
        rainbow.colors = stride(from: 0.0, through: 1.0, by: 1.0 / 12).map { UIColor(hue: $0, saturation: 1, brightness: 1, alpha: 1).cgColor }
        ring.fillColor = nil
        ring.strokeColor = UIColor.white.cgColor
        rainbow.mask = ring
        layer.addSublayer(rainbow)
        layer.addSublayer(fill)
        update()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool { didSet { alpha = isHighlighted ? 0.6 : 1 } }

    override func layoutSubviews() {
        super.layoutSubviews()
        let box = CGRect(x: bounds.midX - 12, y: bounds.midY - 12, width: 24, height: 24)
        rainbow.frame = box.insetBy(dx: -1, dy: -1)
        ring.frame = rainbow.bounds
        update()
    }

    private func update() {
        let bounds = rainbow.bounds
        let custom = color != nil
        let width: CGFloat = custom ? 2 : 12
        ring.lineWidth = width
        ring.path = UIBezierPath(ovalIn: bounds.insetBy(dx: width / 2, dy: width / 2)).cgPath
        let inner = CGRect(x: rainbow.frame.minX + 4, y: rainbow.frame.minY + 4, width: bounds.width - 8, height: bounds.height - 8)
        fill.path = custom ? UIBezierPath(ovalIn: inner).cgPath : nil
        fill.fillColor = color.map { UIColor($0).cgColor }
    }
}

/// One of the swatches under the tools: a dot, ringed once chosen.
final class PhotoSwatch: UIControl {
    let color: RGBA
    var chosen = false { didSet { if chosen != oldValue { update(animated: true) } } }
    private let dot = CAShapeLayer()
    private let ring = CAShapeLayer()

    init(color: RGBA) {
        self.color = color
        super.init(frame: .zero)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = Strings.PhotoEditor.color
        dot.fillColor = UIColor(color).cgColor
        ring.fillColor = nil
        ring.strokeColor = UIColor(color).cgColor
        ring.lineWidth = 2
        layer.addSublayer(dot)
        layer.addSublayer(ring)
        update(animated: false)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        update(animated: false)
    }

    private func update(animated: Bool) {
        let box = CGRect(x: bounds.midX - 12, y: bounds.midY - 12, width: 24, height: 24)
        CATransaction.begin()
        CATransaction.setDisableActions(!animated)
        CATransaction.setAnimationDuration(0.2)
        dot.path = UIBezierPath(ovalIn: chosen ? box.insetBy(dx: 5, dy: 5) : box).cgPath
        ring.path = UIBezierPath(ovalIn: box.insetBy(dx: 1, dy: 1)).cgPath
        ring.opacity = chosen ? 1 : 0
        CATransaction.commit()
        accessibilityTraits = chosen ? [.button, .selected] : .button
    }
}

/// Telegram's eyedropper (`EyedropperView`): a 148 loupe, the picture 15
/// times over with a grid, the colour under its middle in its outer ring
/// and its centre square.
final class PhotoLoupe: UIView {
    var sample: ((CGPoint) -> CGPoint)?
    var onPick: ((RGBA) -> Void)?
    private let source: UIImage
    private let pixels: (data: Data, width: Int, height: Int, bytesPerRow: Int)?
    private let container = UIView()
    private let clip = UIView()
    private let zoomed = UIImageView()
    private let grid = CAShapeLayer()
    private let outer = CALayer()
    private let ringLayer = CALayer()
    private let selection = CALayer()
    private var picked = RGBA.white

    init(source: UIImage) {
        self.source = source
        if let cg = source.cgImage, let context = CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            if let data = context.data {
                pixels = (Data(bytes: data, count: cg.width * cg.height * 4), cg.width, cg.height, cg.width * 4)
            } else {
                pixels = nil
            }
        } else {
            pixels = nil
        }
        super.init(frame: .zero)
        let size: CGFloat = 148, outerWidth: CGFloat = 12, ringWidth: CGFloat = 5
        container.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        container.layer.shadowColor = UIColor.black.cgColor
        container.layer.shadowOpacity = 0.6
        container.layer.shadowRadius = 20
        container.layer.shadowOffset = .zero
        addSubview(container)
        let inner = container.bounds.insetBy(dx: outerWidth + ringWidth, dy: outerWidth + ringWidth)
        clip.frame = inner
        clip.clipsToBounds = true
        clip.layer.cornerRadius = inner.width / 2
        clip.backgroundColor = .black
        zoomed.image = source
        zoomed.layer.magnificationFilter = .nearest
        zoomed.frame = CGRect(origin: .zero, size: source.size)
        clip.addSubview(zoomed)
        let lines = CGMutablePath()
        var offset: CGFloat = 7
        for _ in 0..<8 {
            lines.addRect(CGRect(x: 0, y: offset, width: inner.width, height: 1))
            lines.addRect(CGRect(x: offset, y: 0, width: 1, height: inner.height))
            offset += 14
        }
        grid.path = lines
        grid.fillColor = UIColor.white.cgColor
        grid.opacity = 0.6
        grid.frame = clip.bounds
        clip.layer.addSublayer(grid)
        container.addSubview(clip)
        ringLayer.frame = container.bounds.insetBy(dx: outerWidth, dy: outerWidth)
        ringLayer.cornerRadius = ringLayer.frame.width / 2
        ringLayer.borderWidth = ringWidth
        ringLayer.borderColor = UIColor.white.cgColor
        container.layer.addSublayer(ringLayer)
        outer.frame = container.bounds
        outer.cornerRadius = size / 2
        outer.borderWidth = outerWidth
        container.layer.addSublayer(outer)
        selection.frame = CGRect(x: inner.minX + 48, y: inner.minY + 48, width: 17, height: 17)
        selection.borderColor = UIColor.white.cgColor
        selection.borderWidth = 4
        selection.cornerRadius = 2
        container.layer.addSublayer(selection)
        addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(dragged(_:))))
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Touches outside the loupe fall through to the screen.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        container.frame.contains(point)
    }

    func place(at center: CGPoint) {
        container.center = center
        update()
        container.transform = CGAffineTransform(scaleX: 0.01, y: 0.01)
        container.alpha = 0
        UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0) { self.container.transform = .identity }
        UIView.animate(withDuration: 0.2) { self.container.alpha = 1 }
    }

    private func update() {
        let point = sample?(container.center) ?? .zero
        let scale: CGFloat = 15
        zoomed.transform = CGAffineTransform(scaleX: scale, y: scale)
        zoomed.center = CGPoint(x: clip.bounds.width / 2 + (source.size.width / 2 - point.x) * scale, y: clip.bounds.height / 2 + (source.size.height / 2 - point.y) * scale)
        picked = color(at: point)
        let ui = UIColor(picked)
        outer.borderColor = ui.cgColor
        selection.backgroundColor = ui.cgColor
        let light = 0.2126 * picked.red + 0.7152 * picked.green + 0.0722 * picked.blue
        ringLayer.borderColor = (light > 0.9 ? UIColor(Palette.photoEditorLoupeLight) : UIColor.white).cgColor
        grid.fillColor = (light > 0.9 ? UIColor(white: 0.31, alpha: 1) : UIColor.white).cgColor
    }

    private func color(at point: CGPoint) -> RGBA {
        guard let pixels else { return .black }
        let x = Int(point.x * CGFloat(pixels.width) / max(source.size.width, 1))
        let y = Int(point.y * CGFloat(pixels.height) / max(source.size.height, 1))
        guard x >= 0, y >= 0, x < pixels.width, y < pixels.height else { return .black }
        let offset = y * pixels.bytesPerRow + x * 4
        return pixels.data.withUnsafeBytes { bytes in
            RGBA(red: Double(bytes.load(fromByteOffset: offset, as: UInt8.self)) / 255,
                 green: Double(bytes.load(fromByteOffset: offset + 1, as: UInt8.self)) / 255,
                 blue: Double(bytes.load(fromByteOffset: offset + 2, as: UInt8.self)) / 255)
        }
    }

    @objc private func dragged(_ recognizer: UIPanGestureRecognizer) {
        switch recognizer.state {
        case .changed:
            let move = recognizer.translation(in: self)
            container.center = CGPoint(x: container.center.x + move.x, y: container.center.y + move.y)
            recognizer.setTranslation(.zero, in: self)
            update()
        case .ended, .cancelled:
            onPick?(picked)
            dismiss()
        default:
            break
        }
    }

    func dismiss() {
        UIView.animate(withDuration: 0.2) {
            self.container.alpha = 0
            self.container.transform = CGAffineTransform(scaleX: 0.01, y: 0.01)
        } completion: { _ in self.removeFromSuperview() }
    }
}
#endif
