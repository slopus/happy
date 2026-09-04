const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    applyExpoCameraScannerTransitionPatch,
} = require('./fix-expo-camera-scanner-transitions.cjs');

const unpatchedCameraModule = `struct ScannerContext {
  var controller: Any?
  var delegate: Any?
}

    AsyncFunction("launchScanner") { (options: VisionScannerOptions?) in
      if #available(iOS 16.0, *) {
        try await MainActor.run {
          guard DataScannerViewController.isSupported, DataScannerViewController.isAvailable else {
            throw CameraScannerUnavailableException()
          }
          let delegate = VisionScannerDelegate(handler: self)
          scannerContext = ScannerContext(delegate: delegate)
          launchScanner(with: options)
        }
      }
    }

    AsyncFunction("dismissScanner") {
      if #available(iOS 16.0, *) {
        await MainActor.run {
          dismissScanner()
        }
      }
    }

  @available(iOS 16.0, *)
  @MainActor
  private func launchScanner(with options: VisionScannerOptions?) {
    let symbologies = options?.toSymbology() ?? []
    let controller = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: symbologies)],
      isPinchToZoomEnabled: options?.isPinchToZoomEnabled ?? true,
      isGuidanceEnabled: options?.isGuidanceEnabled ?? true,
      isHighlightingEnabled: options?.isHighlightingEnabled ?? false
    )

    scannerContext?.controller = controller
    if let delegate = scannerContext?.delegate as? VisionScannerDelegate {
      controller.delegate = delegate
    }

    appContext?.utilities?.currentViewController()?.present(controller, animated: true) {
      try? controller.startScanning()
    }
  }

  @available(iOS 16.0, *)
  @MainActor
  private func dismissScanner() {
    guard let controller = scannerContext?.controller as? DataScannerViewController else {
      return
    }
    controller.stopScanning()
    controller.dismiss(animated: true)
  }
`;

