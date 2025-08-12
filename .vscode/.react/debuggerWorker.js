
// Initialize some variables before react-native code would access them
var onmessage=null, self=global;
// Cache Node's original require as __debug__.require
global.__debug__={require: require};
// Prevent leaking process.versions from debugger process to
// worker because pure React Native doesn't do that and some packages as js-md5 rely on this behavior
Object.defineProperty(process, "versions", {
    value: undefined
});
// TODO: Replace by url.fileURLToPath method when Node 10 LTS become deprecated
function fileUrlToPath(url) {
  if (process.platform === 'win32') {
      return url.toString().replace('file:///', '');
  } else {
    return url.toString().replace('file://', '');
  }
}
function getNativeModules() {
    var NativeModules;
    try {
        // This approach is for old RN versions
        NativeModules = global.require('NativeModules');
    } catch (err) {
        // ignore error and try another way for more recent RN versions
        try {
            var nativeModuleId;
            var modules = global.__r.getModules();
            var ids = Object.keys(modules);
            for (var i = 0; i < ids.length; i++) {
              if (modules[ids[i]].verboseName) {
                 var packagePath = new String(modules[ids[i]].verboseName);
                 if (packagePath.indexOf('Libraries/BatchedBridge/NativeModules.js') > 0 || packagePath.indexOf('Libraries\\BatchedBridge\\NativeModules.js') > 0) {
                   nativeModuleId = parseInt(ids[i], 10);
                   break;
                 }
              }
            }
          if (nativeModuleId) {
            NativeModules = global.__r(nativeModuleId);
          }
        }
        catch (err) {
            // suppress errors
        }
    }
    return NativeModules;
}
// Originally, this was made for iOS only
var vscodeHandlers = {
    'vscode_reloadApp': function () {
        var NativeModules = getNativeModules();
        if (NativeModules && NativeModules.DevSettings) {
            NativeModules.DevSettings.reload();
        }
    },
    'vscode_showDevMenu': function () {
        var NativeModules = getNativeModules();
        if (NativeModules && NativeModules.DevMenu) {
            NativeModules.DevMenu.show();
        }
    }
};
process.on("message", function (message) {
    if (message.data && vscodeHandlers[message.data.method]) {
        vscodeHandlers[message.data.method]();
    } else if(onmessage) {
        onmessage(message);
    }
});
var postMessage = function(message){
    process.send(message);
};
if (!self.postMessage) {
    self.postMessage = postMessage;
}
var importScripts = (function(){
    var fs=require('fs'), vm=require('vm');
    return function(scriptUrl){
        scriptUrl = fileUrlToPath(scriptUrl);
        var scriptCode = fs.readFileSync(scriptUrl, 'utf8');
        // Add a 'debugger;' statement to stop code execution
        // to wait for the sourcemaps to be processed by the debug adapter
        vm.runInThisContext('debugger;' + scriptCode, {filename: scriptUrl});
    };
})();

// Worker is ran as nodejs process, so console.trace() writes to stderr and it leads to error in native app
// To avoid this console.trace() is overridden to print stacktrace via console.log()
// Please, see Node JS implementation: https://github.com/nodejs/node/blob/master/lib/internal/console/constructor.js
console.trace = (function() {
    return function() {
        try {
            var err = {
                name: 'Trace',
                message: require('util').format.apply(null, arguments)
                };
            // Node uses 10, but usually it's not enough for RN app trace
            Error.stackTraceLimit = 30;
            Error.captureStackTrace(err, console.trace);
            console.log(err.stack);
        } catch (e) {
            console.error(e);
        }
    };
})();

// As worker is ran in node, it breaks broadcast-channels package approach of identifying if it’s ran in node:
// https://github.com/pubkey/broadcast-channel/blob/master/src/util.js#L64
// To avoid it if process.toString() is called if will return empty string instead of [object process].
var nativeObjectToString = Object.prototype.toString;
Object.prototype.toString = function() {
    if (this === process) {
        return '';
    } else {
        return nativeObjectToString.call(this);
    }
};


<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
    <title>Happy (dev)</title>
    <!-- The `react-native-web` recommended style reset: https://necolas.github.io/react-native-web/docs/setup/#root-element -->
    <style id="expo-reset">
      /* These styles make the body full-height */
      html,
      body {
        height: 100%;
      }
      /* These styles disable body scrolling if you are using <ScrollView> */
      body {
        overflow: hidden;
      }
      /* These styles make the root element full-height */
      #root {
        display: flex;
        height: 100%;
        flex: 1;
      }
    </style>
  </head>

  <body>
    <!-- Use static rendering with Expo Router to support running without JavaScript. -->
    <noscript>
      You need to enable JavaScript to run this app.
    </noscript>
    <!-- The root element for your Expo app. -->
    <div id="root"></div>
  <script src="/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=.%2Fsources%2Fapp&unstable_transformProfile=hermes-stable" defer></script></body>
</html>

// Notify debugger that we're done with loading
// and started listening for IPC messages
postMessage({workerLoaded:true});