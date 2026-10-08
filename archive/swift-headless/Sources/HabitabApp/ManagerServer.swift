import Darwin
import Foundation
import HabitabCore

/// Unix domain socket server for launchers. The socket file is created with
/// owner-only permissions, and peers of other users are rejected.
final class ManagerServer: @unchecked Sendable {
    private var listenFD: Int32 = -1
    /// Called on the main queue.
    var onConnect: ((LauncherConnection) -> Void)?

    func start() throws {
        Paths.ensureHome()
        let path = Paths.socket.path
        // Refuse to start a second manager on the same socket.
        if let probe = IPCConnection.connect(to: path) {
            probe.close()
            throw NSError(domain: "Habitab", code: 1, userInfo: [NSLocalizedDescriptionKey: "Habitab is already running"])
        }
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0, var addr = IPCConnection.unixAddress(path) else {
            throw NSError(domain: "Habitab", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid socket path: \(path)"])
        }
        let old = umask(0o077)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        umask(old)
        guard rc == 0, listen(fd, 64) == 0 else {
            close(fd)
            throw NSError(domain: "Habitab", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cannot open socket"])
        }
        chmod(path, 0o600)
        listenFD = fd
        Thread.detachNewThread { [self] in acceptLoop() }
    }

    private func acceptLoop() {
        while true {
            let client = accept(listenFD, nil, nil)
            if client < 0 { if errno == EINTR { continue }; return }
            let conn = IPCConnection(fd: client)
            guard conn.peerUid == getuid() else { conn.close(); continue }
            let launcher = LauncherConnection(conn)
            DispatchQueue.main.async { self.onConnect?(launcher) }
        }
    }

    func stop() {
        if listenFD >= 0 { close(listenFD) }
        unlink(Paths.socket.path)
    }
}

/// One launcher connection. Messages arrive on the main queue.
final class LauncherConnection: @unchecked Sendable {
    let ipc: IPCConnection
    var onMessage: ((IPCMessage) -> Void)?
    var onClose: (() -> Void)?
    /// Serial queue: keeps message order and keeps writes off the main thread.
    private let queue = DispatchQueue(label: "habitab.launcher-connection")

    init(_ ipc: IPCConnection) {
        self.ipc = ipc
    }

    func start() {
        Thread.detachNewThread { [self] in
            while let msg = ipc.receive() {
                DispatchQueue.main.async { self.onMessage?(msg) }
            }
            DispatchQueue.main.async { self.onClose?() }
        }
    }

    func send(_ message: IPCMessage) {
        let ipc = self.ipc
        queue.async { ipc.send(message) }
    }

    func close() { ipc.close() }
}