function extractScannerModuleFunctions(source) {
    const start = source.indexOf('    AsyncFunction("launchScanner")');
    const end = source.indexOf('\n\n  @available(iOS 16.0, *)', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    return source.slice(start, end);
}

const originalModuleFunctions = extractScannerModuleFunctions(unpatchedCameraModule);

function downgradeToPreviousDismissalSafePatch(latestPatch) {
    const launchStart = latestPatch.indexOf('private func launchScanner(with options: VisionScannerOptions?) async throws');
    const dismissStart = latestPatch.indexOf('private func dismissScanner() async throws');
    const latestLaunch = latestPatch.slice(launchStart, dismissStart);
    const previousLaunch = latestLaunch
        .replace(
            `        guard controller.presentingViewController == nil else {
          return
        }
        self.clearScannerContext(for: controller)
      }

      currentViewController.present`,
            `        self.clearScannerContext(for: controller)
      }

      currentViewController.present`,
        )
        .replace(
            `          guard controller.presentingViewController == nil else {
            return
          }
          self.clearScannerContext(for: controller)
          return
        }
        guard controller.presentingViewController != nil else`,
            `          self.clearScannerContext(for: controller)
          return
        }
        guard controller.presentingViewController != nil else`,
        )
        .replace(
            `            guard controller.presentingViewController == nil else {
              return
            }
            self.clearScannerContext(for: controller)
            return
          }
        } catch`,
            `            self.clearScannerContext(for: controller)
            return
          }
        } catch`,
        )
        .replace(
            `          controller.dismiss(animated: true) { [weak self, weak controller] in
            guard let self, let controller else {
              transition.reject(error)
              return
            }
            guard controller.presentingViewController == nil else {
              transition.reject(error)
              return
            }
            self.clearScannerContext(for: controller)
            transition.reject(error)
          }`,
            `          controller.dismiss(animated: true) { [weak self, weak controller] in
            if let self, let controller {
              self.clearScannerContext(for: controller)
            }
            transition.reject(error)
          }`,
        );

    assert.notEqual(launchStart, -1);
    assert.notEqual(dismissStart, -1);
    assert.notEqual(previousLaunch, latestLaunch);
    return latestPatch.replace(latestLaunch, previousLaunch);
}

function writeExpoCameraInstallation(
    repositoryRoot,
    { nodeModulesPath = 'node_modules', source = unpatchedCameraModule, version = '55.0.10' } = {},
) {
    const packageRoot = path.join(repositoryRoot, nodeModulesPath, 'expo-camera');
    const sourcePath = path.join(packageRoot, 'ios', 'CameraViewModule.swift');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(sourcePath, source);
    return sourcePath;
}

function createExpoCameraFixture(t, options = {}) {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paws-expo-camera-patch-'));
    const sourcePath = writeExpoCameraInstallation(repositoryRoot, options);
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    return { repositoryRoot, sourcePath };
}

test('makes Expo Camera scanner promises settle from UIKit transition completions', (t) => {
    const fixture = createExpoCameraFixture(t);

    const result = applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });
    const patched = fs.readFileSync(fixture.sourcePath, 'utf8');

    assert.deepEqual(result, { found: 1, patched: 1 });
    assert.match(patched, /try await launchScanner\(with: options\)/);
    assert.match(patched, /try await dismissScanner\(\)/);
    assert.match(patched, /private func launchScanner\(with options: VisionScannerOptions\?\) async throws/);
    assert.match(patched, /private final class ScannerTransitionCoordinator/);
    assert.match(patched, /guard let continuation else \{\s+return false\s+\}\s+self\.continuation = nil/);
    assert.match(patched, /watchdog\?\.cancel\(\)/);
    assert.match(patched, /guard let currentViewController = appContext\?\.utilities\?\.currentViewController\(\),\s+currentViewController\.viewIfLoaded\?\.window != nil,\s+!currentViewController\.isBeingPresented,\s+!currentViewController\.isBeingDismissed,\s+currentViewController\.transitionCoordinator == nil,\s+currentViewController\.presentedViewController == nil else/);
    assert.match(patched, /currentViewController\.present\(controller, animated: true\)/);
    assert.match(patched, /guard controller\.presentingViewController != nil else \{\s+clearScannerContext\(for: controller\)\s+transition\.reject\(InitScannerFailed\(\)\)/);
    assert.match(patched, /transition\.armWatchdog/);
    assert.match(patched, /guard transition\.isPending else \{\s+controller\.stopScanning\(\)/);
    assert.match(patched, /try controller\.startScanning\(\)\s+guard transition\.resolve\(\) else/);
    assert.match(patched, /controller\.dismiss\(animated: true\) \{[\s\S]*transition\.reject\(error\)/);
    assert.match(patched, /private func dismissScanner\(\) async throws/);
    assert.doesNotMatch(patched, /try\? await withCheckedThrowingContinuation/);
    assert.match(patched, /guard controller\.presentingViewController == nil else \{\s+transition\.reject\(InitScannerFailed\(\)\)\s+return\s+\}\s+self\.clearScannerContext\(for: controller\)\s+transition\.resolve\(\)/);
    assert.match(patched, /controller\.dismiss\(animated: true\) \{[\s\S]*transition\.resolve\(\)/);
    assert.doesNotMatch(patched, /try\? controller\.startScanning\(\)/);
    assert.equal((patched.match(/continuation\.resume/g) ?? []).length, 2);
});

test('uses a rejecting watchdog when a UIKit presenter omits its completion callback', (t) => {
    const fixture = createExpoCameraFixture(t);
    applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });
    const patched = fs.readFileSync(fixture.sourcePath, 'utf8');

    assert.match(patched, /Task \{ @MainActor \[self\] in\s+try\? await Task\.sleep\(nanoseconds: timeout\)/);
    assert.match(patched, /guard !Task\.isCancelled, self\.isPending else \{\s+return\s+\}\s+guard self\.reject\(InitScannerFailed\(\)\) else \{\s+return\s+\}\s+onTimeout\(\)/);
    assert.match(patched, /transition\.armWatchdog \{ \[weak self, weak controller\] in[\s\S]*controller\.dismiss\(animated: false\)[\s\S]*guard controller\.presentingViewController == nil else \{\s+return\s+\}\s+self\.clearScannerContext\(for: controller\)/);
});

test('retains launch scanner ownership when compensating dismissal remains attached', (t) => {
    const fixture = createExpoCameraFixture(t);
    applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });
    const patched = fs.readFileSync(fixture.sourcePath, 'utf8');
    const launchStart = patched.indexOf('private func launchScanner(with options: VisionScannerOptions?) async throws');
    const dismissStart = patched.indexOf('private func dismissScanner() async throws');
    const launchFunction = patched.slice(launchStart, dismissStart);

    assert.notEqual(launchStart, -1);
    assert.notEqual(dismissStart, -1);
    assert.match(launchFunction, /transition\.armWatchdog \{ \[weak self, weak controller\] in[\s\S]*controller\.dismiss\(animated: false\)\s+}\s+guard controller\.presentingViewController == nil else \{\s+return\s+}\s+self\.clearScannerContext\(for: controller\)/);
    assert.match(launchFunction, /guard transition\.isPending else \{[\s\S]*controller\.dismiss\(animated: false\)\s+}\s+guard controller\.presentingViewController == nil else \{\s+return\s+}\s+self\.clearScannerContext\(for: controller\)/);
    assert.match(launchFunction, /guard transition\.resolve\(\) else \{[\s\S]*controller\.dismiss\(animated: false\)\s+}\s+guard controller\.presentingViewController == nil else \{\s+return\s+}\s+self\.clearScannerContext\(for: controller\)/);
    assert.match(launchFunction, /controller\.dismiss\(animated: true\) \{ \[weak self, weak controller\] in\s+guard let self, let controller else \{[\s\S]*guard controller\.presentingViewController == nil else \{\s+transition\.reject\(error\)\s+return\s+}\s+self\.clearScannerContext\(for: controller\)\s+transition\.reject\(error\)/);
});

test('fails closed when patched and previous module registrations coexist', (t) => {
    const fixture = createExpoCameraFixture(t);
    applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });
    const latestPatch = fs.readFileSync(fixture.sourcePath, 'utf8');
    const patchedModuleFunctions = extractScannerModuleFunctions(latestPatch);
    const duplicatedSource = latestPatch.replace(
        patchedModuleFunctions,
        `${originalModuleFunctions}\n\n${patchedModuleFunctions}`,
    );
    fs.writeFileSync(fixture.sourcePath, duplicatedSource);

    assert.throws(
        () => applyExpoCameraScannerTransitionPatch({
            repositoryRoot: fixture.repositoryRoot,
            log: null,
            warn: null,
        }),
        /source does not match the expected scanner transition implementation/,
    );
    assert.equal(fs.readFileSync(fixture.sourcePath, 'utf8'), duplicatedSource);
});

test('fails closed when scanner support, module, and private fragments form an unknown mix', (t) => {
    const fixture = createExpoCameraFixture(t);
    applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });
    const latestPatch = fs.readFileSync(fixture.sourcePath, 'utf8');
    const patchedModuleFunctions = extractScannerModuleFunctions(latestPatch);
    const mixedSource = unpatchedCameraModule.replace(originalModuleFunctions, patchedModuleFunctions);
    fs.writeFileSync(fixture.sourcePath, mixedSource);

    assert.throws(
        () => applyExpoCameraScannerTransitionPatch({
            repositoryRoot: fixture.repositoryRoot,
            log: null,
            warn: null,
        }),
        /source does not match the expected scanner transition implementation/,
    );
    assert.equal(fs.readFileSync(fixture.sourcePath, 'utf8'), mixedSource);
});

