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

    // The picture's menu on a Happy Cloud server: the server's own name and picture.
    enum ServerName {
        static let title = "Server Name"
        static let message = "Everyone on this server sees this name."
        static let save = "Save"
        static let couldNotSave = "Could not rename the server"
        static let couldNotChangePicture = "Could not change the server’s picture"
    }
}
