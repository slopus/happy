#if canImport(UIKit)
import HappyLayout
import UIKit

/// Telegram's crop (`TGPhotoCropController`, `TGPhotoCropView`): the
/// picture under a window with corner handles, dimmed and blurred around
/// it; the corners and sides drag, the picture pans and pinches under the
/// window, the wheel straightens it up to 45° either way; it turns a
/// quarter to the left, flips, and keeps a ratio. A second after a touch
/// the window settles back to the middle. "Reset" takes it all back.
final class PhotoCropViewController: UIViewController, UIGestureRecognizerDelegate {
    private let picture: UIImage
    let canvas: CGSize
    private let strokes: [PhotoStroke]
    private let start: PhotoCrop
    private(set) var crop: PhotoCrop
    var onDone: ((PhotoCrop) -> Void)?
    var onCancel: (() -> Void)?

    /// What shows: the window on the screen and the picture under it,
    /// moved between states frame by frame.
    private struct Shown {
        var center: CGPoint
        var size: CGSize
        var rotation: CGFloat
        var window: CGRect
    }
    private var shown: Shown?
    private var animation: (from: Shown, to: Shown, start: CFTimeInterval, duration: CFTimeInterval, done: (() -> Void)?)?
    private var link: CADisplayLink?
    private var settleTimer: Timer?

