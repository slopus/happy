import ExpoModulesCore
import Tailcat

public final class ExpoTailcatModule: Module {
  private let manager = TailcatMobileNewManager()!

  public func definition() -> ModuleDefinition {
    Name("ExpoTailcat")
    Events("onTunnelsClosed")

    AsyncFunction("openTunnel") { (options: String) throws -> String in
      return try self.manager.openTunnel(options)
    }.runOnQueue(.global(qos: .userInitiated))

    AsyncFunction("closeTunnel") { (id: String) in
      self.manager.closeTunnel(id)
    }.runOnQueue(.global(qos: .userInitiated))

    AsyncFunction("closeAllTunnels") {
      self.manager.closeAll()
    }.runOnQueue(.global(qos: .userInitiated))

    OnAppEntersBackground {
      self.manager.closeAll()
      self.sendEvent("onTunnelsClosed", ["reason": "background"])
    }

    OnDestroy {
      self.manager.close()
    }
  }
}