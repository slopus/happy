package expo.modules.tailcat

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import mobile.Mobile
import org.json.JSONArray
import org.json.JSONObject
import java.net.NetworkInterface
import java.util.Collections
import java.util.concurrent.Executors

class ExpoTailcatModule : Module() {
  private val manager = Mobile.newManager()
  private val workers = Executors.newCachedThreadPool()
  private var connectivity: ConnectivityManager? = null
  private var callback: ConnectivityManager.NetworkCallback? = null
  private val snapshotLock = Any()
  private var lastSnapshot: String? = null
  private var lastNetwork: Network? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoTailcat")
    Events("onTunnelsClosed")

    OnCreate {
      refreshInterfaces()
      val context = appContext.reactContext?.applicationContext
      connectivity = context?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
      lastNetwork = connectivity?.activeNetwork
      callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = networkChanged(network)
        override fun onLost(network: Network) = networkChanged(null)
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) = networkChanged(network)
      }
      callback?.let { connectivity?.registerDefaultNetworkCallback(it) }
    }

    // Open and close must not share a serial queue: close-all cancels pending opens.
    AsyncFunction("openTunnel") { options: String, promise: Promise ->
      execute(promise) { refreshInterfaces(); manager.openTunnel(options) }
    }
    AsyncFunction("closeTunnel") { id: String, promise: Promise ->
      execute(promise) { manager.closeTunnel(id); null }
    }
    AsyncFunction("closeAllTunnels") { promise: Promise ->
      execute(promise) { manager.closeAll(); null }
    }

    OnActivityEntersBackground {
      manager.closeAll()
      sendEvent("onTunnelsClosed", mapOf("reason" to "background"))
    }
    OnActivityEntersForeground { refreshInterfaces() }
    OnDestroy {
      callback?.let { connectivity?.unregisterNetworkCallback(it) }
      callback = null
      manager.close()
      workers.shutdown()
    }
  }

  private fun execute(promise: Promise, operation: () -> Any?) {
    workers.execute {
      try { promise.resolve(operation()) }
      catch (error: Exception) { promise.reject("ERR_TAILCAT", error.message ?: "Tailcat operation failed", error) }
    }
  }

  private fun networkChanged(network: Network?) {
    val changed = synchronized(snapshotLock) {
      val interfacesChanged = refreshInterfaces()
      val changed = interfacesChanged || lastNetwork != network
      lastNetwork = network
      changed
    }
    if (changed) {
      // Tailcat does not expose its internal netmon.InjectEvent. Invalidate
      // promptly instead of relying on Android's ten-minute Go polling interval.
      manager.closeAll()
      sendEvent("onTunnelsClosed", mapOf("reason" to "networkChanged"))
    }
  }

  private fun refreshInterfaces(): Boolean = synchronized(snapshotLock) {
    val snapshot = JSONArray()
    val interfaces = NetworkInterface.getNetworkInterfaces()
    if (interfaces != null) {
      for (iface in Collections.list(interfaces).sortedBy { it.index }) {
        val addresses = JSONArray()
        for (address in iface.interfaceAddresses) {
          val host = address.address?.hostAddress?.substringBefore('%') ?: continue
          addresses.put("$host/${address.networkPrefixLength}")
        }
        snapshot.put(JSONObject().apply {
          put("name", iface.name)
          put("index", iface.index)
          put("mtu", iface.mtu)
          put("up", iface.isUp)
          put("loopback", iface.isLoopback)
          put("multicast", iface.supportsMulticast())
          put("addresses", addresses)
        })
      }
    }
    val json = snapshot.toString()
    val changed = lastSnapshot != null && lastSnapshot != json
    Mobile.setInterfaces(json)
    lastSnapshot = json
    changed
  }
}