    private let stage = UIView()
    private let imageView = UIImageView()
    private let strokesView = UIImageView()
    private let dim = PhotoCropOutside()
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .dark))
    private let blurMask = PhotoCropOutside()
    private let frameView = PhotoCropFrameView()
    private let wheel = PhotoCropWheel()
    private let reset = UIButton(type: .system)
    private let cancel = PhotoEditorButton(.symbol("xmark"), identifier: "photo-crop-cancel", label: Strings.PhotoEditor.cancel)
    private let done = PhotoEditorButton(.symbol("checkmark"), accent: true, identifier: "photo-crop-done", label: Strings.PhotoEditor.done)
    private let rotate = PhotoEditorButton.plain("rotate.left", identifier: "photo-crop-rotate", label: Strings.PhotoEditor.rotate)
    private let mirror = PhotoEditorButton.plain("arrow.left.and.right.righttriangle.left.righttriangle.right", identifier: "photo-crop-mirror", label: Strings.PhotoEditor.mirror)
    private let aspect = PhotoEditorButton.plain("aspectratio", identifier: "photo-crop-aspect", label: Strings.PhotoEditor.aspect)
    private lazy var group = PhotoEditorGroup([rotate, mirror, aspect])

    private let pan = UIPanGestureRecognizer()
    private let pinch = UIPinchGestureRecognizer()
    /// What the finger has: a corner or side of the window, or the picture.
    private var dragging: (edges: PhotoCropFrameView.Edges, crop: PhotoCrop, window: CGRect)?
    private var straightening: (crop: PhotoCrop, angle: CGFloat)?

    init(picture: UIImage, edit: PhotoEdit) {
        self.picture = picture
        canvas = edit.canvas
        strokes = edit.strokes
        start = edit.crop
        crop = edit.crop
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalPresentationCapturesStatusBarAppearance = true
        transitioningDelegate = PhotoEditorFade.shared
        overrideUserInterfaceStyle = .dark
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }

    private var layout: PhotoCropScreenLayout {
        PhotoCropScreenLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "photo-crop"
        view.backgroundColor = UIColor(Palette.viewerGround)
        stage.isUserInteractionEnabled = false
        view.addSubview(stage)
        for picture in [imageView, strokesView] {
            picture.layer.anchorPoint = .zero
            picture.contentMode = .scaleToFill
            picture.bounds = CGRect(origin: .zero, size: canvas)
            stage.addSubview(picture)
        }
        imageView.image = picture
        if !strokes.isEmpty {
            let fit = min(1, 1536 / max(canvas.width, canvas.height, 1))
            strokesView.image = PhotoEditRenderer.drawing(strokes, canvas: canvas, crop: .whole(canvas), size: CGSize(width: canvas.width * fit, height: canvas.height * fit), picture: picture, blurred: nil)
        }
        dim.isUserInteractionEnabled = false
        dim.fill = UIColor(Palette.photoEditorDim)
        view.addSubview(dim)
        blur.isUserInteractionEnabled = false
        blur.mask = blurMask
        view.addSubview(blur)
        frameView.isUserInteractionEnabled = false
        frameView.isAccessibilityElement = true
        frameView.accessibilityIdentifier = "photo-crop-window"
        frameView.accessibilityLabel = Strings.PhotoEditor.crop
        view.addSubview(frameView)

        wheel.accessibilityIdentifier = "photo-crop-wheel"
        wheel.onTouch = { [weak self] touching in self?.wheelTouched(touching) }
        wheel.onDrag = { [weak self] dx in self?.straighten(by: dx) }
        view.addSubview(wheel)

        reset.setTitle(Strings.PhotoEditor.reset, for: .normal)
        reset.titleLabel?.font = .systemFont(ofSize: 13)
        reset.tintColor = UIColor(Palette.photoEditorControl)
        reset.accessibilityIdentifier = "photo-crop-reset"
        reset.addTarget(self, action: #selector(resetTapped), for: .touchUpInside)
        view.addSubview(reset)

        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        done.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        rotate.addTarget(self, action: #selector(rotateTapped), for: .touchUpInside)
        mirror.addTarget(self, action: #selector(mirrorTapped), for: .touchUpInside)
        aspect.addTarget(self, action: #selector(aspectTapped), for: .touchUpInside)
        view.addSubview(cancel)
        view.addSubview(done)
        view.addSubview(group)

        pan.addTarget(self, action: #selector(panned(_:)))
        pan.delegate = self
        pan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(pan)
        pinch.addTarget(self, action: #selector(pinched(_:)))
        pinch.delegate = self
        view.addGestureRecognizer(pinch)
        updateButtons()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = layout
        stage.frame = view.bounds
        dim.frame = view.bounds
        blur.frame = view.bounds
        blurMask.frame = view.bounds
        cancel.frame = layout.cancel
        done.frame = layout.done
        group.frame = layout.group
        group.place(layout.groupButtons)
        reset.sizeToFit()
        reset.bounds.size.height = PhotoCropScreenLayout.Metrics.resetHeight
        reset.center = layout.reset
        if animation == nil, dragging == nil, straightening == nil { show(rest()) }
    }

    // MARK: Showing

    /// The window fitted to the area, the picture as the crop has it.
    private func rest() -> Shown {
        let near = shown.map { Self.nearest(crop.rotation, to: $0.rotation) } ?? crop.rotation
        return Shown(center: crop.center, size: crop.size, rotation: near, window: layout.window(for: crop.size))
    }

    /// `rotation` turned by whole turns to be nearest `other`.
    private static func nearest(_ rotation: CGFloat, to other: CGFloat) -> CGFloat {
        var value = rotation
        while value - other > .pi { value -= 2 * .pi }
        while value - other < -.pi { value += 2 * .pi }
        return value
    }

    private static func mapping(_ shown: Shown, mirrored: Bool) -> CGAffineTransform {
        CGAffineTransform(translationX: -shown.center.x, y: -shown.center.y)
            .concatenating(CGAffineTransform(rotationAngle: shown.rotation))
            .concatenating(CGAffineTransform(scaleX: mirrored ? -1 : 1, y: 1))
            .concatenating(CGAffineTransform(scaleX: shown.window.width / max(shown.size.width, 0.0001), y: shown.window.height / max(shown.size.height, 0.0001)))
            .concatenating(CGAffineTransform(translationX: shown.window.midX, y: shown.window.midY))
    }

    /// The crop as it is now, the window where it is on the screen.
    private func current(window: CGRect) -> Shown {
        Shown(center: crop.center, size: crop.size, rotation: Self.nearest(crop.rotation, to: shown?.rotation ?? crop.rotation), window: window)
    }

    private func show(_ next: Shown) {
        shown = next
        let mapping = Self.mapping(next, mirrored: crop.mirrored)
        for picture in [imageView, strokesView] {
            picture.center = .zero
            picture.transform = mapping
        }
        dim.hole = next.window
        blurMask.hole = next.window
        frameView.frame = next.window.insetBy(dx: -PhotoCropFrameView.outset, dy: -PhotoCropFrameView.outset)
        wheel.frame = layout.wheel(under: next.window)
        wheel.angle = crop.angle
    }

    /// To `target` over Telegram's spring (speed 7, bounciness 1: about
    /// 0.35 s, no overshoot to speak of).
    private func animate(to target: Shown, duration: CFTimeInterval = 0.35, done: (() -> Void)? = nil) {
        guard let from = shown else { show(target); done?(); return }
        animation = (from, target, CACurrentMediaTime(), duration, done)
        if link == nil {
            let link = CADisplayLink(target: self, selector: #selector(step))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    @objc private func step() {
        guard let animation else { return stopLink() }
        let t = min(1, (CACurrentMediaTime() - animation.start) / animation.duration)
        let e = 1 - pow(1 - t, 3)
        let a = animation.from, b = animation.to
        func mix(_ x: CGFloat, _ y: CGFloat) -> CGFloat { x + (y - x) * e }
        show(Shown(
            center: CGPoint(x: mix(a.center.x, b.center.x), y: mix(a.center.y, b.center.y)),
            size: CGSize(width: mix(a.size.width, b.size.width), height: mix(a.size.height, b.size.height)),
            rotation: mix(a.rotation, b.rotation),
            window: CGRect(x: mix(a.window.minX, b.window.minX), y: mix(a.window.minY, b.window.minY), width: mix(a.window.width, b.window.width), height: mix(a.window.height, b.window.height))
        ))
        guard t >= 1 else { return }
        self.animation = nil
        stopLink()
        animation.done?()
    }

    private func stopLink() {
        link?.invalidate()
        link = nil
    }

    /// A touch: what moves stops where it is, the blur lifts.
    private func touchBegan() {
        settleTimer?.invalidate()
        settleTimer = nil
        if let animation {
            self.animation = nil
            stopLink()
            show(animation.to)
            animation.done?()
        }
        UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) { self.blur.alpha = 0 }
    }

    /// A second after the last touch the window settles in the middle and
    /// the blur comes back (`TGPhotoCropView`'s confirm timer).
    private func touchEnded() {
        updateButtons()
        settleTimer?.invalidate()
        settleTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.settle() }
        }
    }

    private func settle() {
        settleTimer = nil
        animate(to: rest()) { [weak self] in
            UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) { self?.blur.alpha = 1 }
        }
    }

    // MARK: Gestures

    private var scale: CGFloat {
        guard let shown, shown.size.width > 0 else { return 1 }
        return shown.window.width / shown.size.width
    }

    /// The smallest crop: a tenth of the picture's shorter side, and no
    /// less than 44 points on the screen.
    private var minimumPixels: CGFloat {
        max(min(canvas.width, canvas.height) / 10, PhotoCropScreenLayout.Metrics.minimumSide / max(scale, 0.0001))
    }

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        let point = recognizer.location(in: view)
        if recognizer === pan || recognizer === pinch {
            for control in [cancel, done, group, reset, wheel] as [UIView] where control.frame.insetBy(dx: -4, dy: -4).contains(point) { return false }
            return point.y < layout.area.maxY + PhotoCropScreenLayout.Metrics.areaInset + 16
        }
        return true
    }

    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        (recognizer === pan && other === pinch) || (recognizer === pinch && other === pan)
    }

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        switch recognizer.state {
        case .began:
            touchBegan()
            guard let shown else { return }
            let edges = PhotoCropFrameView.edges(at: recognizer.location(in: view), window: shown.window)
            dragging = (edges, crop, shown.window)
            frameView.setGrid(.major, highlight: crop.aspect == nil ? edges : [])
        case .changed:
            guard let dragging else { return }
            if dragging.edges.isEmpty {
                crop = crop.panned(by: recognizer.translation(in: view), scale: scale, in: canvas)
                recognizer.setTranslation(.zero, in: view)
                show(current(window: shown?.window ?? dragging.window))
            } else {
                resize(dragging, by: recognizer.translation(in: view))
            }
        default:
            guard dragging != nil else { return }
            dragging = nil
            if pinch.state != .changed { frameView.setGrid(.none, highlight: []) }
            touchEnded()
        }
    }

    /// A corner or side dragged `translation` from where it was: the
    /// window follows as far as the picture and the ratio allow, the
    /// picture staying where it is.
    private func resize(_ dragging: (edges: PhotoCropFrameView.Edges, crop: PhotoCrop, window: CGRect), by translation: CGPoint) {
        let from = dragging.window
        var moved = from
        let edges = dragging.edges
        if edges.contains(.left) { moved.origin.x += translation.x; moved.size.width -= translation.x }
        if edges.contains(.right) { moved.size.width += translation.x }
        if edges.contains(.top) { moved.origin.y += translation.y; moved.size.height -= translation.y }
        if edges.contains(.bottom) { moved.size.height += translation.y }
        let least = PhotoCropScreenLayout.Metrics.minimumSide
        if let ratio = dragging.crop.aspect?.ratio, ratio > 0 {
            var width = moved.width, height = moved.height
            let horizontal = edges.contains(.left) || edges.contains(.right)
            let vertical = edges.contains(.top) || edges.contains(.bottom)
            if horizontal && vertical {
                width = max(width, height * ratio)
                height = width / ratio
            } else if horizontal {
                height = width / ratio
            } else {
                width = height * ratio
            }
            let grow = max(1, least / max(min(width, height), 0.0001))
            width *= grow
            height *= grow
            let x = edges.contains(.left) ? from.maxX - width : edges.contains(.right) ? from.minX : from.midX - width / 2
            let y = edges.contains(.top) ? from.maxY - height : edges.contains(.bottom) ? from.minY : from.midY - height / 2
            moved = CGRect(x: x, y: y, width: width, height: height)
        } else {
            if moved.width < least {
                if edges.contains(.left) { moved.origin.x = from.maxX - least }
                moved.size.width = least
            }
            if moved.height < least {
                if edges.contains(.top) { moved.origin.y = from.maxY - least }
                moved.size.height = least
            }
        }
        let fromScale = from.width / max(dragging.crop.size.width, 0.0001)
        crop = dragging.crop.resized(from: from, to: moved, scale: fromScale, minimum: min(canvas.width, canvas.height) / 10, in: canvas)
        // The picture stays put: the window is where the new crop falls
        // under the picture as it was.
        let mapping = Self.mapping(Shown(center: dragging.crop.center, size: dragging.crop.size, rotation: Self.nearest(dragging.crop.rotation, to: shown?.rotation ?? 0), window: from), mirrored: crop.mirrored)
        let points = crop.corners.map { $0.applying(mapping) }
        let xs = points.map(\.x), ys = points.map(\.y)
        let window = CGRect(x: xs.min() ?? 0, y: ys.min() ?? 0, width: (xs.max() ?? 0) - (xs.min() ?? 0), height: (ys.max() ?? 0) - (ys.min() ?? 0))
        show(current(window: window))
    }

    @objc private func pinched(_ recognizer: UIPinchGestureRecognizer) {
        switch recognizer.state {
        case .began:
            touchBegan()
            frameView.setGrid(.major, highlight: [])
        case .changed:
            crop = crop.zoomed(by: recognizer.scale, minimum: min(canvas.width, canvas.height) / 10, in: canvas)
            recognizer.scale = 1
            if let shown { show(current(window: shown.window)) }
        default:
            if dragging == nil { frameView.setGrid(.none, highlight: []) }
            touchEnded()
        }
    }

    private func wheelTouched(_ touching: Bool) {
        if touching {
            touchBegan()
            straightening = (crop, crop.angle)
            frameView.setGrid(.minor, highlight: [])
        } else {
            straightening = nil
            frameView.setGrid(.none, highlight: [])
            touchEnded()
        }
    }

    /// The wheel dragged `dx`: the picture turns and zooms in as far as
    /// it must for the window to stay on it; back, it zooms out again.
    private func straighten(by dx: CGFloat) {
        guard var straightening, let shown else { return }
        straightening.angle = PhotoCropScreenLayout.angle(straightening.angle, dragged: dx)
        self.straightening = straightening
        let before = crop
        crop = straightening.crop.straightened(straightening.angle, in: canvas)
        if before.angle != crop.angle { show(current(window: shown.window)) }
        wheel.angle = crop.angle
    }

    // MARK: Buttons

    private func updateButtons() {
        mirror.applied = crop.mirrored
        aspect.applied = crop.aspect != nil
        let changed = !crop.isWhole(canvas) || crop.aspect != nil
        UIView.animate(withDuration: 0.2) { self.reset.alpha = changed ? 1 : 0 }
        reset.isEnabled = changed
    }

    @objc private func rotateTapped() {
        touchBegan()
        crop = crop.rotatedLeft().fitted(canvas)
        guard let shown else { return }
        var target = rest()
        target.rotation = shown.rotation - .pi / 2
        animate(to: target) { [weak self] in self?.blurBack() }
        updateButtons()
    }

    @objc private func mirrorTapped() {
        touchBegan()
        crop.mirrored.toggle()
        show(rest())
        blurBack()
        updateButtons()
    }

    @objc private func aspectTapped() {
        if crop.aspect != nil {
            crop = crop.with(aspect: nil, in: canvas)
            updateButtons()
            return
        }
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        let original = crop.turns % 2 == 0 ? PhotoAspect(canvas.width, canvas.height) : PhotoAspect(canvas.height, canvas.width)
        let choices: [(String, PhotoAspect)] = [(Strings.PhotoEditor.original, original), (Strings.PhotoEditor.square, .square)]
            + PhotoAspects.ratios.map { ratio in
                let shown = PhotoAspects.oriented(ratio, like: crop.size)
                return ("\(Int(shown.width)):\(Int(shown.height))", shown)
            }
        for (title, ratio) in choices {
            sheet.addAction(UIAlertAction(title: title, style: .default) { [weak self] _ in self?.lock(ratio) })
        }
        sheet.addAction(UIAlertAction(title: Strings.PhotoEditor.cancel, style: .cancel))
        sheet.popoverPresentationController?.sourceView = aspect
        present(sheet, animated: true)
    }

    private func lock(_ ratio: PhotoAspect) {
        touchBegan()
        crop = crop.with(aspect: ratio, in: canvas)
        animate(to: rest()) { [weak self] in self?.blurBack() }
        updateButtons()
    }

    @objc private func resetTapped() {
        touchBegan()
        wheel.spin(from: crop.angle)
        crop = .whole(canvas)
        animate(to: rest()) { [weak self] in self?.blurBack() }
        updateButtons()
    }

    private func blurBack() {
        UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) { self.blur.alpha = 1 }
    }

    @objc private func cancelTapped() {
        guard crop != start else { return leave() }
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: Strings.PhotoEditor.discard, style: .destructive) { [weak self] _ in self?.leave() })
        sheet.addAction(UIAlertAction(title: Strings.PhotoEditor.cancel, style: .cancel))
        sheet.popoverPresentationController?.sourceView = cancel
        present(sheet, animated: true)
    }

    private func leave() {
        settleTimer?.invalidate()
        stopLink()
        onCancel?()
    }

    @objc private func doneTapped() {
        settleTimer?.invalidate()
        stopLink()
        onDone?(crop)
    }
}

