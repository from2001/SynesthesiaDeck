import XCTest
@testable import HostCore

final class CaptureWatchdogTests: XCTestCase {
    func testMissingFirstBufferFailsOnceAtStartupDeadline() {
        var watchdog = CaptureWatchdog()
        watchdog.start(at: 100)
        XCTAssertNil(watchdog.poll(at: 3099))
        XCTAssertEqual(watchdog.poll(at: 3100), .noSamples)
        XCTAssertTrue(watchdog.needsRestart)
        XCTAssertNil(watchdog.poll(at: 10000))
    }

    func testDeliveredBuffersKeepCaptureHealthyIndependentlyOfSignalLevel() {
        var watchdog = CaptureWatchdog()
        watchdog.start(at: 0)
        // Every valid buffer counts, including PCM whose samples are all zero.
        for time in stride(from: 100.0, through: 10000.0, by: 100) {
            XCTAssertNil(watchdog.poll(at: time))
            XCTAssertTrue(watchdog.receivedSamples(at: time))
        }
        XCTAssertFalse(watchdog.needsRestart)
        XCTAssertNil(watchdog.poll(at: 10999))
    }

    func testStallUsesLastDeliveryAndRejectsLateCallbacks() {
        var watchdog = CaptureWatchdog()
        watchdog.start(at: 0)
        XCTAssertTrue(watchdog.receivedSamples(at: 500))
        XCTAssertNil(watchdog.poll(at: 1499))
        XCTAssertEqual(watchdog.poll(at: 1500), .stalled)
        XCTAssertFalse(watchdog.receivedSamples(at: 1501))
        XCTAssertTrue(watchdog.needsRestart)
        XCTAssertFalse(watchdog.acceptsSamples)
        XCTAssertNil(watchdog.poll(at: 3000))
    }

    func testRestartClearsFailureAndTracksNewBufferDelivery() {
        var watchdog = CaptureWatchdog()
        watchdog.start(at: 0)
        XCTAssertEqual(watchdog.poll(at: 3000), .noSamples)
        watchdog.start(at: 5000)
        XCTAssertFalse(watchdog.needsRestart)
        XCTAssertNil(watchdog.poll(at: 7999))
        XCTAssertTrue(watchdog.receivedSamples(at: 7999))
        XCTAssertNil(watchdog.poll(at: 8998))
        XCTAssertEqual(watchdog.poll(at: 8999), .stalled)
    }

    func testCaptureErrorLatchesUntilRestart() {
        var watchdog = CaptureWatchdog()
        watchdog.start(at: 0)
        XCTAssertTrue(watchdog.receivedSamples(at: 100))
        XCTAssertTrue(watchdog.fail())
        XCTAssertFalse(watchdog.fail())
        XCTAssertFalse(watchdog.receivedSamples(at: 101))
        XCTAssertNil(watchdog.poll(at: 5000))
        watchdog.start(at: 6000)
        XCTAssertTrue(watchdog.receivedSamples(at: 6001))
        XCTAssertFalse(watchdog.needsRestart)
    }

    func testStopDisarmsFailureAndRejectsCallbacks() {
        var watchdog = CaptureWatchdog()
        watchdog.start(at: 0)
        XCTAssertTrue(watchdog.fail())
        watchdog.stop()
        XCTAssertFalse(watchdog.needsRestart)
        XCTAssertFalse(watchdog.acceptsSamples)
        XCTAssertFalse(watchdog.receivedSamples(at: 100))
        XCTAssertFalse(watchdog.fail())
        XCTAssertNil(watchdog.poll(at: 100000))
    }
}
