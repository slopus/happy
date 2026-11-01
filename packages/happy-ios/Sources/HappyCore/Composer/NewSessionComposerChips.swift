/// The creation draft offers modes before a session record exists. The
/// same chips and wide settings menu are used once the session is made.
extension ComposerChipSet {
    public init(choices: NewSessionChoices, titles: Titles) {
        func option(_ value: NewSessionChoices.Option) -> Option {
            Option(key: value.key, label: value.name, isDisabled: value.isDisabled)
        }
        let permissionTitle = choices.currentAgent.key == "codex" ? titles.codexPermission : titles.permission
        if choices.hasAvailableHarness, let current = choices.currentPermission, !choices.permissionOptions.isEmpty {
            permission = Chip(
                label: choices.permissionLabel,
                accessibilityLabel: permissionTitle,
                sections: [Section(title: nil, options: choices.permissionOptions.map(option))],
                selectedKey: current.key
            )
        } else {
            permission = nil
        }
        model = Chip(
            label: choices.modelChipLabel,
            accessibilityLabel: titles.model,
            sections: choices.hasAvailableHarness && !choices.modelOptions.isEmpty ? choices.modelSections.map {
                Section(title: $0.title ?? titles.model, options: $0.options.map(option))
            } : nil,
            selectedKey: choices.currentModel?.key
        )
        if choices.hasAvailableHarness, let current = choices.currentEffort, !choices.effortOptions.isEmpty {
            effort = Chip(
                label: current.name,
                accessibilityLabel: titles.effort,
                sections: [Section(title: nil, options: choices.effortOptions.map(option))],
                selectedKey: current.key
            )
        } else {
            effort = nil
        }
        showsSettings = permission != nil || model.sections != nil || effort != nil
        var settings: [SettingsSection] = []
        if let permission, let options = permission.sections?.first?.options {
            settings.append(SettingsSection(kind: .permission, title: permissionTitle, systemImage: "shield", options: options, selectedKey: permission.selectedKey))
        }
        for group in model.sections ?? [] {
            settings.append(SettingsSection(kind: .model, title: group.title ?? titles.model, systemImage: "cube", options: group.options, selectedKey: model.selectedKey))
        }
        if let effort, let options = effort.sections?.first?.options {
            settings.append(SettingsSection(kind: .effort, title: titles.effort, systemImage: "bolt", options: options, selectedKey: effort.selectedKey))
        }
        self.settings = settings
    }
}