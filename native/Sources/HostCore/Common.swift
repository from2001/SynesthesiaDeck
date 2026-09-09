import AudioToolbox
import Foundation

public enum HostError: Error, CustomStringConvertible {
    case message(String)
    public var description: String { switch self { case .message(let text): return text } }
}

public func monotonicMilliseconds() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

public func hostLog(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}
