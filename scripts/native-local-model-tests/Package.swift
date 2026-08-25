// This package is a native-only executable seam. It uses injected byte/hash/pressure adapters so
// CI can exercise recovery without downloading or embedding the production GGUF.
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "AlyteLocalModelNativeTests",
  platforms: [.macOS(.v14)],
  products: [],
  targets: [
    .target(name: "AlyteLocalModelTestSupport"),
    .testTarget(name: "AlyteLocalModelNativeTests", dependencies: ["AlyteLocalModelTestSupport"]),
  ]
)
