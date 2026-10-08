import Foundation

/// Shared state that the manager app writes and launchers read.
public struct ManagerState: Codable, Sendable {
    /// Sessions whose browser the manager keeps after the launcher ended
    /// (pinned or protected manual work). The reaper never touches them.
    public var adopted: [String: AdoptedBrowser] = [:]
    public var names: [String: String] = [:]
    public var pinned: Set<String> = []
    public var hiddenEnded: Set<String> = []

    public init() {}

    /// Missing keys get defaults, so state files of other versions still load.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        adopted = try c.decodeIfPresent([String: AdoptedBrowser].self, forKey: .adopted) ?? [:]
        names = try c.decodeIfPresent([String: String].self, forKey: .names) ?? [:]
        pinned = try c.decodeIfPresent(Set<String>.self, forKey: .pinned) ?? []
        hiddenEnded = try c.decodeIfPresent(Set<String>.self, forKey: .hiddenEnded) ?? []
    }

    public static func load() -> ManagerState {
        guard let data = FileManager.default.contents(atPath: Paths.state.path) else { return ManagerState() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(ManagerState.self, from: data)) ?? ManagerState()
    }

    public func save() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(self) else { return }
        let tmp = Paths.state.appendingPathExtension("tmp")
        FileManager.default.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600])
        _ = try? FileManager.default.replaceItemAt(Paths.state, withItemAt: tmp)
    }
}

public struct AdoptedBrowser: Codable, Sendable, Hashable {
    public var chromePid: Int32
    public var chromeIdentity: String
    public var port: Int
    public var meta: SessionMeta?
    public var since: Date

    public init(chromePid: Int32, chromeIdentity: String, port: Int, meta: SessionMeta?, since: Date) {
        self.chromePid = chromePid
        self.chromeIdentity = chromeIdentity
        self.port = port
        self.meta = meta
        self.since = since
    }
}

/// Finds and removes Habitab browsers whose owner is gone.
///
/// A browser is kept while its owner (the launcher identity in
/// `--habitab-owner`) is alive or while the manager has adopted it. Only
/// processes with Habitab markers and a profile inside `Paths.profiles` are
/// considered. The personal Chrome and browsers of other tools never match.
public enum Reaper {
    public static let ownerFile = ".habitab-owner"

    public struct Report: Sendable {
        public var killed: [Chrome.Found] = []
        public var removedProfiles: [String] = []
        public var kept: [Chrome.Found] = []
    }

    public static func writeOwner(_ owner: String, profile: URL) {
        try? owner.write(to: profile.appendingPathComponent(ownerFile), atomically: true, encoding: .utf8)
    }

    @discardableResult
    public static func run(dryRun: Bool = false, extraKeep: Set<String> = []) -> Report {
        var report = Report()
        let state = ManagerState.load()
        let keep = Set(state.adopted.keys).union(extraKeep)
        var running = Set<String>()

        for found in Chrome.findOwned() {
            guard let profile = found.profile, Paths.isOwnedProfile(URL(fileURLWithPath: profile)) else { continue }
            running.insert(found.session)
            if keep.contains(found.session) || Proc.isAlive(identity: found.owner) {
                report.kept.append(found)
                continue
            }
            report.killed.append(found)
            if !dryRun {
                Log.write("reaper: orphan browser pid=\(found.pid) session=\(found.session) owner=\(found.owner)")
                // Re-check identity right before the signal to avoid pid reuse.
                if Proc.isAlive(pid: found.pid, startMicros: found.startMicros) { Proc.terminate(found.pid) }
                removeProfile(URL(fileURLWithPath: profile))
                report.removedProfiles.append(profile)
            }
        }

        // Profiles without a running browser: delete when the owner is gone.
        let dirs = (try? FileManager.default.contentsOfDirectory(at: Paths.profiles, includingPropertiesForKeys: nil)) ?? []
        for dir in dirs where !running.contains(dir.lastPathComponent) && !keep.contains(dir.lastPathComponent) {
            let owner = (try? String(contentsOf: dir.appendingPathComponent(ownerFile), encoding: .utf8)) ?? ""
            if !owner.isEmpty && Proc.isAlive(identity: owner) { continue }
            // A profile younger than 30 s may belong to a launch in progress.
            if let created = (try? dir.resourceValues(forKeys: [.creationDateKey]))?.creationDate,
               Date().timeIntervalSince(created) < 30, owner.isEmpty { continue }
            if !dryRun { removeProfile(dir) }
            report.removedProfiles.append(dir.path)
        }
        return report
    }

    public static func removeProfile(_ url: URL) {
        guard Paths.isOwnedProfile(url) else {
            Log.write("reaper: refusing to delete \(url.path) (outside profile root)")
            return
        }
        try? FileManager.default.removeItem(at: url)
    }
}
