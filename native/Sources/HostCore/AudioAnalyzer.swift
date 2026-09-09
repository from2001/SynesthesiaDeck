import Accelerate
import Foundation

public struct AudioFeatures: Codable, Sendable {
    public var level: Double = 0
    public var bass: Double = 0
    public var lowMid: Double = 0
    public var mid: Double = 0
    public var high: Double = 0
    public var beat: Double = 0
    public var beatPhase: Double = 0
    public var bpm: Double = 0
    public var bpmConfidence: Double = 0
    public init() {}
}

public struct AnalyzedFrame: Sendable {
    public var localTimestamp: Double
    public var audio: AudioFeatures
}

public struct AnalyzerConfiguration: Sendable {
    public var fftSize = 2048
    public var updateRate = 30.0
    public var attackSeconds = 0.035
    public var releaseSeconds = 0.22
    public var noiseFloorDB = -60.0
    public init() {}
}

/// Single-queue streaming analyzer. PCM and FFT storage never leave this process.
public final class AudioAnalyzer {
    public let configuration: AnalyzerConfiguration
    private let fft: FFTSetup
    private let logSize: vDSP_Length
    private var window: [Float]
    private var pending: [Float] = []
    private var pendingStart = 0.0
    private var rate = 0.0
    private var envelopes = [Double](repeating: 0, count: 5)
    private var previousEnergy = 0.0
    private var onsetBaseline = 0.0
    private var lastOnset: Double?
    private var intervals: [Double] = []
    private var bpm = 0.0
    private var confidence = 0.0
    private var beat = 0.0
    public private(set) var frameCount = 0
    public private(set) var analysisSeconds = 0.0

    public init(configuration: AnalyzerConfiguration = .init()) {
        precondition(configuration.fftSize >= 64 && configuration.fftSize.nonzeroBitCount == 1)
        precondition(configuration.updateRate > 0 && configuration.updateRate <= 240)
        precondition(configuration.attackSeconds > 0 && configuration.releaseSeconds > 0 && configuration.noiseFloorDB < 0)
        self.configuration = configuration
        logSize = vDSP_Length(log2(Double(configuration.fftSize)))
        fft = vDSP_create_fftsetup(logSize, FFTRadix(kFFTRadix2))!
        window = [Float](repeating: 0, count: configuration.fftSize)
        vDSP_hann_window(&window, vDSP_Length(configuration.fftSize), Int32(vDSP_HANN_NORM))
    }

    deinit { vDSP_destroy_fftsetup(fft) }

    public func reset() {
        pending.removeAll(keepingCapacity: true)
        envelopes = [Double](repeating: 0, count: 5)
        previousEnergy = 0; onsetBaseline = 0; lastOnset = nil
        intervals.removeAll(); bpm = 0; confidence = 0; beat = 0; rate = 0
    }

    /// Timestamp is the first PCM sample in local monotonic milliseconds.
    public func process(samples: [Float], sampleRate: Double, localTimestamp: Double) -> [AnalyzedFrame] {
        guard sampleRate.isFinite, sampleRate >= 8000, sampleRate <= 192000,
              localTimestamp.isFinite, !samples.isEmpty else { return [] }
        let expected = pendingStart + Double(pending.count) / max(rate, 1) * 1000
        if rate != sampleRate || (!pending.isEmpty && abs(localTimestamp - expected) > 100) {
            reset()
            rate = sampleRate
        }
        if pending.isEmpty { pendingStart = localTimestamp }
        // Sanitize out-of-range/NaN PCM before all DSP operations.
        pending.append(contentsOf: samples.map { $0.isFinite ? min(1, max(-1, $0)) : 0 })
        let hop = max(1, min(configuration.fftSize, Int(sampleRate / configuration.updateRate)))
        var result: [AnalyzedFrame] = []
        var consumed = 0
        while pending.count - consumed >= configuration.fftSize {
            let start = ProcessInfo.processInfo.systemUptime
            let block = Array(pending[consumed ..< consumed + configuration.fftSize])
            let timestamp = pendingStart + (Double(consumed) + Double(configuration.fftSize) / 2) / sampleRate * 1000
            result.append(AnalyzedFrame(localTimestamp: timestamp, audio: analyze(block, time: timestamp / 1000, dt: Double(hop) / sampleRate)))
            analysisSeconds += ProcessInfo.processInfo.systemUptime - start
            frameCount += 1
            consumed += hop
        }
        if consumed > 0 {
            pending.removeFirst(consumed)
            pendingStart += Double(consumed) / sampleRate * 1000
        }
        return result
    }

