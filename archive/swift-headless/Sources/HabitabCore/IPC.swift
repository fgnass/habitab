import Darwin
import Foundation

/// One message on the launcher <-> manager socket. The wire format is one
/// JSON object per line. All fields are optional so that older and newer
/// components can talk to each other.
public struct IPCMessage: Codable, Sendable {
    public var type: String

    // hello / welcome
    public var sessionId: String?
    public var launcherIdentity: String?
    public var launcherPid: Int32?
    public var meta: SessionMeta?

    // browser state
    public var chromePid: Int32?
    public var chromeIdentity: String?
    public var debugPort: Int?
    public var browserState: String?
    public var detail: String?

    // MCP activity
    public var tool: String?
    public var callId: String?
    public var summary: String?
    public var isError: Bool?
    public var durationMs: Int?
    public var protectedReason: String?

    // control
    public var keep: Bool?
    public var hold: Bool?
    public var reason: String?

    public init(type: String) { self.type = type }
}

/// Everything the launcher knows about the agent session behind one MCP
/// connection. Fields stay nil when no reliable source exists.
public struct SessionMeta: Codable, Sendable, Hashable {
    public var cwd: String?
    public var projectRoot: String?
    public var projectName: String?
    /// "claude", "codex" or nil
    public var client: String?
    public var clientName: String?
    public var clientVersion: String?
    /// How `client` was determined, for display ("clientInfo", "process").
    public var clientSource: String?
    public var clientPid: Int32?
    /// Chat/thread id from the client, with its source.
    public var agentSessionId: String?
    public var agentSessionSource: String?
    public var agentSessionName: String?
    public var roots: [String]?
    public var serverName: String?
    public var originalCommand: [String]?
    public var ancestry: [String]?
    public var startedAt: Date?

    public init() {}
}

public enum IPCType {
    public static let hello = "hello"
    public static let welcome = "welcome"
    public static let meta = "meta"
    public static let browser = "browser"
    public static let toolStart = "toolStart"
    public static let toolEnd = "toolEnd"
    public static let ending = "ending"
    public static let handoff = "handoff"
    public static let bye = "bye"
    public static let hold = "hold"
    public static let stopBrowser = "stopBrowser"
    public static let touch = "touch"
    public static let protect = "protect"
}

/// Blocking line-based JSON connection over a Unix domain socket.
public final class IPCConnection: @unchecked Sendable {
    public let fd: Int32
    private var buffer = Data()
    private let writeLock = NSLock()
    private var closed = false
    private let closeLock = NSLock()

    public init(fd: Int32) {
        self.fd = fd
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    }

    public static func connect(to path: String) -> IPCConnection? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        guard var addr = unixAddress(path) else { Darwin.close(fd); return nil }
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { Darwin.close(fd); return nil }
        return IPCConnection(fd: fd)
    }

    public static func unixAddress(_ path: String) -> sockaddr_un? {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < capacity else { return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
        }
        return addr
    }

    @discardableResult
    public func send(_ message: IPCMessage) -> Bool {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard var data = try? encoder.encode(message) else { return false }
        data.append(0x0A)
        writeLock.lock(); defer { writeLock.unlock() }
        return writeAll(fd, data)
    }

    /// Blocks until one message arrives. Returns nil at EOF or on error.
    public func receive() -> IPCMessage? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer.removeSubrange(buffer.startIndex...nl)
                if line.isEmpty { continue }
                if let msg = try? decoder.decode(IPCMessage.self, from: line) { return msg }
                continue
            }
            var chunk = [UInt8](repeating: 0, count: 65536)
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<n])
        }
    }

    public func close() {
        closeLock.lock(); defer { closeLock.unlock() }
        guard !closed else { return }
        closed = true
        shutdown(fd, SHUT_RDWR)
        Darwin.close(fd)
    }

    /// Process id of the peer (LOCAL_PEERPID). The manager uses it to check
    /// that a connecting launcher is a process of the same user.
    public var peerPid: Int32? {
        var pid: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) == 0 else { return nil }
        return pid
    }

    public var peerUid: uid_t? {
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard getpeereid(fd, &uid, &gid) == 0 else { return nil }
        return uid
    }
}

@discardableResult
public func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw -> Bool in
        guard var ptr = raw.baseAddress else { return true }
        var remaining = raw.count
        while remaining > 0 {
            let n = write(fd, ptr, remaining)
            if n < 0 {
                if errno == EINTR { continue }
                return false
            }
            remaining -= n
            ptr = ptr.advanced(by: n)
        }
        return true
    }
}

public enum SessionID {
    /// Short, readable id such as "hb-k3m9q2xa".
    public static func make() -> String {
        let alphabet = Array("abcdefghjkmnpqrstuvwxyz23456789")
        var rng = SystemRandomNumberGenerator()
        return "hb-" + String((0..<8).map { _ in alphabet[Int(rng.next() % UInt64(alphabet.count))] })
    }

    public static func isValid(_ id: String) -> Bool {
        id.hasPrefix("hb-") && id.count <= 32 && id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" }
    }
}
