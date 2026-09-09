import XCTest
@testable import HostCore

final class MIDITests: XCTestCase {
    func testPacketBoundariesRunningStatusAndRealtime() {
        var parser = MIDIParser()
        XCTAssertEqual(parser.consume([0xb2, 16]), [])
        let messages = parser.consume([0xf8, 127, 17, 0, 0x92, 60, 0])
        XCTAssertEqual(messages, [MIDIMessage(status: 0xb2, data1: 16, data2: 127), MIDIMessage(status: 0xb2, data1: 17, data2: 0), MIDIMessage(status: 0x92, data1: 60, data2: 0)])
        XCTAssertEqual(messages[0].channel, 3)
        XCTAssertTrue(messages[2].isRelease)
    }
    func testMalformedSystemExclusiveAndUnrelatedMessages() {
        var parser = MIDIParser()
        XCTAssertTrue(parser.consume([1, 2, 0xf0, 1, 2, 3, 0xf7, 20, 30, 0xc0, 10, 0xe0, 0, 64]).isEmpty)
        XCTAssertEqual(parser.consume([0xb0, 1, 0xb0, 7, 127]), [MIDIMessage(status: 0xb0, data1: 7, data2: 127)])
    }
    func testDefaultProfileCoverageAndLimits() throws {
        let profile = MIDIProfile.nanoKONTROL2()
        try profile.validate()
        XCTAssertEqual(profile.controls.count, 51)
        let mapper = MIDIMapper(profile: profile)
        for control in profile.controls {
            for value: UInt8 in [0, 127] {
                let input = MIDIMessage(status: 0xb0, data1: UInt8(control.number), data2: value)
                XCTAssertEqual(profile.map(input)!.value, Double(value) / 127)
                XCTAssertEqual(mapper.messages(for: input), [input])
            }
        }
        XCTAssertNil(profile.map(MIDIMessage(status: 0xb1, data1: 0, data2: 127)))
    }
    func testCustomNotesRangesAndHardwareToggleOff() throws {
        let json = """
        {"controls":[
          {"name":"fader1","channel":3,"kind":"cc","number":90,"minimum":20,"maximum":100,"behavior":"continuous"},
          {"name":"record1","channel":3,"kind":"note","number":60,"minimum":0,"maximum":127,"behavior":"toggle"}
        ]}
        """
        let profile = try JSONDecoder().decode(MIDIProfile.self, from: Data(json.utf8))
        try profile.validate()
        let mapper = MIDIMapper(profile: profile)
        XCTAssertEqual(mapper.messages(for: MIDIMessage(status: 0xb2, data1: 90, data2: 60))[0].data2, 64)
        let pulse = [MIDIMessage(status: 0xb0, data1: 64, data2: 127), MIDIMessage(status: 0xb0, data1: 64, data2: 0)]
        XCTAssertEqual(mapper.messages(for: MIDIMessage(status: 0x92, data1: 60, data2: 127)), pulse)
        XCTAssertTrue(mapper.messages(for: MIDIMessage(status: 0x92, data1: 60, data2: 127)).isEmpty)
        XCTAssertEqual(mapper.messages(for: MIDIMessage(status: 0x82, data1: 60, data2: 64)), pulse)
        XCTAssertEqual(mapper.messages(for: MIDIMessage(status: 0x92, data1: 60, data2: 127)), pulse)
        XCTAssertEqual(mapper.messages(for: MIDIMessage(status: 0x92, data1: 60, data2: 0)), pulse)
    }
    func testProfileRejectsDuplicateAndZeroRanges() throws {
        var profile = MIDIProfile.nanoKONTROL2()
        profile.controls.append(profile.controls[0])
        XCTAssertThrowsError(try profile.validate())
        profile = .nanoKONTROL2(); profile.controls[0].maximum = 0
        XCTAssertThrowsError(try profile.validate())
    }
}