/// A fill over everything but `hole` (the dim and the blur's mask).
final class PhotoCropOutside: UIView {
    override class var layerClass: AnyClass { CAShapeLayer.self }
    var fill: UIColor = .black { didSet { shape.fillColor = fill.cgColor } }
    var hole: CGRect = .zero { didSet { update() } }
    private var shape: CAShapeLayer { layer as! CAShapeLayer }

    override init(frame: CGRect) {
        super.init(frame: frame)
        shape.fillRule = .evenOdd
        shape.fillColor = fill.cgColor
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        update()
    }

    private func update() {
        let path = CGMutablePath()
        path.addRect(bounds.insetBy(dx: -200, dy: -200))
        path.addRect(hole)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shape.path = path
        CATransaction.commit()
    }
}

/// The crop's window (`TGPhotoCropAreaView`): a thin white edge, the
/// heavy corners just outside it, the thirds while a corner or the
/// picture moves and the ninths while the wheel turns.
final class PhotoCropFrameView: UIView {
    struct Edges: OptionSet {
        let rawValue: Int
        static let left = Edges(rawValue: 1)
        static let right = Edges(rawValue: 2)
        static let top = Edges(rawValue: 4)
        static let bottom = Edges(rawValue: 8)
    }

    enum Grid { case none, major, minor }

