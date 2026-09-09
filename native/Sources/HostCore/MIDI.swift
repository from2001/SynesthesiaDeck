import AudioToolbox
import CoreMIDI
import Foundation

public struct MIDIMessage: Equatable, Sendable {
    public var status: UInt8
    public var data1: UInt8
    public var data2: UInt8
    public var channel: Int { Int(status & 0x0f) + 1 }
    public var isRelease: Bool { status & 0xf0 == 0x80 || (status & 0xf0 == 0x90 && data2 == 0) }
    public init(status: UInt8, data1: UInt8, data2: UInt8) {
        self.status = status; self.data1 = data1; self.data2 = data2
    }
}

/// Handles packet boundaries, running status, realtime bytes, and unrelated messages.
public struct MIDIParser {
    private var status: UInt8?
    private var data: [UInt8] = []
    public init() {}
    public mutating func consume(_ bytes: [UInt8]) -> [MIDIMessage] {
        var result: [MIDIMessage] = []
        for byte in bytes {
            if byte >= 0xf8 { continue }
            if byte >= 0x80 {
                data.removeAll(keepingCapacity: true)
                status = byte < 0xf0 ? byte : nil
                continue
            }
            guard let current = status else { continue }
            data.append(byte)
            let kind = current & 0xf0
            let length = kind == 0xc0 || kind == 0xd0 ? 1 : 2
            if data.count == length {
                if [UInt8(0x80), 0x90, 0xb0].contains(kind) {
                    result.append(MIDIMessage(status: current, data1: data[0], data2: data[1]))
                }
                data.removeAll(keepingCapacity: true)
            }
        }
        return result
    }
}

public struct MIDIControl: Codable, Sendable {
    public var name: String
    public var channel: Int
    public var kind: String
    public var number: Int
    public var minimum: Int
    public var maximum: Int
    /// Toggle describes controller-generated alternating on/off values, not a second software latch.
    public var behavior: String
}

public struct MIDIProfile: Codable, Sendable {
    public var controls: [MIDIControl]
    public static func nanoKONTROL2(channel: Int = 1) -> MIDIProfile {
        var controls: [MIDIControl] = []
        for (name, start, behavior) in [("fader", 0, "continuous"), ("knob", 16, "continuous"), ("solo", 32, "momentary"), ("mute", 48, "momentary"), ("record", 64, "momentary")] {
            for i in 0 ..< 8 {
                controls.append(MIDIControl(name: "\(name)\(i + 1)", channel: channel, kind: "cc", number: start + i, minimum: 0, maximum: 127, behavior: behavior))
            }
        }
        for (name, cc) in [("rewind", 43), ("forward", 44), ("stop", 42), ("play", 41), ("recordTransport", 45), ("cycle", 46), ("trackPrevious", 58), ("trackNext", 59), ("markerSet", 60), ("markerPrevious", 61), ("markerNext", 62)] {
            controls.append(MIDIControl(name: name, channel: channel, kind: "cc", number: cc, minimum: 0, maximum: 127, behavior: "momentary"))
        }
        return MIDIProfile(controls: controls)
    }

    public func validate() throws {
        var identities = Set<String>()
        let names = Set(Self.nanoKONTROL2().controls.map(\.name))
        for control in controls {
            guard (1 ... 16).contains(control.channel), (0 ... 127).contains(control.number),
                  (0 ... 127).contains(control.minimum), (0 ... 127).contains(control.maximum),
                  control.minimum != control.maximum, ["cc", "note"].contains(control.kind),
                  ["continuous", "momentary", "toggle"].contains(control.behavior), names.contains(control.name),
                  identities.insert("\(control.channel):\(control.kind):\(control.number)").inserted else {
                throw HostError.message("Invalid or duplicate MIDI profile control: \(control.name)")
            }
        }
    }

    public func map(_ message: MIDIMessage) -> (name: String, value: Double, pressed: Bool, behavior: String)? {
        guard [UInt8(0x80), 0x90, 0xb0].contains(message.status & 0xf0), message.data1 < 128, message.data2 < 128 else { return nil }
        let kind = message.status & 0xf0 == 0xb0 ? "cc" : "note"
        guard let control = controls.first(where: { $0.channel == message.channel && $0.kind == kind && $0.number == Int(message.data1) }) else { return nil }
        let raw = message.isRelease ? control.minimum : Int(message.data2)
        let value = min(1, max(0, Double(raw - control.minimum) / Double(control.maximum - control.minimum)))
        return (control.name, value, value >= 0.5, control.behavior)
    }
}

public struct MIDISource: Sendable {
    public var endpoint: MIDIEndpointRef
    public var id: Int32
    public var name: String
    public var manufacturer: String
}

