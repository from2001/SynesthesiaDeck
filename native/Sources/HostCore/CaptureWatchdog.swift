/// Tracks valid buffer delivery using monotonic milliseconds, independently of signal level.
public struct CaptureWatchdog {
    public enum Failure: Equatable {
        case noSamples
        case stalled
    }

    public let startupTimeoutMilliseconds: Double
    public let stallTimeoutMilliseconds: Double
    public private(set) var needsRestart = false
    private var startedAt: Double?
    private var lastSampleAt: Double?

    public init(startupTimeoutMilliseconds: Double = 3000, stallTimeoutMilliseconds: Double = 1000) {
        precondition(startupTimeoutMilliseconds.isFinite && startupTimeoutMilliseconds > 0)
        precondition(stallTimeoutMilliseconds.isFinite && stallTimeoutMilliseconds > 0)
        self.startupTimeoutMilliseconds = startupTimeoutMilliseconds
        self.stallTimeoutMilliseconds = stallTimeoutMilliseconds
    }

    public var acceptsSamples: Bool { startedAt != nil && !needsRestart }

    public mutating func start(at now: Double) {
        startedAt = now
        lastSampleAt = nil
        needsRestart = false
    }

    public mutating func stop() {
        startedAt = nil
        lastSampleAt = nil
        needsRestart = false
    }

    /// Late callbacks cannot recover a failed stream; only a new capture attempt can.
    @discardableResult public mutating func receivedSamples(at now: Double) -> Bool {
        guard acceptsSamples else { return false }
        lastSampleAt = now
        return true
    }

    @discardableResult public mutating func fail() -> Bool {
        guard acceptsSamples else { return false }
        needsRestart = true
        return true
    }

    /// Returns a failure only once per capture attempt.
    public mutating func poll(at now: Double) -> Failure? {
        guard let startedAt, acceptsSamples else { return nil }
        let timeout = lastSampleAt == nil ? startupTimeoutMilliseconds : stallTimeoutMilliseconds
        guard now - (lastSampleAt ?? startedAt) >= timeout else { return nil }
        needsRestart = true
        return lastSampleAt == nil ? .noSamples : .stalled
    }
}
