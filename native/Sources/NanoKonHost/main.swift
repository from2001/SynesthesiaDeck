import Foundation
import HostCore
import ScreenCaptureKit

private struct Options {
    var synthetic = false
    var offline = false
    var midiOnly = false
    var monitor = false
    var listMIDI = false
    var listDisplays = false
    var duration = Double.infinity
    var source: String?
    var profilePath: String?
    var replayPath: String?
    var display: UInt32?
    var excluded: [String] = []
    var analyzer = AnalyzerConfiguration()
    static let usage = """
    nanokon-host [--capture | --synthetic | --midi-only] [--duration SECONDS]
      --list-midi                List CoreMIDI source names and unique IDs, then exit
      --list-displays            List ScreenCaptureKit displays if already authorized
      --midi-source NAME_OR_ID    Select matching CoreMIDI input (default: nanoKONTROL2)
      --midi-profile FILE        Read configured control profile JSON
      --write-midi-profile FILE  Save the default CC-mode profile, then exit
      --midi-replay FILE         Replay timed MIDI fixture JSON through the bridge
      --display ID              Select the ScreenCaptureKit display
      --exclude-bundle ID        Exclude an application from system capture (repeatable)
      --attack SECONDS           Meter attack time (default: 0.035)
      --release SECONDS          Meter release time (default: 0.22)
      --noise-floor DB           Meter floor (default: -60)
      --monitor                  Print feature summaries and normalized MIDI controls
      --offline                  Analyze without the HTTP bridge (explicit test mode)
    Environment: NATIVE_TOKEN, SHOW_NATIVE_URL (default http://127.0.0.1:8788)
    System capture is the default. Permission is checked without opening a prompt.
    """
    static func parse() throws -> Options {
        var result = Options()
        let args = Array(CommandLine.arguments.dropFirst())
        var index = 0
        func value() throws -> String {
            index += 1
            guard index < args.count else { throw HostError.message("Missing value for \(args[index - 1])") }
            return args[index]
        }
        while index < args.count {
            switch args[index] {
            case "--help", "-h": print(usage); exit(0)
            case "--synthetic": result.synthetic = true
            case "--capture": break
            case "--offline": result.offline = true
            case "--monitor": result.monitor = true
            case "--midi-only": result.midiOnly = true
            case "--list-midi": result.listMIDI = true
            case "--list-displays": result.listDisplays = true
            case "--midi-source": result.source = try value()
            case "--midi-profile": result.profilePath = try value()
            case "--midi-replay": result.replayPath = try value(); result.midiOnly = true
            case "--exclude-bundle": result.excluded.append(try value())
            case "--display":
                guard let id = UInt32(try value()) else { throw HostError.message("Display ID must be an unsigned integer") }; result.display = id
            case "--duration":
                guard let duration = Double(try value()), duration.isFinite, duration > 0 else { throw HostError.message("Duration must be a positive number") }; result.duration = duration
            case "--attack", "--release", "--noise-floor":
                let option = args[index]
                guard let number = Double(try value()), number.isFinite,
                      option == "--noise-floor" ? (-120 ... -1).contains(number) : (0.001 ... 10).contains(number) else { throw HostError.message("Invalid analyzer option: \(option)") }
                if option == "--attack" { result.analyzer.attackSeconds = number }
                else if option == "--release" { result.analyzer.releaseSeconds = number }
                else { result.analyzer.noiseFloorDB = number }
            case "--write-midi-profile":
                let path = try value()
                let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                try encoder.encode(MIDIProfile.nanoKONTROL2()).write(to: URL(fileURLWithPath: path))
                print("Wrote MIDI profile: \(path)"); exit(0)
            default: throw HostError.message("Unknown option: \(args[index]). Use --help.")
            }
            index += 1
        }
        guard !(result.synthetic && result.midiOnly) else { throw HostError.message("Choose one input mode: synthetic or MIDI-only/replay") }
        return result
    }
}

