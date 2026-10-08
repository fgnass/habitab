import Darwin
import Foundation
import HabitabCore

/// Local TCP port that the MCP server receives as `--browserUrl`. The port
/// exists before Chrome runs. The first connection starts Chrome; bytes are
/// then copied to Chrome's real DevTools port. Only 127.0.0.1 is bound.
final class Forwarder: @unchecked Sendable {
    private let listenFD: Int32
    let port: Int
    private let target: () -> Int?

    init?(target: @escaping () -> Int?) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(fd, 16) == 0 else { close(fd); return nil }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        listenFD = fd
        port = Int(UInt16(bigEndian: addr.sin_port))
        self.target = target
    }

    func start() {
        Thread.detachNewThread { [self] in
            while true {
                let client = accept(listenFD, nil, nil)
                if client < 0 {
                    if errno == EINTR { continue }
                    return
                }
                Thread.detachNewThread { [self] in handle(client) }
            }
        }
    }

    private func handle(_ client: Int32) {
        var on: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        guard let realPort = target(), let upstream = Forwarder.connectLocal(realPort) else {
            close(client)
            return
        }
        let done = DispatchGroup()
        done.enter(); done.enter()
        Thread.detachNewThread { Forwarder.pipe(from: client, to: upstream); done.leave() }
        Thread.detachNewThread { Forwarder.pipe(from: upstream, to: client); done.leave() }
        done.wait()
        close(client)
        close(upstream)
    }

    static func connectLocal(_ port: Int) -> Int32? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = UInt16(port).bigEndian
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        if rc != 0 { close(fd); return nil }
        return fd
    }

    private static func pipe(from: Int32, to: Int32) {
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
