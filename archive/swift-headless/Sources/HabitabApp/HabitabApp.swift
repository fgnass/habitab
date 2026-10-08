import AppKit
import HabitabCore
import SwiftUI

@main
struct HabitabApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        Window("Habitab", id: "main") {
            ContentView()
                .environmentObject(delegate.store)
                .environmentObject(delegate.setup)
                .frame(minWidth: 900, minHeight: 560)
        }
        .defaultSize(width: 1400, height: 900)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Setup …") { delegate.openSetup() }
                    .keyboardShortcut(",", modifiers: [.command, .shift])
            }
        }

        Window("Setup", id: "setup") {
            SetupView()
                .environmentObject(delegate.setup)
                .frame(minWidth: 760, minHeight: 520)
        }
        .defaultSize(width: 900, height: 680)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store()
    let setup = SetupModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.open("app")
        Paths.ensureHome()
        // Launchers start the app from this path when a browser is needed.
        try? Bundle.main.bundlePath.write(to: Paths.appPathFile, atomically: true, encoding: .utf8)
        installBundledLauncher()
        store.start()
        if store.alreadyRunning {
            // Another Habitab owns the socket: bring it forward and quit.
            let me = NSRunningApplication.current
            NSRunningApplication.runningApplications(withBundleIdentifier: Paths.bundleIdentifier)
                .first { $0 != me }?.activate()
            NSApp.terminate(nil)
            return
        }
        setup.refresh()
        NSApp.setActivationPolicy(.regular)
        InputSelfTest.runIfRequested()
    }

    func applicationWillTerminate(_ notification: Notification) {
        store.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Keeps the stable launcher copy in sync with the app bundle.
    private func installBundledLauncher() {
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/habitab").path
        guard FileManager.default.isExecutableFile(atPath: bundled) else { return }
        do { try Installer.installLauncher(from: bundled) } catch { Log.write("launcher install failed: \(error)") }
    }

    func openSetup() {
        NSApp.activate(ignoringOtherApps: true)
        NotificationCenter.default.post(name: .openSetup, object: nil)
    }
}

extension Notification.Name {
    static let openSetup = Notification.Name("habitab.openSetup")
}