private actor Health {
    var capture = "stopped"
    var midi = "disconnected"
    var detail = "Starting host"
    let bridge: FeatureBridge?
    init(_ bridge: FeatureBridge?) { self.bridge = bridge }
    func update(capture: String? = nil, midi: String? = nil, detail: String? = nil) async {
        if let capture { self.capture = capture }
        if let midi { self.midi = midi }
        if let detail { self.detail = detail; hostLog(detail) }
        await bridge?.setSource(capture: self.capture, midi: self.midi, detail: self.detail)
    }
}

private final class Monitor: @unchecked Sendable {
    private let lock = NSLock()
    private var last = 0.0
    func frame(_ frame: AnalyzedFrame) {
        lock.lock(); defer { lock.unlock() }
        guard frame.localTimestamp - last >= 1000 else { return }
        last = frame.localTimestamp
        if let data = try? JSONEncoder().encode(frame.audio), let text = String(data: data, encoding: .utf8) { print(text) }
    }
}

private final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return flag }
    func set() { lock.lock(); flag = true; lock.unlock() }
}

private struct ReplayEvent: Decodable {
    var at: Double
    var status: UInt8
    var data1: UInt8
    var data2: UInt8
}

@main struct NanoKonHost {
    static func main() async {
        do { try await run(Options.parse()) }
        catch { hostLog("NanoKonHost: \(error)"); exit(1) }
    }

