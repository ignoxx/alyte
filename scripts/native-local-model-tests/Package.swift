// This package compiles the production lifecycle core itself. Tests inject tiny bytes, hash,
// protection, transport, and runtime seams; no model weights are downloaded or embedded.
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "AlyteLocalModelNativeTests",
  platforms: [.macOS(.v14)],
  products: [],
  targets: [
    .target(
      name: "AlyteLocalModelProductionCore",
      path: "Sources/AlyteLocalModelProductionCore",
      sources: [
        "AlyteLocalModelCore.swift",
        "AlyteLocalModelManifest.swift",
        "AlyteLocalModelTypes.swift",
      ]
    ),
    .testTarget(name: "AlyteLocalModelNativeTests", dependencies: ["AlyteLocalModelProductionCore"]),
  ]
)