    /// How far the corners stand out of the window.
    static let outset: CGFloat = 3
    private let border = CAShapeLayer()
    private let corners = CAShapeLayer()
    private let major = CAShapeLayer()
    private let minor = CAShapeLayer()
    private let highlight = CAShapeLayer()
    private var highlighted: Edges = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        let white = UIColor(Palette.photoEditorControl).cgColor
        for line in [border, corners, major, minor, highlight] {
            line.fillColor = nil
            line.actions = ["path": NSNull(), "position": NSNull(), "bounds": NSNull()]
            layer.addSublayer(line)
        }
        border.strokeColor = white
        border.lineWidth = 1
        corners.strokeColor = white
        corners.lineWidth = 3
        major.strokeColor = white
        major.lineWidth = 0.5
        major.opacity = 0
        minor.strokeColor = UIColor(Palette.photoEditorMinorGrid).cgColor
        minor.lineWidth = 0.5
        minor.opacity = 0
        highlight.strokeColor = white
        highlight.lineWidth = 2
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Which of the window's sides a touch at `point` takes: within 22 of
    /// a corner both, of a side that one, else none (the picture).
    static func edges(at point: CGPoint, window: CGRect) -> Edges {
        let reach: CGFloat = 22
        guard window.insetBy(dx: -reach, dy: -reach).contains(point) else { return [] }
        var edges: Edges = []
        if abs(point.x - window.minX) < reach { edges.insert(.left) } else if abs(point.x - window.maxX) < reach { edges.insert(.right) }
        if abs(point.y - window.minY) < reach { edges.insert(.top) } else if abs(point.y - window.maxY) < reach { edges.insert(.bottom) }
        return edges
    }

