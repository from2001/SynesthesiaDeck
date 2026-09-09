import XCTest
@testable import HostCore

final class BridgeTests: XCTestCase {
    func testIngressRemainsBoundedWhenBridgeIsStopped() throws {
        let bridge = FeatureBridge(configuration: try BridgeConfiguration(baseURL: "http://127.0.0.1:8788", token: "test-only"))
        for _ in 0 ..< 1000 { bridge.submitMIDI(MIDIMessage(status: 0xb0, data1: 0, data2: 127), localTimestamp: monotonicMilliseconds()) }
        XCTAssertEqual(bridge.droppedMIDI, 872)
    }
    func testMidpointClockAndEpochReset() {
        var clock = ClockMapping()
        XCTAssertTrue(clock.observe(epoch: "first", serverTime: 500, localBefore: 1000, localAfter: 1010))
        XCTAssertEqual(clock.masterTime(1005), 500)
        XCTAssertEqual(clock.roundTrip, 10)
        XCTAssertFalse(clock.observe(epoch: "bad", serverTime: 0, localBefore: 0, localAfter: 1000))
        XCTAssertEqual(clock.epoch, "first")
        XCTAssertTrue(clock.observe(epoch: "second", serverTime: 10, localBefore: 100000, localAfter: 100004))
        XCTAssertEqual(clock.masterTime(100002), 10)
        XCTAssertEqual(clock.epoch, "second")
        XCTAssertFalse(clock.observe(epoch: "", serverTime: .nan, localBefore: 0, localAfter: 1))
    }
    func testBridgeRestrictsOriginAndRequiresCredentials() throws {
        for origin in ["https://example.org", "http://192.168.1.2:8788", "http://localhost.evil:8788", "http://a@localhost:8788", "http://localhost:8788/path", "http://localhost:8788?token=secret"] {
            XCTAssertThrowsError(try BridgeConfiguration(baseURL: origin, token: "test-only"))
        }
        for origin in ["http://127.0.0.1:8788", "http://localhost:8788", "http://[::1]:8788"] {
            XCTAssertNoThrow(try BridgeConfiguration(baseURL: origin, token: "test-only"))
        }
        XCTAssertThrowsError(try BridgeConfiguration(baseURL: "http://127.0.0.1:8788", token: ""))
    }
}
