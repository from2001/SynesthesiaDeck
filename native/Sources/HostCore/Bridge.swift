import Foundation

public struct ClockMapping: Sendable {
    public private(set) var offset = 0.0
    public private(set) var epoch: String?
    public private(set) var roundTrip = Double.infinity
    public init() {}
    /// Midpoint sampling maps local host uptime into the show's monotonic clock.
    @discardableResult public mutating func observe(epoch: String, serverTime: Double, localBefore: Double, localAfter: Double) -> Bool {
        guard !epoch.isEmpty, serverTime.isFinite, localBefore.isFinite, localAfter.isFinite,
              localAfter >= localBefore, localAfter - localBefore < 1000 else { return false }
        let changed = self.epoch != epoch
        let rtt = localAfter - localBefore
        let sample = serverTime - (localBefore + localAfter) / 2
        // Prefer low-latency samples; still track gradual clock drift on later probes.
        if changed || rtt <= roundTrip * 1.5 + 2 { offset = changed ? sample : offset * 0.8 + sample * 0.2; roundTrip = rtt }
        self.epoch = epoch
        return true
    }
    public func masterTime(_ local: Double) -> Double { local + offset }
}

public struct BridgeConfiguration: Sendable {
    public let baseURL: URL
    public let token: String
    public init(baseURL: String, token: String) throws {
        guard let url = URL(string: baseURL), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "http", ["127.0.0.1", "localhost", "[::1]", "::1"].contains(parts.host ?? ""),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw HostError.message("SHOW_NATIVE_URL must be a loopback HTTP origin, for example http://127.0.0.1:8788") }
        guard !token.isEmpty, !token.contains("\n"), !token.contains("\r") else { throw HostError.message("Set NATIVE_TOKEN to the same native bridge token configured on the show server.") }
        self.baseURL = url; self.token = token
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private final class BridgeInbox: @unchecked Sendable {
    private let lock = NSLock()
    private var audio: (AnalyzedFrame, String)?
    private var midi: [(MIDIMessage, Double)] = []
    private var dropped = 0
    var droppedMIDI: Int { lock.lock(); defer { lock.unlock() }; return dropped }
    func audio(_ frame: AnalyzedFrame, source: String) {
        lock.lock(); defer { lock.unlock() }; audio = (frame, source)
    }
    func midi(_ message: MIDIMessage, time: Double) {
        lock.lock(); defer { lock.unlock() }
        if midi.count >= 128 { midi.removeFirst(); dropped += 1 }
        midi.append((message, time))
    }
    func takeAudio() -> (AnalyzedFrame, String)? {
        lock.lock(); defer { lock.unlock() }
        let result = audio; audio = nil; return result
    }
    func takeMIDI(now: Double) -> (MIDIMessage, Double)? {
        lock.lock(); defer { lock.unlock() }
        let count = midi.count
        midi.removeAll { now - $0.1 > 250 || $0.1 > now + 100 }
        dropped += count - midi.count
        return midi.isEmpty ? nil : midi.removeFirst()
    }
    func reset() {
        lock.lock(); defer { lock.unlock() }
        dropped += midi.count; midi.removeAll(); audio = nil
    }
}

/// Latest audio/source state plus at most 128 short-lived MIDI messages, one request in flight.
public actor FeatureBridge {
    private let configuration: BridgeConfiguration
    private let session: URLSession
    private var clock = ClockMapping()
    private nonisolated let inbox = BridgeInbox()
    private var source: (String, String, String)?
    private var running = false
    private var worker: Task<Void, Never>?
    private var lastClock = -Double.infinity
    private var failures = 0
    public private(set) var sent = 0
    public nonisolated var droppedMIDI: Int { inbox.droppedMIDI }

    public init(configuration: BridgeConfiguration) {
        self.configuration = configuration
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 3
        config.httpMaximumConnectionsPerHost = 1
        config.httpShouldSetCookies = false
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    public func start() {
        guard !running else { return }
        running = true
        worker = Task { await self.run() }
    }

    public func stop() async {
        running = false
        worker?.cancel()
        await worker?.value
        session.invalidateAndCancel()
    }

    // Synchronous bounded ingress avoids unbounded Tasks and preserves callback event order.
    public nonisolated func submitAudio(_ frame: AnalyzedFrame, source: String) { inbox.audio(frame, source: source) }
    public nonisolated func submitMIDI(_ message: MIDIMessage, localTimestamp: Double) { inbox.midi(message, time: localTimestamp) }
    public func setSource(capture: String, midi: String, detail: String) { source = (capture, midi, String(detail.prefix(400))) }

    private func request(path: String, body: [String: Any]? = nil) async throws -> Data {
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent(path))
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200 ..< 300).contains(response.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw HostError.message("Bridge HTTP \(code). Check server availability and NATIVE_TOKEN.")
        }
        return data
    }

    private func synchronizeClock() async throws {
        let before = monotonicMilliseconds()
        let data = try await request(path: "clock")
        let after = monotonicMilliseconds()
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (json["version"] as? Int) == 1, let epoch = json["epoch"] as? String,
              let time = json["serverTime"] as? Double else { throw HostError.message("Bridge returned an unsupported clock response.") }
        let previousEpoch = clock.epoch
        guard clock.observe(epoch: epoch, serverTime: time, localBefore: before, localAfter: after) else { throw HostError.message("Clock sample rejected: latency exceeded 1 second or values are invalid.") }
        if previousEpoch != nil && previousEpoch != epoch {
            inbox.reset()
            hostLog("Show clock epoch changed; discarded old queued control events.")
        }
        lastClock = after
    }

    private func run() async {
        while running && !Task.isCancelled {
            do {
                if monotonicMilliseconds() - lastClock > 5000 { try await synchronizeClock() }
                if let status = source {
                    source = nil
                    do { _ = try await request(path: "ingest", body: ["version": 1, "type": "source", "capture": status.0, "midi": status.1, "detail": status.2]) }
                    catch { if source == nil { source = status }; throw error }
                    sent += 1
                }
                let now = monotonicMilliseconds()
                if let event = inbox.takeMIDI(now: now) {
                    // Never retry button edges after ambiguous HTTP failures: avoid duplicate DROP.
                    _ = try await request(path: "ingest", body: ["version": 1, "type": "midi", "timestamp": clock.masterTime(event.1), "status": event.0.status, "data1": event.0.data1, "data2": event.0.data2])
                    sent += 1
                }
                if let (frame, kind) = inbox.takeAudio() {
                    if now - frame.localTimestamp < 250 {
                        let audio = try JSONSerialization.jsonObject(with: JSONEncoder().encode(frame.audio))
                        _ = try await request(path: "ingest", body: ["version": 1, "type": "audio", "timestamp": clock.masterTime(frame.localTimestamp), "audio": audio, "source": kind])
                        sent += 1
                    }
                }
                if failures > 0 { hostLog("Native feature bridge reconnected."); failures = 0 }
                try await Task.sleep(nanoseconds: 5_000_000)
            } catch {
                if Task.isCancelled { break }
                failures += 1
                if failures == 1 || failures % 10 == 0 { hostLog("Native bridge unavailable: \(error)") }
                lastClock = -Double.infinity
                try? await Task.sleep(nanoseconds: UInt64(min(5, 0.25 * pow(2, Double(min(failures, 5)))) * 1_000_000_000))
            }
        }
    }
}