test('is idempotent after Expo Camera has already been patched', (t) => {
    const fixture = createExpoCameraFixture(t);
    applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });
    const once = fs.readFileSync(fixture.sourcePath, 'utf8');

    const result = applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });

    assert.deepEqual(result, { found: 1, patched: 0 });
    assert.equal(fs.readFileSync(fixture.sourcePath, 'utf8'), once);
});

test('upgrades the previous watchdog implementation without accepting other drift', (t) => {
    const fixture = createExpoCameraFixture(t);
    applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });
    const previousPatch = downgradeToPreviousDismissalSafePatch(
        fs.readFileSync(fixture.sourcePath, 'utf8'),
    )
        .replace('Task { @MainActor [self] in', 'Task { @MainActor [weak self] in')
        .replace('guard !Task.isCancelled, self.isPending else {', 'guard !Task.isCancelled, let self, self.isPending else {');
    fs.writeFileSync(fixture.sourcePath, previousPatch);

    const result = applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });
    const upgraded = fs.readFileSync(fixture.sourcePath, 'utf8');

    assert.deepEqual(result, { found: 1, patched: 1 });
    assert.match(upgraded, /Task \{ @MainActor \[self\] in/);
    assert.doesNotMatch(upgraded, /\[weak self\]/);
});