    func setGrid(_ grid: Grid, highlight edges: Edges) {
        highlighted = edges
        setNeedsLayout()
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.2)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeInEaseOut))
        major.opacity = grid == .major ? 1 : 0
        minor.opacity = grid == .minor ? 1 : 0
        CATransaction.commit()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let window = bounds.insetBy(dx: Self.outset, dy: Self.outset)
        border.path = CGPath(rect: window.insetBy(dx: -0.5, dy: -0.5), transform: nil)
        let arm: CGFloat = 20, out = Self.outset - 1.5
        let path = CGMutablePath()
        let box = window.insetBy(dx: -out, dy: -out)
        for (x, y, dx, dy) in [(box.minX, box.minY, 1.0, 1.0), (box.maxX, box.minY, -1.0, 1.0), (box.maxX, box.maxY, -1.0, -1.0), (box.minX, box.maxY, 1.0, -1.0)] as [(CGFloat, CGFloat, CGFloat, CGFloat)] {
            path.move(to: CGPoint(x: x + arm * dx, y: y))
            path.addLine(to: CGPoint(x: x, y: y))
            path.addLine(to: CGPoint(x: x, y: y + arm * dy))
        }
        corners.path = path
        major.path = Self.grid(window, every: 3)
        minor.path = Self.grid(window, every: 9)
        let lines = CGMutablePath()
        if highlighted.contains(.left) { lines.move(to: CGPoint(x: window.minX, y: window.minY)); lines.addLine(to: CGPoint(x: window.minX, y: window.maxY)) }
        if highlighted.contains(.right) { lines.move(to: CGPoint(x: window.maxX, y: window.minY)); lines.addLine(to: CGPoint(x: window.maxX, y: window.maxY)) }
        if highlighted.contains(.top) { lines.move(to: CGPoint(x: window.minX, y: window.minY)); lines.addLine(to: CGPoint(x: window.maxX, y: window.minY)) }
        if highlighted.contains(.bottom) { lines.move(to: CGPoint(x: window.minX, y: window.maxY)); lines.addLine(to: CGPoint(x: window.maxX, y: window.maxY)) }
        highlight.path = lines
    }

    private static func grid(_ rect: CGRect, every parts: Int) -> CGPath {
        let path = CGMutablePath()
        for index in 1..<parts {
            let x = rect.minX + rect.width * CGFloat(index) / CGFloat(parts)
            let y = rect.minY + rect.height * CGFloat(index) / CGFloat(parts)
            path.move(to: CGPoint(x: x, y: rect.minY))
            path.addLine(to: CGPoint(x: x, y: rect.maxY))
            path.move(to: CGPoint(x: rect.minX, y: y))
            path.addLine(to: CGPoint(x: rect.maxX, y: y))
        }
        return path
    }
}

