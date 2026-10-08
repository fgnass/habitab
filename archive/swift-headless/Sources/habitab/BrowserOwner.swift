import Darwin
import Foundation
import HabitabCore

/// Owns the Chrome instance of one launcher. Chrome starts on the first
/// DevTools connection, can rest after idle time and starts again on demand.
/// The profile stays for the lifetime of the session.
final class BrowserOwner: @unchecked Sendable {
    let session: String
    let owner: String
    let options: LaunchOptions
    private let lock = NSLock()
    private var instance: Chrome.Instance?
    private(set) var lastError: String?
    /// Called with ("running"|"resting"|"stopped"|"failed", instance, detail).
    var onState: ((String, Chrome.Instance?, String?) -> Void)?
    var onFirstLaunch: (() -> Void)?
    private var launchedOnce = false

    init(session: String, owner: String, options: LaunchOptions) {
        self.session = session
        self.owner = owner
        self.options = options
    }

    var current: Chrome.Instance? {
        lock.lock(); defer { lock.unlock() }
        return instance
    }

    func ensure() -> Chrome.Instance? {
        lock.lock(); defer { lock.unlock() }
        if let inst = instance, Proc.isAlive(pid: inst.pid) { return inst }
        instance = nil
        if !launchedOnce { launchedOnce = true; onFirstLaunch?() }
        do {
            let inst = try Chrome.launch(session: session, options: options, owner: owner)
            Reaper.writeOwner(owner, profile: inst.profile)
            instance = inst
            lastError = nil
            watch(inst)
            onState?("running", inst, nil)
            return inst
        } catch {
            lastError = "\(error)"
            Log.write("chrome launch failed: \(error)")
            onState?("failed", nil, "\(error)")
            return nil
        }
    }

    private func watch(_ inst: Chrome.Instance) {
        Thread.detachNewThread { [weak self] in
            var status: Int32 = 0
            while waitpid(inst.pid, &status, 0) < 0 && errno == EINTR {}
            guard let self else { return }
            self.lock.lock()
            let wasCurrent = self.instance?.pid == inst.pid
            if wasCurrent { self.instance = nil }
            self.lock.unlock()
            if wasCurrent {
                Log.write("chrome pid=\(inst.pid) exited status=\(status)")
                self.onState?("stopped", nil, "Chrome exited")
            }
        }
    }

    /// Closes the browser. With `removeProfile` the session data is deleted.
    func stop(removeProfile: Bool, reason: String) {
        lock.lock()
        let inst = instance
        instance = nil
        lock.unlock()
        if let inst {
            Log.write("stopping chrome pid=\(inst.pid): \(reason)")
            // Browser.close lets Chrome shut down cleanly; signals are the fallback.
            if let url = URL(string: inst.webSocketURL) {
                let cdp = CDPClient(url: url)
                if cdp.connectSync(timeout: 1) {
                    cdp.send("Browser.close")
                    let deadline = Date().addingTimeInterval(2)
                    while Date() < deadline && Proc.isAlive(pid: inst.pid) { usleep(50_000) }
                    cdp.close()
                }
            }
            if Proc.isAlive(pid: inst.pid) { Proc.terminate(inst.pid, grace: 2) }
        }
        onState?(removeProfile ? "stopped" : "resting", nil, reason)
        if removeProfile { Reaper.removeProfile(Paths.profileDir(session: session)) }
    }
}
