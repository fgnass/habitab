import Darwin
import Foundation
import HabitabCore

/// WebSocket relay for the DevTools frontend.
///
/// Chrome rejects DevTools WebSockets that carry an Origin header unless
/// `--remote-allow-origins` lists it, and WebKit always sends one. Allowing
/// all origins would let any website reach the debugging port. Instead the
/// frontend connects here: the path must contain a random token, the target
/// port must belong to a Habitab browser, and only then the Origin header is
/// removed and the connection is passed to Chrome. Binds 127.0.0.1 only.
final class DevToolsProxy: @unchecked Sendable {
    static let shared = DevToolsProxy()

    private(set) var port = 0
    let token: String = (0..<24).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    private var listenFD: Int32 = -1
    private let lock = NSLock()
    private var allowedPorts = Set<Int>()

    func allow(_ port: Int) {
        lock.lock(); allowedPorts.insert(port); lock.unlock()
    }

    /// URL of the frontend (served by Chrome) wired to this relay.
    func frontendURL(chromePort: Int, targetId: String) -> URL? {
        guard start() else { return nil }
        allow(chromePort)
        return URL(string: "http://127.0.0.1:\(chromePort)/devtools/inspector.html?ws=127.0.0.1:\(port)/\(token)/\(chromePort)/devtools/page/\(targetId)")
    }

    private func start() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if listenFD >= 0 { return true }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        } == 0 && listen(fd, 16) == 0
        guard ok else { close(fd); return false }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        port = Int(UInt16(bigEndian: addr.sin_port))
        listenFD = fd
        Thread.detachNewThread { [self] in
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { if errno == EINTR { continue }; return }
                Thread.detachNewThread { [self] in handle(c) }
            }
        }
        return true
    }

    private func handle(_ client: Int32) {
        var on: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        // Read the HTTP upgrade request head.
        var head = Data()
        var byte = [UInt8](repeating: 0, count: 4096)
        while head.count < 16_384, head.range(of: Data("\r\n\r\n".utf8)) == nil {
            let n = read(client, &byte, byte.count)
            if n <= 0 { close(client); return }
            head.append(contentsOf: byte[0..<n])
        }
        guard let end = head.range(of: Data("\r\n\r\n".utf8)),
              let text = String(data: head[..<end.lowerBound], encoding: .utf8) else { close(client); return }
        let rest = head[end.upperBound...]
        var lines = text.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ")
        guard parts.count == 3, parts[0] == "GET" else { close(client); return }
        let pathParts = parts[1].split(separator: "/", maxSplits: 2).map(String.init)
        lock.lock(); let allowed = allowedPorts; lock.unlock()
        guard pathParts.count == 3, pathParts[0] == token, let chromePort = Int(pathParts[1]), allowed.contains(chromePort),
              pathParts[2].hasPrefix("devtools/") else {
            Log.write("devtools proxy: rejected request")
            close(client); return
        }
        lines[0] = "GET /\(pathParts[2]) HTTP/1.1"
        lines = lines.filter { !$0.lowercased().hasPrefix("origin:") }
            .map { $0.lowercased().hasPrefix("host:") ? "Host: 127.0.0.1:\(chromePort)" : $0 }
        guard let upstream = Self.connect(chromePort) else { close(client); return }
        var out = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
        out.append(rest)
        writeAll(upstream, out)
        let group = DispatchGroup()
        group.enter(); group.enter()
        Thread.detachNewThread { Self.pipe(client, upstream); group.leave() }
        Thread.detachNewThread { Self.pipe(upstream, client); group.leave() }
        group.wait()
        close(client); close(upstream)
    }

    private static func connect(_ port: Int) -> Int32? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = UInt16(port).bigEndian
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        if rc != 0 { close(fd); return nil }
        return fd
    }

    private static func pipe(_ from: Int32, _ to: Int32) {
        var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(from, &buffer, buffer.count)
            if n <= 0 { break }
            if !writeAll(to, Data(buffer[0..<n])) { break }
        }
        shutdown(to, SHUT_WR)
        shutdown(from, SHUT_RD)
    }
}
