// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "AlyteProtectionNativeTests",
  platforms: [.iOS(.v16)],
  products: [
    .library(name: "AlyteProtection", targets: ["AlyteProtection"]),
  ],
  dependencies: [
    .package(
      url: "https://github.com/weichsel/ZIPFoundation.git",
      exact: "0.9.20"
    ),
  ],
  targets: [
    .target(
      name: "AlyteProtection",
      dependencies: [
        .product(name: "ZIPFoundation", package: "ZIPFoundation"),
      ],
      sources: [
        "AlyteProtectionArchive.swift",
        "AlyteProtectionFilePolicy.swift",
        "AlyteProtectionSnapshotShield.swift",
        "AlyteDeviceCrypto.swift",
      ]
    ),
    .testTarget(
      name: "AlyteProtectionTests",
      dependencies: ["AlyteProtection"],
      sources: [
        "AlyteProtectionArchiveTests.swift",
        "AlyteProtectionFilePolicyTests.swift",
        "AlyteProtectionSnapshotShieldTests.swift",
        "AlyteDeviceCryptoTests.swift",
      ],
      resources: [
        .copy("cloud-result-envelope-v1.json"),
      ]
    ),
  ]
)
