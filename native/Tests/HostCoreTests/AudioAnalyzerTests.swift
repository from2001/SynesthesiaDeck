import XCTest
@testable import HostCore

final class AudioAnalyzerTests: XCTestCase {
    private func run(_ analyzer: AudioAnalyzer, seconds: Double, start: Double = 0, signal: (Double) -> Float) -> [AnalyzedFrame] {
        let rate = 48000.0
        var frames: [AnalyzedFrame] = []
        for offset in stride(from: 0, to: Int(seconds * rate), by: 1600) {
            let count = min(1600, Int(seconds * rate) - offset)
            let pcm = (0 ..< count).map { signal(start + Double(offset + $0) / rate) }
            frames += analyzer.process(samples: pcm, sampleRate: rate, localTimestamp: (start + Double(offset) / rate) * 1000)
        }
        return frames
    }

    func testSilenceAndTimestampCadence() {
        let frames = run(AudioAnalyzer(), seconds: 2) { _ in 0 }
        XCTAssertEqual(frames.count, 59)
        XCTAssertEqual(frames[0].localTimestamp, 2048 / 48 / 2, accuracy: 0.0001)
        for (index, frame) in frames.enumerated() {
            XCTAssertEqual(frame.audio.level, 0)
            XCTAssertEqual(frame.audio.bpm, 0)
            XCTAssertEqual(frame.audio.beatPhase, 0)
            if index > 0 { XCTAssertEqual(frame.localTimestamp - frames[index - 1].localTimestamp, 1000 / 30, accuracy: 0.00001) }
        }
    }

    func testTonesSelectTheirBand() {
        for (frequency, expected) in [(80.0, 0), (300.0, 1), (1000.0, 2), (6000.0, 3)] {
            let frames = run(AudioAnalyzer(), seconds: 1) { Float(sin(2 * .pi * frequency * $0) * 0.5) }
            let audio = frames.last!.audio
            let bands = [audio.bass, audio.lowMid, audio.mid, audio.high]
            XCTAssertGreaterThan(bands[expected], 0.75, "Tone \(frequency) should energize its band")
            for index in bands.indices where index != expected { XCTAssertLessThan(bands[index], bands[expected] - 0.35, "Cross-band leakage for \(frequency): \(bands)") }
        }
    }

    func testAttackReleaseAndClippingAreFinite() {
        let analyzer = AudioAnalyzer()
        _ = run(analyzer, seconds: 0.3) { _ in 0 }
        let rising = run(analyzer, seconds: 0.3, start: 0.3) { Float(sin(2 * .pi * 1000 * $0) * 0.8) }
        XCTAssertLessThan(rising.first!.audio.level, rising.last!.audio.level)
        let falling = run(analyzer, seconds: 1.5, start: 0.6) { _ in 0 }
        XCTAssertGreaterThan(falling.first!.audio.level, 0.4)
        XCTAssertLessThan(falling.last!.audio.level, 0.005)
        let extremes = run(AudioAnalyzer(), seconds: 0.5) { Int($0 * 48000) % 3 == 0 ? .nan : 5 }
        XCTAssertTrue(extremes.allSatisfy { $0.audio.level.isFinite && (0 ... 1).contains($0.audio.level) })
    }

    func testTempoFixtureAndSilenceReacquisition() {
        let analyzer = AudioAnalyzer()
        let frames = run(analyzer, seconds: 9) { time in
            let phase = time.truncatingRemainder(dividingBy: 0.5)
            return Float(sin(2 * .pi * 100 * time) * (phase < 0.09 ? 0.8 * exp(-phase * 22) : 0))
        }
        let final = frames.last!.audio
        XCTAssertEqual(final.bpm, 120, accuracy: 4)
        XCTAssertGreaterThan(final.bpmConfidence, 0.7)
        XCTAssertTrue(frames.allSatisfy { (0 ..< 1).contains($0.audio.beatPhase) })
        XCTAssertGreaterThan(frames.filter { $0.audio.beat > 0.95 }.count, 12)
        let silence = run(analyzer, seconds: 4, start: 9) { _ in 0 }
        XCTAssertEqual(silence.last!.audio.bpm, 0)
        XCTAssertEqual(silence.last!.audio.bpmConfidence, 0)
        let restarted = run(analyzer, seconds: 8, start: 13) { time in
            let phase = (time - 13).truncatingRemainder(dividingBy: 2.0 / 3)
            return Float(sin(2 * .pi * 100 * time) * (phase < 0.09 ? 0.8 * exp(-phase * 22) : 0))
        }
        XCTAssertEqual(restarted.last!.audio.bpm, 90, accuracy: 4)
    }

    func testImpulseDiscontinuityAndSampleRateChanges() {
        let analyzer = AudioAnalyzer()
        let impulses = run(analyzer, seconds: 1) { Int($0 * 48000) == 4000 ? 1 : 0 }
        XCTAssertTrue(impulses.contains { $0.audio.level > 0.1 })
        let reset = analyzer.process(samples: [Float](repeating: 0, count: 4096), sampleRate: 44100, localTimestamp: 10000)
        XCTAssertGreaterThan(reset.first!.localTimestamp, 10000)
        XCTAssertEqual(reset.last!.audio.level, 0)
        XCTAssertTrue(analyzer.process(samples: [1], sampleRate: .nan, localTimestamp: 0).isEmpty)
    }
}
