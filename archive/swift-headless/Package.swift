// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Habitab",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "habitab", targets: ["habitab"]),
        .executable(name: "HabitabApp", targets: ["HabitabApp"]),
    ],
    targets: [
        .target(
            name: "HabitabCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "habitab",
            dependencies: ["HabitabCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "HabitabApp",
            dependencies: ["HabitabCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "habitab-selftest",
            dependencies: ["HabitabCore"],
            path: "Tests/SelfTest",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
