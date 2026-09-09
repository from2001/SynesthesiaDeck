// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NanoKonHost",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "nanokon-host", targets: ["NanoKonHost"]), .library(name: "HostCore", targets: ["HostCore"])],
    targets: [
        .target(name: "HostCore"),
        .executableTarget(name: "NanoKonHost", dependencies: ["HostCore"]),
        .testTarget(name: "HostCoreTests", dependencies: ["HostCore"])
    ],
    swiftLanguageModes: [.v5]
)
