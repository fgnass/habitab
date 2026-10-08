import Foundation

/// Minimal Chrome DevTools Protocol client over one browser-level WebSocket.
/// Page sessions use flat mode (`sessionId` on each message).
public final class CDPClient: NSObject, @unchecked Sendable, URLSessionWebSocketDelegate {
    public typealias JSON = [String: Any]

    public struct CDPError: Error, CustomStringConvertible {
        public var message: String
        public var description: String { message }
    }

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private let lock = NSLock()
    private var nextId = 0
    private var pending: [Int: (Result<JSON, Error>) -> Void] = [:]
    private var openWaiters: [(Bool) -> Void] = []
    private var isOpen = false
    public private(set) var isClosed = false

    /// Called on a background queue for every event: (method, params, sessionId).
    public var onEvent: ((String, JSON, String?) -> Void)?
    public var onClose: (() -> Void)?
    private var listeners: [UUID: (String, JSON, String?) -> Void] = [:]

    /// Additional event handler, for example for one attached page session.
    public func addListener(_ handler: @escaping (String, JSON, String?) -> Void) -> UUID {
        let id = UUID()
        lock.lock(); listeners[id] = handler; lock.unlock()
        return id
    }

    public func removeListener(_ id: UUID) {
        lock.lock(); listeners.removeValue(forKey: id); lock.unlock()
    }

    public let url: URL

    public init(url: URL) {
        self.url = url
        super.init()
    }

    public func connect(timeout: TimeInterval = 5, completion: @escaping (Bool) -> Void) {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.webSocketTask(with: url)
        // Screencast frames and screenshots can be large.
        task.maximumMessageSize = 128 * 1024 * 1024
        self.task = task
        lock.lock(); openWaiters.append(completion); lock.unlock()
        task.resume()
        receiveLoop()
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
            self?.finishOpen(false)
        }
    }

    public func connectSync(timeout: TimeInterval = 5) -> Bool {
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        connect(timeout: timeout) { ok = $0; sem.signal() }
        sem.wait()
        return ok
    }

    private func finishOpen(_ ok: Bool) {
        lock.lock()
        let waiters = openWaiters
        openWaiters = []
        if ok { isOpen = true }
        lock.unlock()
        waiters.forEach { $0(ok) }
        if !ok && !isOpen { close() }
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        finishOpen(true)
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        handleClose()
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finishOpen(false)
        handleClose()
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.handleClose()
            case .success(let message):
                var data: Data?
                switch message {
                case .string(let s): data = s.data(using: .utf8)
                case .data(let d): data = d
                @unknown default: break
                }
                if let data, let json = (try? JSONSerialization.jsonObject(with: data)) as? JSON {
                    self.dispatch(json)
                }
                self.receiveLoop()
            }
        }
    }

    private func dispatch(_ json: JSON) {
        if let id = json["id"] as? Int {
            lock.lock(); let handler = pending.removeValue(forKey: id); lock.unlock()
            if let error = json["error"] as? JSON {
                handler?(.failure(CDPError(message: error["message"] as? String ?? "CDP error")))
            } else {
                handler?(.success(json["result"] as? JSON ?? [:]))
            }
        } else if let method = json["method"] as? String {
            let params = json["params"] as? JSON ?? [:]
            let sessionId = json["sessionId"] as? String
            onEvent?(method, params, sessionId)
            lock.lock(); let handlers = Array(listeners.values); lock.unlock()
            handlers.forEach { $0(method, params, sessionId) }
        }
    }

    private func handleClose() {
        lock.lock()
        if isClosed { lock.unlock(); return }
        isClosed = true
        let handlers = pending
        pending = [:]
        lock.unlock()
        handlers.values.forEach { $0(.failure(CDPError(message: "connection closed"))) }
        session?.invalidateAndCancel()
        onClose?()
    }

    public func send(_ method: String, _ params: JSON = [:], sessionId: String? = nil,
                     completion: ((Result<JSON, Error>) -> Void)? = nil) {
        lock.lock()
        if isClosed { lock.unlock(); completion?(.failure(CDPError(message: "connection closed"))); return }
        nextId += 1
        let id = nextId
        if let completion { pending[id] = completion }
        lock.unlock()
        var message: JSON = ["id": id, "method": method, "params": params]
        if let sessionId { message["sessionId"] = sessionId }
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { [weak self] error in
            if error != nil { self?.handleClose() }
        }
    }

    public func call(_ method: String, _ params: JSON = [:], sessionId: String? = nil) async throws -> JSON {
        try await withCheckedThrowingContinuation { cont in
            send(method, params, sessionId: sessionId) { cont.resume(with: $0) }
        }
    }

    public func callSync(_ method: String, _ params: JSON = [:], sessionId: String? = nil, timeout: TimeInterval = 5) -> JSON? {
        let sem = DispatchSemaphore(value: 0)
        var out: JSON?
        send(method, params, sessionId: sessionId) { if case .success(let r) = $0 { out = r }; sem.signal() }
        _ = sem.wait(timeout: .now() + timeout)
        return out
    }

    public func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        handleClose()
    }
}
