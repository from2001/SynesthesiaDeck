import AudioToolbox
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

public final class AudioPipeline: @unchecked Sendable {
    private let queue = DispatchQueue(label: "show.audio.analysis", qos: .userInitiated)
    private let slots = DispatchSemaphore(value: 8)
    private let analyzer: AudioAnalyzer
    private var timer: DispatchSourceTimer?
    private var nextSampleTime: Double?
    private var lastSampleRate = 48000.0
    private let onFrame: @Sendable (AnalyzedFrame) -> Void
    public init(configuration: AnalyzerConfiguration = .init(), onFrame: @escaping @Sendable (AnalyzedFrame) -> Void) {
        analyzer = AudioAnalyzer(configuration: configuration); self.onFrame = onFrame
    }
    public func startSilenceWatchdog() {
        self.timer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.1, repeating: 1.0 / 30)
        timer.setEventHandler { [weak self] in
            guard let self, let next = self.nextSampleTime, monotonicMilliseconds() - next > 70 else { return }
            let count = Int(self.lastSampleRate / 30)
            self.analyze([Float](repeating: 0, count: count), rate: self.lastSampleRate, time: next)
        }
        self.timer = timer; timer.resume()
    }
    public func submit(_ samples: [Float], rate: Double, time: Double) {
        guard samples.count <= 16384, slots.wait(timeout: .now()) == .success else { return }
        queue.async {
            defer { self.slots.signal() }
            self.analyze(samples, rate: rate, time: time)
        }
    }
    private func analyze(_ samples: [Float], rate: Double, time: Double) {
        lastSampleRate = rate
        nextSampleTime = time + Double(samples.count) / rate * 1000
        for frame in analyzer.process(samples: samples, sampleRate: rate, localTimestamp: time) { onFrame(frame) }
    }
    public func stop() -> (frames: Int, seconds: Double) {
        timer?.cancel(); timer = nil
        return queue.sync { (analyzer.frameCount, analyzer.analysisSeconds) }
    }
}

public final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private var stream: SCStream?
    private let callbackQueue = DispatchQueue(label: "show.audio.capture", qos: .userInitiated)
    private let pipeline: AudioPipeline
    private let onStatus: @Sendable (String, String) -> Void
    private var reportedFormat = false
    public init(pipeline: AudioPipeline, onStatus: @escaping @Sendable (String, String) -> Void) {
        self.pipeline = pipeline; self.onStatus = onStatus
    }
    public static var hasPermission: Bool { CGPreflightScreenCaptureAccess() }

    public func start(displayID: UInt32? = nil, excludedBundleIDs: [String] = []) async throws {
        guard Self.hasPermission else {
            throw HostError.message("System audio capture permission is unavailable. In System Settings > Privacy & Security > Screen & System Audio Recording, authorize the terminal/host app, restart it, and retry --capture. This command never opens the permission prompt.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = displayID == nil ? content.displays.first : content.displays.first(where: { $0.displayID == displayID }) else {
            throw HostError.message("No matching display is available for ScreenCaptureKit. Use --list-displays after granting permission.")
        }
        let excluded = content.applications.filter { excludedBundleIDs.contains($0.bundleIdentifier) }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48000
        configuration.channelCount = 2
        // No screen output is registered; minimal video dimensions reduce unused capture work.
        configuration.width = 2; configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.queueDepth = 3
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: callbackQueue)
        self.stream = stream
        try await stream.startCapture()
        pipeline.startSilenceWatchdog()
        onStatus("running", "ScreenCaptureKit display \(display.displayID); 48 kHz stereo; system output only")
    }

    public func stop() async {
        if let stream { try? await stream.stopCapture() }
        stream = nil
        onStatus("stopped", "System capture stopped")
    }
    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStatus("error", "ScreenCaptureKit stopped: \(error.localizedDescription). The host will retry capture.")
    }
    public func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, buffer.isValid, CMSampleBufferDataIsReady(buffer),
              let format = CMSampleBufferGetFormatDescription(buffer), let description = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { return }
        let asbd = description.pointee
        guard asbd.mFormatID == kAudioFormatLinearPCM, asbd.mSampleRate > 0 else {
            onStatus("error", "Unsupported system audio format; linear PCM is required"); return
        }
        let frames = CMSampleBufferGetNumSamples(buffer)
        guard frames > 0, frames <= 16384 else { return }
        var required = 0
        var block: CMBlockBuffer?
        _ = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: &required, bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, blockBufferOut: nil)
        guard required > 0, required <= 65536 else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: required, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        let result = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: required, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault, flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &block)
        guard result == noErr else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        let float = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let bigEndian = asbd.mFormatFlags & kAudioFormatFlagIsBigEndian != 0
        let bits = Int(asbd.mBitsPerChannel)
        guard !bigEndian, (float && [32, 64].contains(bits)) || (!float && [16, 32].contains(bits) && asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0) else {
            onStatus("error", "Unsupported PCM encoding; expected little-endian float32/64 or signed int16/32"); return
        }
        var mono = [Float](repeating: 0, count: frames)
        var channels = 0
        for audio in buffers {
            guard let data = audio.mData, audio.mNumberChannels > 0 else { continue }
            let count = Int(audio.mNumberChannels)
            guard frames * count * bits / 8 <= Int(audio.mDataByteSize) else { continue }
            channels += count
            for frame in 0 ..< frames {
                for channel in 0 ..< count {
                    let index = frame * count + channel
                    let value: Float
                    if float && bits == 32 { value = data.assumingMemoryBound(to: Float.self)[index] }
                    else if float { value = Float(data.assumingMemoryBound(to: Double.self)[index]) }
                    else if bits == 16 { value = Float(data.assumingMemoryBound(to: Int16.self)[index]) / 32768 }
                    else { value = Float(data.assumingMemoryBound(to: Int32.self)[index]) / 2147483648 }
                    mono[frame] += value.isFinite ? value : 0
                }
            }
        }
        guard channels > 0 else { return }
        for i in mono.indices { mono[i] /= Float(channels) }
        let pts = CMSampleBufferGetPresentationTimeStamp(buffer).seconds
        let hostNow = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        let sampleTime = pts.isFinite ? monotonicMilliseconds() + (pts - hostNow) * 1000 : monotonicMilliseconds() - Double(frames) / asbd.mSampleRate * 1000
        if !reportedFormat {
            reportedFormat = true
            hostLog("System audio format: \(Int(asbd.mSampleRate)) Hz, \(channels) channels, \(float ? "float" : "int")\(bits), \(buffers.count) buffers; timestamp source: host-clock PTS")
        }
        pipeline.submit(mono, rate: asbd.mSampleRate, time: sampleTime)
    }
}