/// Converts the user's hardware profile into the bridge's canonical CC contract.
public final class MIDIMapper: @unchecked Sendable {
    private let profile: MIDIProfile
    private let canonical = MIDIProfile.nanoKONTROL2()
    private let lock = NSLock()
    private var toggleValues: [String: Bool] = [:]
    public init(profile: MIDIProfile) { self.profile = profile }
    public func messages(for message: MIDIMessage) -> [MIDIMessage] {
        lock.lock(); defer { lock.unlock() }
        guard let mapped = profile.map(message), let target = canonical.controls.first(where: { $0.name == mapped.name }) else { return [] }
        let number = UInt8(target.number)
        if mapped.behavior == "toggle" {
            guard toggleValues[mapped.name] != mapped.pressed else { return [] }
            toggleValues[mapped.name] = mapped.pressed
            // Both hardware on and hardware off are physical presses. The server owns the latch.
            return [MIDIMessage(status: 0xb0, data1: number, data2: 127), MIDIMessage(status: 0xb0, data1: number, data2: 0)]
        }
        return [MIDIMessage(status: 0xb0, data1: number, data2: UInt8((mapped.value * 127).rounded()))]
    }
}

public final class MIDIReceiver: @unchecked Sendable {
    private var client = MIDIClientRef()
    private var port = MIDIPortRef()
    private var connected: Set<MIDIEndpointRef> = []
    private var parsers: [MIDIEndpointRef: MIDIParser] = [:]
    private let queue = DispatchQueue(label: "show.midi")
    private let available = DispatchSemaphore(value: 32)
    private let selection: String?
    private let onMessage: @Sendable (MIDIMessage, Double) -> Void
    private let onStatus: @Sendable (String) -> Void

    public init(selection: String?, onMessage: @escaping @Sendable (MIDIMessage, Double) -> Void, onStatus: @escaping @Sendable (String) -> Void) {
        self.selection = selection; self.onMessage = onMessage; self.onStatus = onStatus
    }

    public static func sources() -> [MIDISource] {
        (0 ..< MIDIGetNumberOfSources()).map { index in
            let endpoint = MIDIGetSource(index)
            var id: Int32 = 0
            MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyUniqueID, &id)
            return MIDISource(endpoint: endpoint, id: id, name: stringProperty(endpoint, kMIDIPropertyDisplayName), manufacturer: stringProperty(endpoint, kMIDIPropertyManufacturer))
        }
    }

    private static func stringProperty(_ object: MIDIObjectRef, _ property: CFString) -> String {
        var value: Unmanaged<CFString>?
        guard MIDIObjectGetStringProperty(object, property, &value) == noErr, let value else { return "Unknown" }
        return value.takeRetainedValue() as String
    }

    public func start() throws {
        var status = MIDIClientCreateWithBlock("NanoKonHost" as CFString, &client) { [weak self] _ in
            self?.queue.async { [weak self] in self?.refresh() }
        }
        guard status == noErr else { throw HostError.message("MIDI client creation failed: \(status)") }
        status = MIDIInputPortCreateWithBlock(client, "Control input" as CFString, &port) { [weak self] packets, sourceRef in
            guard let self, self.available.wait(timeout: .now()) == .success else { return }
            let source = MIDIEndpointRef(UInt(bitPattern: sourceRef))
            var payloads: [([UInt8], Double)] = []
            do {
                // Address the original variable-length list, not a copied first packet.
                var packet = UnsafeRawPointer(packets).advanced(by: MemoryLayout<MIDIPacketList>.offset(of: \.packet)!).assumingMemoryBound(to: MIDIPacket.self)
                // MIDI callback work and retained memory are strictly bounded.
                for _ in 0 ..< min(Int(packets.pointee.numPackets), 64) {
                    let size = min(Int(packet.pointee.length), 256)
                    let bytes = withUnsafeBytes(of: packet.pointee.data) { Array($0.prefix(size)) }
                    let stamp = packet.pointee.timeStamp == 0 ? monotonicMilliseconds() : Double(AudioConvertHostTimeToNanos(packet.pointee.timeStamp)) / 1_000_000
                    payloads.append((bytes, stamp))
                    packet = UnsafePointer(MIDIPacketNext(packet))
                }
            }
            self.queue.async {
                defer { self.available.signal() }
                var parser = self.parsers[source] ?? MIDIParser()
                for (bytes, time) in payloads {
                    for message in parser.consume(bytes) { self.onMessage(message, time) }
                }
                self.parsers[source] = parser
            }
        }
        guard status == noErr else { throw HostError.message("MIDI input creation failed: \(status)") }
        queue.sync { refresh() }
    }

    private func refresh() {
        let sources = Self.sources().filter { source in
            if let selection { return source.name.localizedCaseInsensitiveContains(selection) || String(source.id) == selection }
            return source.name.localizedCaseInsensitiveContains("nanoKONTROL2")
        }
        let wanted = Set(sources.map(\.endpoint))
        for source in connected.subtracting(wanted) { MIDIPortDisconnectSource(port, source); parsers.removeValue(forKey: source) }
        connected.formIntersection(wanted)
        for source in wanted.subtracting(connected) {
            if MIDIPortConnectSource(port, source, UnsafeMutableRawPointer(bitPattern: UInt(source))) == noErr { connected.insert(source) }
        }
        onStatus(connected.isEmpty ? "disconnected" : "connected")
    }

    public func stop() {
        queue.sync {
            if port != 0 { MIDIPortDispose(port); port = 0 }
            if client != 0 { MIDIClientDispose(client); client = 0 }
            connected.removeAll(); parsers.removeAll()
        }
    }
}
