import Darwin
import Foundation

/// Process inspection based on libproc and sysctl. No shell tools are used, so
/// results do not depend on `ps` output formats.
public struct ProcInfo: Codable, Hashable, Sendable {
    public var pid: Int32
    public var ppid: Int32
    public var pgid: Int32
    public var name: String
    /// Start time in microseconds since 1970. Together with `pid` this
    /// identifies a process even when the pid is reused later.
    public var startMicros: UInt64

    public var identity: String { "\(pid):\(startMicros)" }

    /// Base name of argv[0]. The kernel name is the executable file name,
    /// which differs for versioned binaries (Claude Code: "2.1.292").
    public var command: String {
        guard let first = Proc.arguments(pid)?.first else { return name }
        let token = first.split(separator: " ").first.map(String.init) ?? first
        return (token as NSString).lastPathComponent
    }

    public func matches(_ names: String...) -> Bool {
        let c = command.lowercased(), n = name.lowercased()
        return names.contains { c == $0 || n == $0 }
    }
}

public enum Proc {
    public static func info(_ pid: Int32) -> ProcInfo? {
        var bsd = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, size) == size else { return nil }
        let name = withUnsafePointer(to: &bsd.pbi_name) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXCOMLEN) * 2) { String(cString: $0) }
        }
        let fallback = withUnsafePointer(to: &bsd.pbi_comm) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXCOMLEN)) { String(cString: $0) }
        }
        let start = UInt64(bsd.pbi_start_tvsec) * 1_000_000 + UInt64(bsd.pbi_start_tvusec)
        return ProcInfo(pid: pid, ppid: Int32(bsd.pbi_ppid), pgid: Int32(bsd.pbi_pgid),
                        name: name.isEmpty ? fallback : name, startMicros: start)
    }

    public static func allPIDs() -> [Int32] {
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return [] }
        var pids = [Int32](repeating: 0, count: Int(count) + 64)
        let n = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<Int32>.size))
        return Array(pids.prefix(Int(max(0, n)))).filter { $0 > 0 }
    }

    /// Full argv of a process (KERN_PROCARGS2). Returns nil for processes of
    /// other users or processes that already exited.
    public static func arguments(_ pid: Int32) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        let argc = buffer.withUnsafeBytes { $0.load(as: Int32.self) }
        var index = MemoryLayout<Int32>.size
        // Skip the executable path and the padding NULs after it.
        while index < size && buffer[index] != 0 { index += 1 }
        while index < size && buffer[index] == 0 { index += 1 }
        var args: [String] = []
        var start = index
        while index < size && args.count < Int(argc) {
            if buffer[index] == 0 {
                args.append(String(decoding: buffer[start..<index], as: UTF8.self))
                start = index + 1
            }
            index += 1
        }
        return args
    }

    public static func cwd(_ pid: Int32) -> String? {
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
        return withUnsafePointer(to: &info.pvi_cdir.vip_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
        }
    }

    /// Paths of regular files the process has open.
    public static func openFiles(_ pid: Int32) -> [String] {
        let bufferSize = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard bufferSize > 0 else { return [] }
        let count = Int(bufferSize) / MemoryLayout<proc_fdinfo>.size
        var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: count)
        let used = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, &fds, bufferSize)
        guard used > 0 else { return [] }
        var paths: [String] = []
        for fd in fds.prefix(Int(used) / MemoryLayout<proc_fdinfo>.size) where fd.proc_fdtype == UInt32(PROX_FDTYPE_VNODE) {
            var vinfo = vnode_fdinfowithpath()
            let vsize = Int32(MemoryLayout<vnode_fdinfowithpath>.size)
            if proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDVNODEPATHINFO, &vinfo, vsize) == vsize {
                let path = withUnsafePointer(to: &vinfo.pvip.vip_path) {
                    $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
                }
                if !path.isEmpty { paths.append(path) }
            }
        }
        return paths
    }

    /// Parent chain starting with the parent of `pid`, nearest first.
    public static func ancestry(of pid: Int32, limit: Int = 12) -> [ProcInfo] {
        var chain: [ProcInfo] = []
        var current = info(pid)?.ppid ?? 0
        while current > 1, chain.count < limit, let p = info(current) {
            chain.append(p)
            current = p.ppid
        }
        return chain
    }

    /// True if a process with this pid exists and (if given) started at the
    /// recorded time.
    public static func isAlive(pid: Int32, startMicros: UInt64? = nil) -> Bool {
        guard pid > 0, let p = info(pid) else { return false }
        if let start = startMicros, start != 0, p.startMicros != start { return false }
        return true
    }

    public static func isAlive(identity: String) -> Bool {
        let parts = identity.split(separator: ":")
        guard parts.count == 2, let pid = Int32(parts[0]), let start = UInt64(parts[1]) else { return false }
        return isAlive(pid: pid, startMicros: start)
    }

    /// SIGTERM, then SIGKILL after `grace` seconds. With `group: true` the
    /// signal goes to the process group `pid`.
    @discardableResult
    public static func terminate(_ pid: Int32, group: Bool = false, grace: TimeInterval = 3) -> Bool {
        guard pid > 1 else { return false }
        let target = group ? -pid : pid
        if kill(target, SIGTERM) != 0 && errno == ESRCH { return true }
        let deadline = Date().addingTimeInterval(grace)
        while Date() < deadline {
            if !groupOrProcessAlive(pid, group: group) { return true }
            usleep(50_000)
        }
        kill(target, SIGKILL)
        usleep(100_000)
        return !groupOrProcessAlive(pid, group: group)
    }

    private static func groupOrProcessAlive(_ pid: Int32, group: Bool) -> Bool {
        if group { return kill(-pid, 0) == 0 }
        // A zombie child still answers kill(0); reap it if it is ours.
        var status: Int32 = 0
        if waitpid(pid, &status, WNOHANG) == pid { return false }
        return kill(pid, 0) == 0
    }

    public static func selfIdentity() -> String {
        info(getpid())?.identity ?? "\(getpid()):0"
    }
}
