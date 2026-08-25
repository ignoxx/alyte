// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AlyteModelEvaluation",
    platforms: [
        .iOS(.v26),
        .macOS(.v15),
    ],
    products: [
        .library(name: "AlyteModelEvaluation", targets: ["AlyteModelEvaluation"]),
    ],
    targets: [
        .target(
            name: "AlyteLlamaShim",
            path: "Sources/AlyteModelEvaluation",
            sources: ["AlyteLlamaShim.c"],
            publicHeadersPath: "."
        ),
        .target(
            name: "AlyteModelEvaluation",
            dependencies: ["AlyteLlamaShim"],
            path: "Sources/AlyteModelEvaluation",
            exclude: ["AlyteLlamaShim.c", "AlyteLlamaShim.h", "AlyteLlamaShim.m"]
        ),
        .testTarget(name: "AlyteModelEvaluationTests", dependencies: ["AlyteModelEvaluation"]),
    ]
)