    private static func run(_ options: Options) async throws {
        if options.listMIDI {
            let sources = MIDIReceiver.sources()
            for source in sources { print("\(source.id)\t\(source.name)\t\(source.manufacturer)") }
            if sources.isEmpty { print("No CoreMIDI sources are available.") }
            return
        }
        if options.listDisplays {
            guard SystemAudioCapture.hasPermission else { throw HostError.message("Screen & System Audio Recording permission is not already granted. No prompt was opened.") }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            for display in content.displays { print("\(display.displayID)\t\(display.width)x\(display.height)") }
            return
        }
        let profile: MIDIProfile
        if let path = options.profilePath { profile = try JSONDecoder().decode(MIDIProfile.self, from: Data(contentsOf: URL(fileURLWithPath: path))) }
        else { profile = .nanoKONTROL2() }
        try profile.validate()
        let mapper = MIDIMapper(profile: profile)
        let bridge: FeatureBridge?
        if options.offline { bridge = nil; hostLog("Offline mode: features and MIDI are not sent to the show server.") }
        else {
            let environment = ProcessInfo.processInfo.environment
            bridge = FeatureBridge(configuration: try BridgeConfiguration(baseURL: environment["SHOW_NATIVE_URL"] ?? "http://127.0.0.1:8788", token: environment["NATIVE_TOKEN"] ?? ""))
        }
        let health = Health(bridge)
        let monitor = Monitor()
        let kind = options.synthetic ? "synthetic" : "system"
        let pipeline = AudioPipeline(configuration: options.analyzer) { frame in
            if options.monitor { monitor.frame(frame) }
            bridge?.submitAudio(frame, source: kind)
        }
        let midiHandler: @Sendable (MIDIMessage, Double) -> Void = { message, time in
            guard let mapped = profile.map(message) else {
                if options.monitor { hostLog("MIDI unmatched ch=\(message.channel) status=\(message.status) number=\(message.data1) value=\(message.data2)") }
                return
            }
            if options.monitor { hostLog("MIDI \(mapped.name) value=\(String(format: "%.3f", mapped.value)) pressed=\(mapped.pressed) behavior=\(mapped.behavior) raw=\(message.status),\(message.data1),\(message.data2)") }
            let normalized = mapper.messages(for: message)
            for event in normalized { bridge?.submitMIDI(event, localTimestamp: time) }
        }
        let midi = MIDIReceiver(selection: options.source, onMessage: midiHandler) { status in
            Task { await health.update(midi: status, detail: "CoreMIDI input \(status)") }
        }
        try midi.start()
        let capture = SystemAudioCapture(pipeline: pipeline) { state, detail in
            Task { await health.update(capture: state, detail: detail) }
        }
        var replay: [ReplayEvent] = []
        if let path = options.replayPath {
            replay = try JSONDecoder().decode([ReplayEvent].self, from: Data(contentsOf: URL(fileURLWithPath: path)))
            guard replay.allSatisfy({ $0.at.isFinite && $0.at >= 0 && [UInt8(0x80), 0x90, 0xb0].contains($0.status & 0xf0) && $0.data1 < 128 && $0.data2 < 128 }) else { throw HostError.message("Replay contains an invalid time or MIDI message") }
            replay.sort { $0.at < $1.at }
        }
        await bridge?.start()
        if options.synthetic { await health.update(capture: "synthetic", detail: "Synthetic 120 BPM audio fixture") }
        else if !options.midiOnly {
            do { try await capture.start(displayID: options.display, excludedBundleIDs: options.excluded) }
            catch {
                await health.update(capture: "error", detail: String(describing: error))
                midi.stop(); _ = pipeline.stop()
                try? await Task.sleep(nanoseconds: 200_000_000)
                await bridge?.stop()
                throw error
            }
        }
        let stop = StopFlag()
        signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        interrupt.setEventHandler { stop.set() }; terminate.setEventHandler { stop.set() }
        interrupt.resume(); terminate.resume()
        let started = monotonicMilliseconds()
        var sample = 0
        var replayIndex = 0
        var lastRetry = started
        var lastHeartbeat = started
        while !stop.isSet && monotonicMilliseconds() - started < options.duration * 1000 {
            let now = monotonicMilliseconds()
            if options.synthetic {
                let block = (0 ..< 1600).map { index -> Float in
                    let time = Double(sample + index) / 48000
                    let phase = time.truncatingRemainder(dividingBy: 0.5)
                    let envelope = phase < 0.09 ? exp(-phase * 22) : 0.02
                    return Float(sin(2 * .pi * 100 * time) * 0.65 * envelope + sin(2 * .pi * 1200 * time) * 0.08)
                }
                pipeline.submit(block, rate: 48000, time: started + Double(sample) / 48)
                sample += 1600
            }
            while replayIndex < replay.count && replay[replayIndex].at * 1000 <= now - started {
                let event = replay[replayIndex]
                midiHandler(MIDIMessage(status: event.status, data1: event.data1, data2: event.data2), now)
                replayIndex += 1
            }
            let captureState = await health.capture
            if !options.synthetic && !options.midiOnly && (capture.needsRestart || captureState == "error") && now - lastRetry > 5000 {
                lastRetry = now
                await capture.stop()
                do { try await capture.start(displayID: options.display, excludedBundleIDs: options.excluded) }
                catch { await health.update(capture: "error", detail: "Capture retry failed: \(error)") }
            }
            if now - lastHeartbeat > 2000 { await health.update(); lastHeartbeat = now }
            let next = options.synthetic ? started + Double(sample) / 48 : now + 1000 / 30
            let wait = max(1, min(33.334, next - monotonicMilliseconds()))
            try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000))
        }
        interrupt.cancel(); terminate.cancel()
        if !options.synthetic && !options.midiOnly { await capture.stop() }
        midi.stop()
        let stats = pipeline.stop()
        await health.update(capture: "stopped", midi: "disconnected", detail: "Host stopped")
        try? await Task.sleep(nanoseconds: 150_000_000)
        await bridge?.stop()
        let elapsed = (monotonicMilliseconds() - started) / 1000
        hostLog(String(format: "Analysis: %d frames, %.2f Hz, %.3f ms/frame, %.2f%% of elapsed time", stats.frames, Double(stats.frames) / elapsed, stats.seconds * 1000 / Double(max(1, stats.frames)), stats.seconds / elapsed * 100))
        if let bridge { hostLog("Bridge: \(await bridge.sent) accepted feature/control/status requests; \(bridge.droppedMIDI) stale/overflow MIDI messages dropped") }
    }
}