    private func normalize(_ rms: Double) -> Double {
        let db = 20 * log10(max(rms, 1e-12))
        return min(1, max(0, (db - configuration.noiseFloorDB) / -configuration.noiseFloorDB))
    }

    private func analyze(_ block: [Float], time: Double, dt: Double) -> AudioFeatures {
        let size = configuration.fftSize
        var rms: Float = 0
        vDSP_rmsqv(block, 1, &rms, vDSP_Length(size))
        var windowed = [Float](repeating: 0, count: size)
        vDSP_vmul(block, 1, window, 1, &windowed, 1, vDSP_Length(size))
        var real = [Float](repeating: 0, count: size / 2)
        var imag = real
        var power = real
        real.withUnsafeMutableBufferPointer { re in
            imag.withUnsafeMutableBufferPointer { im in
                var split = DSPSplitComplex(realp: re.baseAddress!, imagp: im.baseAddress!)
                windowed.withUnsafeBufferPointer { input in
                    input.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: size / 2) {
                        vDSP_ctoz($0, 2, &split, 1, vDSP_Length(size / 2))
                    }
                }
                vDSP_fft_zrip(fft, &split, 1, logSize, FFTDirection(FFT_FORWARD))
                // Packed bin 0 also stores Nyquist; neither belongs to our musical bands.
                re[0] = 0; im[0] = 0
                vDSP_zvmags(&split, 1, &power, 1, vDSP_Length(size / 2))
            }
        }
        // vDSP's real forward FFT is scaled by 2; Hann mean-square gain is 3/8.
        let scale = 1.0 / (2 * Double(size * size) * 0.375)
        let bands: [(Double, Double)] = [(20, 150), (150, 500), (500, 2000), (2000, 16000)]
        var targets = [normalize(Double(rms))]
        for (low, high) in bands {
            let lo = max(1, Int(ceil(low * Double(size) / rate)))
            let hi = min(size / 2, Int(ceil(high * Double(size) / rate)))
            let sum = lo < hi ? power[lo ..< hi].reduce(0.0) { $0 + Double($1) } : 0
            targets.append(normalize(sqrt(sum * scale)))
        }
        for i in envelopes.indices {
            let tau = targets[i] > envelopes[i] ? configuration.attackSeconds : configuration.releaseSeconds
            envelopes[i] += (targets[i] - envelopes[i]) * (1 - exp(-dt / tau))
        }
        let energy = Double(rms)
        let onset = max(0, energy - previousEnergy)
        let threshold = max(0.015, onsetBaseline * 2.8)
        if onset > threshold && energy > 0.02 && time - (lastOnset ?? -100) > 0.22 {
            if let last = lastOnset {
                let interval = time - last
                if interval >= 0.25 && interval <= 1.5 {
                    intervals.append(interval)
                    if intervals.count > 12 { intervals.removeFirst() }
                    let sorted = intervals.sorted()
                    let median = sorted[sorted.count / 2]
                    let matching = intervals.filter { abs($0 - median) < median * 0.12 }
                    confidence = min(1, Double(matching.count) / 6) * Double(matching.count) / Double(intervals.count)
                    if matching.count >= 3 { bpm = min(300, 60 / median) }
                } else {
                    intervals.removeAll(); bpm = 0; confidence = 0
                }
            }
            lastOnset = time
            beat = 1
        } else { beat *= exp(-dt / 0.09) }
        onsetBaseline += (onset - onsetBaseline) * (1 - exp(-dt / 1.5))
        previousEnergy = energy
        if time - (lastOnset ?? time) > 2.0 { confidence *= exp(-dt / 0.8) }
        if time - (lastOnset ?? time) > 3.0 { bpm = 0; confidence = 0; intervals.removeAll(); lastOnset = nil }
        var out = AudioFeatures()
        out.level = envelopes[0]; out.bass = envelopes[1]; out.lowMid = envelopes[2]
        out.mid = envelopes[3]; out.high = envelopes[4]; out.beat = beat
        out.bpm = bpm; out.bpmConfidence = bpm > 0 ? confidence : 0
        out.beatPhase = bpm > 0 ? max(0, (time - (lastOnset ?? time)) * bpm / 60).truncatingRemainder(dividingBy: 1) : 0
        return out
    }
}
