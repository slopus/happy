#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// A todo Surface, as desktop's todo list: "Add a todo" at the top, the
/// active todos in their order with section headings over cards of their
/// own, then the completed ones under "Show N completed". A tap on a box
/// checks it off where it is, then it goes to the completed; a tap on the
/// text edits it in place; a hold lifts a todo to drag it elsewhere; a
/// swipe deletes it, with an undo, or opens who changed what. The bar's
/// menu shows the deleted ones, to bring back. Every change shows at
/// once and is kept until the computer takes it (`TodoLibrary`); what
/// others change arrives live.
final class TodoListViewController: UIViewController, UITextFieldDelegate, UIGestureRecognizerDelegate {
    private let session: Session
    let surfaceId: String
    private let name: String
    let mode: TodoListInput.Mode
    private let library: TodoLibrary
    let list = CardListView()
    /// The one field, over the row being edited or the add row.
    let editor = UITextField()
    let undoBar = TodoUndoBar()
    private var pipeline: ApplyPipeline<TodoListInput, Applied, Output>?
    private var following: Task<Void, Never>?
    private var headerWatch: Watch?
    private var accessWatch: Watch?
    /// What the person's role lets them do to the list: everything, or
    /// on a cloud server without `content.write`, read it.
    private var writable: Bool { session.gate.allows(.contentWrite) }
    /// What the rows on screen were worked out from.
    private(set) var state = TodoListState()
    private var geometry: [String: TodoRowGeometry] = [:]
    /// The active todos in the order on screen.
    private(set) var activeOrder: [String] = []
    private(set) var editingID: String?
    private var settling: [String: TodoItem] = [:]
    private(set) var completedShown = false
    private var drag: Drag?
    private var keyboardTop: CGFloat?
    private lazy var hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))

    private struct Drag {
        let id: String
        let snapshot: UIView
        let grab: CGFloat
        let from: Int
        var order: [String]
    }

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
        var state: TodoListState?
    }

    struct Output: Sendable {
        var items: [CardItem]
        var geometry: [String: TodoRowGeometry]
        var active: [String]
        var state: TodoListState
        var width: CGFloat
        /// The rows at another width, for a width change (`CardListView.replan`).
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    init(session: Session, surface: AgentWire.Surface, mode: TodoListInput.Mode = .list) {
        self.session = session
        surfaceId = surface.id
        name = surface.name.isEmpty ? Strings.Todos.title : surface.name
        self.mode = mode
        library = session.engine.todos
        super.init(nibName: nil, bundle: nil)
        title = mode == .deleted ? Strings.Todos.deletedTitle : name
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // Not `isolated deinit` (see `Watch`).
    deinit {
        following?.cancel()
        pipeline?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.accessibilityIdentifier = mode == .deleted ? "todo-deleted" : "todo-list"
        list.accessibilityIdentifier = "todo-list-rows"
        view.addSubview(list)
        view.addSubview(undoBar)
        HeaderBar.edge(list.edge, in: self)
        list.onSelectAt = { [weak self] id, point in self?.tapped(id, at: point) }
        list.onSelect = { [weak self] id in self?.activated(id) }
        list.swipeActions = { [weak self] id in self?.swipeActions(id) ?? [] }
        list.accessibilityActions = { [weak self] id in self?.accessibilityActions(id) ?? [] }
        list.makeOverlay = { [weak self] overlay, _ in
            guard overlay.kind == TodoListItems.editorKey, let self else { return nil }
            // The row is made after the list applies, so the field takes
            // the keyboard once it is in the window.
            DispatchQueue.main.async { [weak self] in self?.focusEditor() }
            return editor
        }
        setUpEditor()
        setUpBar()
        if mode == .list {
            hold.minimumPressDuration = 0.35
            hold.delegate = self
            list.addGestureRecognizer(hold)
        }

        let pipeline = ApplyPipeline<TodoListInput, Applied, Output>(
            input: currentInput(),
            state: Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        let library = library, surfaceId = surfaceId, mode = mode
        following = Task { [weak pipeline] in
            let states = await library.states(surfaceId)
            if mode == .deleted { await library.showDeleted(surfaceId) }
            pipeline?.follow(ifChanged: states) { input, state in
                guard input.state != state else { return false }
                input.state = state
                return true
            }
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
        accessWatch = session.watchAccess { [weak self] in
            guard let self else { return }
            if !writable, editingID != nil { editingID = nil; editor.resignFirstResponder() }
            updateInput()
        }
        headerWatch = session.watchHeader { [weak self] state in
            guard let self else { return }
            navigationItem.title = Strings.HeaderStatus.title(state) ?? (mode == .deleted ? Strings.Todos.deletedTitle : name)
        }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardWillHide(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    private func setUpEditor() {
        editor.font = Fonts.ui(.regular, size: TodoMetrics.textSize * (traitCollection.textEnvironment?.scale.multiplier ?? 1))
        editor.textColor = UIColor(Palette.text)
        editor.clearButtonMode = .whileEditing
        editor.autocapitalizationType = .sentences
        editor.delegate = self
        editor.accessibilityIdentifier = "todo-editor"
    }

    private func setUpBar() {
        guard mode == .list else { return }
        let more = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: [
            UIAction(title: Strings.Todos.showDeleted, image: UIImage(systemName: "trash")) { [weak self] _ in self?.openDeleted() },
        ]))
        more.accessibilityLabel = Strings.Todos.more
        more.accessibilityIdentifier = "todo-more"
        navigationItem.rightBarButtonItem = more
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if editor.isFirstResponder { editor.resignFirstResponder() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.maxWidth = ContentWidth.maxWidth
        list.frame = view.bounds
        undoBar.frame = view.bounds
        applyInsets()
        updateInput()
    }

    private func applyInsets() {
        let safe = view.safeAreaInsets
        var bottom = safe.bottom
        if let keyboardTop { bottom = max(bottom, view.bounds.height - keyboardTop) }
        list.setInsets(UIEdgeInsets(top: safe.top + CardListMetrics.contentTop, left: 0, bottom: bottom + CardListMetrics.contentBottom, right: 0))
        undoBar.bottomInset = bottom
    }

    // MARK: Derivation

    private func currentInput() -> TodoListInput {
        var input = TodoListInput()
        input.mode = mode
        input.width = list.contentWidth
        input.scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        input.displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        input.dark = traitCollection.userInterfaceStyle == .dark
        input.completedShown = completedShown
        input.editingID = editingID
        input.settling = settling
        input.dragOrder = drag?.order
        input.writable = writable
        return input
    }

    private func updateInput() {
        let next = currentInput()
        pipeline?.update { input in
            input.width = next.width
            input.scale = next.scale
            input.displayScale = next.displayScale
            input.dark = next.dark
            input.completedShown = next.completedShown
            input.editingID = next.editingID
            input.settling = next.settling
            input.dragOrder = next.dragOrder
        }
    }

    nonisolated static func derive(_ input: TodoListInput, applied: Applied) -> (output: Output, state: Applied)? {
        let made = TodoListItems.items(input)
        var counter = applied.counter
        let items = CardItems.revise(made.items, previous: applied.items, counter: &counter)
        let order = items.map(\.id)
        let moved = order != applied.order || items.contains { applied.items[$0.id]?.revision != $0.revision }
        guard moved || applied.state != input.state else { return nil }
        let next = Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter, state: input.state)
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return TodoListItems.items(input).items
        }
        return (Output(items: items, geometry: made.geometry, active: made.active, state: input.state, width: input.width, replan: replan), next)
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        state = output.state
        geometry = output.geometry
        activeOrder = output.active
        list.apply(output.items, animated: true, replan: output.replan)
        if let drag { list.rowView(TodoListItems.rowID(drag.id))?.alpha = 0 }
        focusEditor()
        return true
    }

    private func focusEditor() {
        if editingID != nil, editor.window != nil, !editor.isFirstResponder { editor.becomeFirstResponder() }
    }

    // MARK: Taps

    private func todo(_ id: String) -> TodoItem? {
        state.active.first { $0.id == id } ?? state.completed.first { $0.id == id } ?? state.deleted.first { $0.id == id } ?? settling[id]
    }

    private func tapped(_ rowID: String, at point: CGPoint) {
        guard let id = TodoListItems.todoID(rowID), mode == .list else { return activated(rowID) }
        guard writable else { return }
        guard let todo = todo(id) else { return }
        if todo.heading == nil, let hit = geometry[rowID]?.hit, hit.contains(point) {
            toggle(id)
        } else {
            startEditing(id)
        }
    }

    /// A row's own act: what VoiceOver's activate does, and a tap where
    /// a row has only one.
    func activated(_ rowID: String) {
        switch rowID {
        case TodoListItems.addID: if writable { startEditing(TodoListItems.addID) }
        case TodoListItems.failureID: Task { [library, surfaceId] in await library.dismissFailure(surfaceId) }
        case TodoListItems.toggleID:
            completedShown.toggle()
            Haptics.play(.fold)
            updateInput()
        default:
            guard writable, let id = TodoListItems.todoID(rowID), let todo = todo(id) else { return }
            if mode == .deleted { return restore(id) }
            if todo.heading != nil { startEditing(id) } else { toggle(id) }
        }
    }

    /// Checks a todo off, where it is for a moment, or back on.
    func toggle(_ id: String) {
        guard let todo = todo(id), todo.status != .deleted, settling[id] == nil else { return }
        let done = todo.status == .active
        if done {
            settling[id] = todo
            if let check = geometry[TodoListItems.rowID(id)]?.check, let frame = list.frame(of: TodoListItems.rowID(id)) {
                TodoCheckPop.play(in: list, at: check.offsetBy(dx: frame.minX, dy: frame.minY))
            }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            updateInput()
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(UIAccessibility.isReduceMotionEnabled ? 0 : 650))
                guard let self else { return }
                settling[id] = nil
                updateInput()
            }
        }
        Task { [library, surfaceId] in await library.setDone(surfaceId, id, done) }
    }

    // MARK: Editing

    /// Puts the field over `id`'s text, or the add row's.
    func startEditing(_ id: String) {
        guard editingID != id else { return }
        if editingID != nil { commit() }
        editingID = id
        if id == TodoListItems.addID {
            editor.text = ""
            editor.placeholder = Strings.Todos.add
            editor.returnKeyType = .default
            editor.accessibilityLabel = Strings.Todos.add
        } else {
            editor.text = todo(id)?.text ?? ""
            editor.placeholder = nil
            editor.returnKeyType = .done
            editor.accessibilityLabel = Strings.Todos.todoText
        }
        updateInput()
    }

    /// Keeps what the field holds: a new todo, or the todo's new text.
    func commit() {
        guard let id = editingID else { return }
        let text = editor.text ?? ""
        let library = library, surfaceId = surfaceId
        if id == TodoListItems.addID {
            guard TodoText.normalized(text) != nil else { return }
            editor.text = ""
            Task { await library.add(surfaceId, text: text) }
        } else if text != todo(id)?.text {
            Task { await library.setText(surfaceId, id, text: text) }
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        // Adding stays in the field for the next one, as Reminders does.
        if editingID == TodoListItems.addID, TodoText.normalized(editor.text ?? "") != nil {
            commit()
            return false
        }
        textField.resignFirstResponder()
        return true
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
        commit()
        editingID = nil
        updateInput()
    }

    // MARK: Swipes and menus

    private func swipeActions(_ rowID: String) -> [ListSwipeAction] {
        guard let id = TodoListItems.todoID(rowID), let todo = todo(id), drag == nil else { return [] }
        if mode == .deleted {
            guard writable else { return [] }
            return [ListSwipeAction(title: Strings.Todos.restore, image: .icon(.ionicons("return-up-back-outline"), size: 20), color: UIColor(Palette.todoCheck)) { [weak self] in self?.restore(id) }]
        }
        var actions = !writable ? [] : [ListSwipeAction(title: Strings.Todos.delete, image: .icon(.ionicons("trash-outline"), size: 20), color: UIColor(Palette.statusError), isDestructive: true) { [weak self] in self?.delete(id) }]
        actions.append(ListSwipeAction(title: Strings.Todos.history, image: .icon(.ionicons("time-outline"), size: 20), color: UIColor(Palette.settingsSecondary)) { [weak self] in self?.openHistory(id) })
        return actions
    }

    private func accessibilityActions(_ rowID: String) -> [UIAccessibilityCustomAction] {
        guard let id = TodoListItems.todoID(rowID), let todo = todo(id) else { return [] }
        if !writable {
            return mode == .deleted ? [] : [UIAccessibilityCustomAction(name: Strings.Todos.history) { [weak self] _ in self?.openHistory(id); return true }]
        }
        if mode == .deleted {
            return [UIAccessibilityCustomAction(name: Strings.Todos.restore) { [weak self] _ in self?.restore(id); return true }]
        }
        var actions: [UIAccessibilityCustomAction] = []
        if todo.heading == nil {
            actions.append(UIAccessibilityCustomAction(name: todo.status == .active ? Strings.Todos.markDone(todo.text) : Strings.Todos.markNotDone(todo.text)) { [weak self] _ in self?.toggle(id); return true })
        }
        actions.append(UIAccessibilityCustomAction(name: Strings.Todos.todoText) { [weak self] _ in self?.startEditing(id); return true })
        if let index = activeOrder.firstIndex(of: id) {
            if index > 0 { actions.append(UIAccessibilityCustomAction(name: Strings.Todos.moveUp) { [weak self] _ in self?.move(id, to: index - 1); return true }) }
            if index < activeOrder.count - 1 { actions.append(UIAccessibilityCustomAction(name: Strings.Todos.moveDown) { [weak self] _ in self?.move(id, to: index + 1); return true }) }
        }
        actions.append(UIAccessibilityCustomAction(name: todo.heading.map(Strings.Todos.deleteHeading) ?? Strings.Todos.deleteLabel(todo.text)) { [weak self] _ in self?.delete(id); return true })
        actions.append(UIAccessibilityCustomAction(name: Strings.Todos.history) { [weak self] _ in self?.openHistory(id); return true })
        return actions
    }

    /// Deletes a todo and offers it back where it was.
    func delete(_ id: String) {
        guard let todo = todo(id) else { return }
        if editingID == id { editingID = nil; editor.resignFirstResponder() }
        let place: TodoLibrary.Place = activeOrder.firstIndex(of: id).map { .after($0 > 0 ? activeOrder[$0 - 1] : nil) } ?? .end
        let status = todo.status
        let library = library, surfaceId = surfaceId
        Task { await library.delete(surfaceId, id) }
        Haptics.play(.putAway)
        undoBar.show(Strings.Todos.deleted(todo.heading ?? todo.text)) {
            Task { await library.restore(surfaceId, id, to: place, as: status == .completed ? .completed : .active) }
        }
    }

    func restore(_ id: String) {
        Task { [library, surfaceId] in await library.restore(surfaceId, id) }
    }

    func move(_ id: String, to index: Int) {
        Task { [library, surfaceId] in await library.move(surfaceId, id, to: index) }
    }

    func openDeleted() {
        let surface = AgentWire.Surface(id: surfaceId, type: "todo", name: name)
        navigationController?.pushViewController(TodoListViewController(session: session, surface: surface, mode: .deleted), animated: true)
    }

    func openHistory(_ id: String) {
        guard let todo = todo(id) else { return }
        navigationController?.pushViewController(TodoHistoryViewController(session: session, surfaceId: surfaceId, todo: todo), animated: true)
    }

    // MARK: Drag

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === hold else { return true }
        return writable && editingID == nil && activeRow(at: gestureRecognizer.location(in: list)) != nil
    }

    /// The active todo under `point`, in the list's coordinates.
    private func activeRow(at point: CGPoint) -> String? {
        activeOrder.first { id in list.frame(of: TodoListItems.rowID(id))?.contains(point) == true && settling[id] == nil }
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        let point = recognizer.location(in: list)
        switch recognizer.state {
        case .began:
            guard let id = activeRow(at: point), let frame = list.frame(of: TodoListItems.rowID(id)),
                  let row = list.rowView(TodoListItems.rowID(id)), let snapshot = row.snapshotView(afterScreenUpdates: false),
                  let from = activeOrder.firstIndex(of: id) else { return }
            snapshot.frame = frame
            snapshot.layer.shadowColor = UIColor.black.cgColor
            snapshot.layer.shadowOpacity = 0.18
            snapshot.layer.shadowRadius = 12
            snapshot.layer.shadowOffset = CGSize(width: 0, height: 6)
            list.addSubview(snapshot)
            row.alpha = 0
            drag = Drag(id: id, snapshot: snapshot, grab: point.y - frame.midY, from: from, order: activeOrder)
            Haptics.play(.lift)
            UIView.animate(withDuration: 0.2) { snapshot.transform = CGAffineTransform(scaleX: TodoMetrics.liftScale, y: TodoMetrics.liftScale) }
            updateInput()
        case .changed:
            guard var drag else { return }
            drag.snapshot.center.y = point.y - drag.grab
            let middle = drag.snapshot.center.y
            var order = drag.order
            guard var index = order.firstIndex(of: drag.id) else { return }
            while index > 0, let above = list.frame(of: TodoListItems.rowID(order[index - 1])), middle < above.midY {
                order.swapAt(index, index - 1); index -= 1
            }
            while index < order.count - 1, let below = list.frame(of: TodoListItems.rowID(order[index + 1])), middle > below.midY {
                order.swapAt(index, index + 1); index += 1
            }
            if order != drag.order {
                drag.order = order
                Haptics.play(.slot)
                self.drag = drag
                updateInput()
            } else {
                self.drag = drag
            }
        case .ended:
            guard let drag else { return }
            let to = drag.order.firstIndex(of: drag.id) ?? drag.from
            Haptics.play(.drop)
            let library = library, surfaceId = surfaceId
            Task { @MainActor [weak self] in
                if to != drag.from { await library.move(surfaceId, drag.id, to: to) }
                self?.land(drag)
            }
        default:
            guard let drag else { return }
            self.drag?.order = activeOrder
            land(drag, cancelled: true)
        }
    }

    /// Sets the dragged row down in its place and shows it again.
    private func land(_ dragged: Drag, cancelled: Bool = false) {
        drag = nil
        updateInput()
        let rowID = TodoListItems.rowID(dragged.id)
        let target = list.frame(of: rowID) ?? dragged.snapshot.frame
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut]) {
            dragged.snapshot.transform = .identity
            dragged.snapshot.frame = target
            dragged.snapshot.layer.shadowOpacity = 0
        } completion: { _ in
            self.list.rowView(rowID)?.alpha = 1
            dragged.snapshot.removeFromSuperview()
        }
    }

    // MARK: Keyboard

    @objc private func keyboardWillChange(_ notification: Notification) {
        guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        keyboardTop = view.convert(frame, from: nil).minY
        applyInsets()
        if let editingID, let row = list.frame(of: editingID == TodoListItems.addID ? editingID : TodoListItems.rowID(editingID)),
           let keyboardTop, list.convert(row, to: view).maxY > keyboardTop {
            list.scroll(to: editingID == TodoListItems.addID ? editingID : TodoListItems.rowID(editingID), animated: true)
        }
    }

    @objc private func keyboardWillHide(_ notification: Notification) {
        keyboardTop = nil
        applyInsets()
    }
}
#endif
