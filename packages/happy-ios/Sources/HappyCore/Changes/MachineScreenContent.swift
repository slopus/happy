import Foundation
import HappyStore

/// The machine screen's rows and the record a rename starts from, from one
/// scoped machine snapshot. Equal when the screen would show the same thing.
public struct MachineScreenContent: Equatable, Sendable {
    /// Nil when the machine isn't there.
    public var model: MachineDetailsModel?
    /// The record without its heartbeat: a rename sends its metadata at its
    /// version.
    public var machine: MachineRecord?

    public init(_ snapshot: MachineDetailSnapshot) {
        guard let record = snapshot.machine else {
            model = nil
            machine = nil
            return
        }
        model = MachineDetailsModel(machine: record, sessions: snapshot.sessions)
        var machine = record
        machine.seq = 0
        machine.updatedAt = 0
        machine.activeAt = 0
        self.machine = machine
    }
}
