extension LocalStore {
    /// Called on the presence actor together with removal of its cached state.
    public func clearSessionPresenceOverlay(id: String) { presenceOverlay.removeSessions([id]) }
    public func clearMachinePresenceOverlay(id: String) { presenceOverlay.removeMachines([id]) }
}