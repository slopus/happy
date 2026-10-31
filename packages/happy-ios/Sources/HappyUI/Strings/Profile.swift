import Foundation
import HappyCore

// The person's own profile on a computer, and the two rows that ask the
// agent to change its own name or picture. English only, as the rest of V2 is.
extension Strings {
    enum Profile {
        /// happy-app's `settingsAccount.profile` and `.name`.
        static let title = "Profile"
        static let name = "Name"
        static let changePhoto = "Change Photo"
        static let removePhoto = "Remove Photo"
        static let couldNotSave = "Could not save your profile"
        static let couldNotChangePhoto = "Could not change your photo"
        static let couldNotRemovePhoto = "Could not remove your photo"
    }

    static let changeAgentName = "Change agent name"
    static let changeAgentAvatar = "Change agent avatar"

    // The menu on the agent's picture, on its connection's Settings.
    enum AgentMenu {
        static let button = "Edit agent"
        static let changeAvatar = "Change avatar"
        static let editName = "Edit name"
    }
}
