import ExpoModulesCore
import Foundation

public class HappyManagedConfigurationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappyManagedConfiguration")

    // Synchronous, before server selection or analytics initialization. Do not
    // change endpoints underneath an active authenticated session: administrators
    // must restart the app after updating or removing its managed configuration.
    Constant("configuration") {
      let managed = UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed") ?? [:]
      return managed.filter { key, _ in
        key == "server_url" || key == "analytics_enabled"
      }
    }
  }
}