/// Telegram's straightening wheel (`TGPhotoCropRotationView`): the lower
/// edge of a 400 dial whose ticks turn with the picture, over a fixed
/// needle in the middle.
final class PhotoCropWheel: UIView {
    var onTouch: ((Bool) -> Void)?
    var onDrag: ((CGFloat) -> Void)?
    var angle: CGFloat = 0 {
        didSet {
            guard angle != oldValue else { return }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            dial.setAffineTransform(CGAffineTransform(rotationAngle: angle))
            CATransaction.commit()
            accessibilityValue = "\(Int((angle * 180 / .pi).rounded()))°"
        }
    }
    /// Turns back from `angle` to where it is now, as the reset does.
    func spin(from angle: CGFloat) {
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.fromValue = angle
        spin.toValue = 0
        spin.duration = 0.35
        spin.timingFunction = CAMediaTimingFunction(controlPoints: 0, 0, 0.58, 1)
        spin.isAdditive = false
        dial.add(spin, forKey: "spin")
    }

    private let dial = CAShapeLayer()
    private let needle = CAShapeLayer()
    private var last: CGFloat?

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        isAccessibilityElement = true
        accessibilityTraits = .adjustable
        let white = UIColor(Palette.photoEditorWheel).cgColor
        dial.bounds = CGRect(x: 0, y: 0, width: 400, height: 400)
        dial.strokeColor = white
        dial.fillColor = nil
        dial.lineCap = .round
        let path = CGMutablePath()
        for step in 0..<144 {
            let theta = CGFloat(step) * .pi * 2 / 144
            let long = step % 6 == 0
            let outer: CGFloat = 196, inner: CGFloat = long ? 184 : 189
            path.move(to: CGPoint(x: 200 + sin(theta) * outer, y: 200 + cos(theta) * outer))
            path.addLine(to: CGPoint(x: 200 + sin(theta) * inner, y: 200 + cos(theta) * inner))
        }
        dial.path = path
        dial.lineWidth = 1.5
        layer.addSublayer(dial)
        let triangle = CGMutablePath()
        triangle.move(to: CGPoint(x: 5, y: 0))
        triangle.addLine(to: CGPoint(x: 10, y: 8))
        triangle.addLine(to: CGPoint(x: 0, y: 8))
        triangle.closeSubpath()
        needle.path = triangle
        needle.fillColor = UIColor(Palette.photoEditorControl).cgColor
        needle.bounds = CGRect(x: 0, y: 0, width: 10, height: 10)
        layer.addSublayer(needle)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        dial.position = CGPoint(x: bounds.midX, y: -152)
        needle.position = CGPoint(x: bounds.midX, y: 52)
        CATransaction.commit()
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        CGRect(x: 0, y: 0, width: bounds.width, height: 70).contains(point)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        last = touches.first?.location(in: self).x
        onTouch?(true)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let x = touches.first?.location(in: self).x, let last else { return }
        self.last = x
        onDrag?(x - last)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        last = nil
        onTouch?(false)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        touchesEnded(touches, with: event)
    }

    override func accessibilityIncrement() {
        onTouch?(true)
        onDrag?(-5 * .pi * 1.15)
        onTouch?(false)
    }

    override func accessibilityDecrement() {
        onTouch?(true)
        onDrag?(5 * .pi * 1.15)
        onTouch?(false)
    }
}
#endif