test('upgrades the previous dismissal-safe implementation', (t) => {
    const fixture = createExpoCameraFixture(t);
    applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });
    const latestPatch = fs.readFileSync(fixture.sourcePath, 'utf8');
    const previousPatch = downgradeToPreviousDismissalSafePatch(latestPatch);
    assert.notEqual(previousPatch, latestPatch);
    fs.writeFileSync(fixture.sourcePath, previousPatch);

    const result = applyExpoCameraScannerTransitionPatch({
        repositoryRoot: fixture.repositoryRoot,
        log: null,
        warn: null,
    });

    assert.deepEqual(result, { found: 1, patched: 1 });
    assert.equal(fs.readFileSync(fixture.sourcePath, 'utf8'), latestPatch);
});

test('fails closed without modifying files when the installed Expo Camera source drifts', (t) => {
    const driftedSource = unpatchedCameraModule.replace(
        'private func dismissScanner() {',
        'private func dismissScanner(animated: Bool) {',
    );
    const fixture = createExpoCameraFixture(t, { source: driftedSource });

    assert.throws(
        () => applyExpoCameraScannerTransitionPatch({
            repositoryRoot: fixture.repositoryRoot,
            log: null,
            warn: null,
        }),
        /Expo Camera 55\.0\.10 source does not match the expected scanner transition implementation/,
    );
    assert.equal(fs.readFileSync(fixture.sourcePath, 'utf8'), driftedSource);
});

test('fails closed for an unverified Expo Camera version', (t) => {
    const fixture = createExpoCameraFixture(t, { version: '55.0.11' });

    assert.throws(
        () => applyExpoCameraScannerTransitionPatch({
            repositoryRoot: fixture.repositoryRoot,
            log: null,
            warn: null,
        }),
        /supports expo-camera 55\.0\.10, found 55\.0\.11/,
    );
    assert.equal(fs.readFileSync(fixture.sourcePath, 'utf8'), unpatchedCameraModule);
});

test('validates every Expo Camera installation before writing either one', (t) => {
    const fixture = createExpoCameraFixture(t);
    const appSource = unpatchedCameraModule.replace(
        'private func dismissScanner() {',
        'private func dismissScanner(animated: Bool) {',
    );
    const appSourcePath = writeExpoCameraInstallation(fixture.repositoryRoot, {
        nodeModulesPath: path.join('packages', 'happy-app', 'node_modules'),
        source: appSource,
    });

    assert.throws(
        () => applyExpoCameraScannerTransitionPatch({
            repositoryRoot: fixture.repositoryRoot,
            log: null,
            warn: null,
        }),
        /Expo Camera 55\.0\.10 source does not match the expected scanner transition implementation/,
    );
    assert.equal(fs.readFileSync(fixture.sourcePath, 'utf8'), unpatchedCameraModule);
    assert.equal(fs.readFileSync(appSourcePath, 'utf8'), appSource);
});
