import Darwin
import Foundation
import HabitabCore

/// Connection from a launcher to the manager app. The launcher works without
/// it; the link reconnects in the background, for example after the app
/// restarts, and sends the current state again.
final class ManagerLink: @unchecked Sendable {
    private unowned let launcher: Launcher
    private let lock = NSLock()
    private var connection: IPCConnection?
    private var keepWaiter: ((Bool) -> Void)?
    private var closed = false
    private var lastWake = Date.distantPast

    init(launcher: Launcher) {
        self.launcher = launcher
    }

    func start() {
        Thread.detachNewThread { [self] in loop() }
    }

    private func loop() {
        var delay: UInt32 = 1
        while true {
            lock.lock(); let isClosed = closed; lock.unlock()
            if isClosed { return }
            if let conn = IPCConnection.connect(to: Paths.socket.path) {
                lock.lock(); connection = conn; lock.unlock()
                delay = 1
                sendHello(conn)
                while let msg = conn.receive() { handle(msg) }
                lock.lock()
                connection = nil
                let waiter = keepWaiter
                keepWaiter = nil
                lock.unlock()
                waiter?(false)
                conn.close()
            }
            sleep(delay)
            delay = min(delay * 2, 5)
        }
    }

    private func sendHello(_ conn: IPCConnection) {
        var hello = IPCMessage(type: IPCType.hello)
        hello.sessionId = launcher.session
        hello.launcherIdentity = launcher.owner
        hello.launcherPid = getpid()
        hello.meta = launcher.snapshotMeta()
        conn.send(hello)
        conn.send(launcher.currentBrowserMessage())
    }

    private func handle(_ msg: IPCMessage) {
        switch msg.type {
        case IPCType.handoff:
            lock.lock(); let waiter = keepWaiter; keepWaiter = nil; lock.unlock()
            waiter?(msg.keep ?? false)
        case IPCType.hold:
            launcher.setHold(msg.hold ?? false)
        case IPCType.stopBrowser:
            Thread.detachNewThread { [launcher] in
                launcher.browser.stop(removeProfile: false, reason: msg.reason ?? "quit in Habitab")
            }
        case IPCType.protect:
            launcher.protect(for: TimeInterval(msg.durationMs ?? 300_000) / 1000)
        case IPCType.touch:
            launcher.touch()
        default:
            break
        }
    }

    func send(_ message: IPCMessage) {
        lock.lock(); let conn = connection; lock.unlock()
        conn?.send(message)
    }

    func sendMeta() {
        var m = IPCMessage(type: IPCType.meta)
        m.meta = launcher.snapshotMeta()
        send(m)
    }

    /// Asks the manager whether it adopts the browser. False without answer.
    func askKeep(timeout: TimeInterval) -> Bool {
        lock.lock()
        guard let conn = connection else { lock.unlock(); return false }
        let sem = DispatchSemaphore(value: 0)
        var keep = false
        keepWaiter = { keep = $0; sem.signal() }
        lock.unlock()
        var m = launcher.currentBrowserMessage()
        m.type = IPCType.ending
        m.protectedReason = launcher.protectionReason()
        conn.send(m)
        if sem.wait(timeout: .now() + timeout) == .timedOut {
            lock.lock(); keepWaiter = nil; lock.unlock()
            return false
        }
        return keep
    }

    /// Starts the manager app in the background when a browser is needed and
    /// the app is not running. Missing app is not an error.
    func wakeApp() {
        lock.lock()
        let connected = connection != nil
        let recently = Date().timeIntervalSince(lastWake) < 60
        if !connected && !recently { lastWake = Date() }
        lock.unlock()
        guard !connected, !recently, ProcessInfo.processInfo.environment["HABITAB_NO_APP_LAUNCH"] != "1" else { return }
        guard let path = try? String(contentsOf: Paths.appPathFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
              FileManager.default.fileExists(atPath: path) else { return }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-g", "-j", path]
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
        Log.write("woke manager app at \(path)")
    }

    func close() {
        lock.lock()
        closed = true
        let conn = connection
        lock.unlock()
        conn?.close()
    }
}
