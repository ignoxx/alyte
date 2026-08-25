import XCTest
@testable import AlyteModelEvaluation

final class MetricRecorderTests: XCTestCase {
    func testRecorderProducesAggregateOnlyLatencyMemoryAndThermalMetrics() {
        var recorder = EvaluationMetricRecorder()
        recorder.beginColdLoad()
        recorder.endColdLoad()
        let start = EvaluationMetricRecorder.clockNanoseconds()
        recorder.recordWarmInference(startNanoseconds: start, endNanoseconds: start + 10_000_000)
        recorder.recordWarmInference(startNanoseconds: start, endNanoseconds: start + 20_000_000)

        let snapshot = recorder.snapshot(
            deviceClass: "current",
            deviceModel: "synthetic-test-device",
            osVersion: "26.0",
            packBytes: 563_036_064,
            runtimeBytes: 1_024
        )
        XCTAssertEqual(snapshot.deviceClass, "current")
        XCTAssertEqual(snapshot.warmInferenceMsP50 ?? -1, 10, accuracy: 0.001)
        XCTAssertEqual(snapshot.warmInferenceMsP95 ?? -1, 20, accuracy: 0.001)
        XCTAssertEqual(snapshot.packBytes, 563_036_064)
        XCTAssertNotNil(snapshot.thermalState)
    }

    func testWriterUsesSortedAggregateJsonOnly() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-eval-aggregate.json")
        defer { try? FileManager.default.removeItem(at: url) }
        try AggregateReportWriter.write(AggregateFixture(warmInferenceMsP50: 12), to: url)
        let data = try Data(contentsOf: url)
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("{"))
        XCTAssertTrue(text.contains("warmInferenceMsP50"))
    }

    func testNativeRunnerRequiresTheExternalPinnedRuntime() {
        XCTAssertFalse(LlamaCppRuntimeBridge.isFrameworkLinked)
        XCTAssertThrowsError(
            try LlamaCppRuntimeSession(
                modelURL: URL(fileURLWithPath: "/external/Qwen3.5-0.8B-Q4_0.gguf"),
                grammar: NativeEvaluationRunner.grammar,
                grammarRoot: "root",
                contextTokens: 2_048,
                batchTokens: 256,
                threads: 2
            )
        ) { error in
            XCTAssertEqual(error as? LlamaCppRuntimeError, .unavailable)
        }
    }

    func testPinnedRuntimeEvaluationWritesAggregateOnlyWhenStaged() throws {
        guard let modelPath = ProcessInfo.processInfo.environment["ALYTE_MODEL_EVAL_MODEL_PATH"],
              let aggregatePath = ProcessInfo.processInfo.environment["ALYTE_MODEL_EVAL_AGGREGATE_PATH"] else {
            return
        }
        guard LlamaCppRuntimeBridge.isFrameworkLinked else {
            throw XCTSkip("the pinned llama.cpp XCFramework is not linked")
        }
        let modelURL = URL(fileURLWithPath: modelPath)
        let runtimePath = ProcessInfo.processInfo.environment["ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK"] ?? ""
        let report = try NativeEvaluationRunner.run(
            modelURL: modelURL,
            packBytes: fileSize(modelURL),
            runtimeBytes: directorySize(URL(fileURLWithPath: runtimePath)),
            deviceClass: ProcessInfo.processInfo.environment["ALYTE_MODEL_EVAL_DEVICE_CLASS"] ?? "paired",
            deviceModel: ProcessInfo.processInfo.environment["ALYTE_MODEL_EVAL_DEVICE_MODEL"] ?? "unknown",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString
        )
        try AggregateReportWriter.write(report, to: URL(fileURLWithPath: aggregatePath))
        XCTAssertEqual(report.fixtureCount, 6)
        XCTAssertLessThanOrEqual(report.schemaFailureCount + report.acceptedProposalCount, 24 * 6)
    }
}

private struct AggregateFixture: Codable {
    let warmInferenceMsP50: Int
}

private func fileSize(_ url: URL) -> UInt64 {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? UInt64) ?? 0
}

private func directorySize(_ url: URL) -> UInt64 {
    guard let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else {
        return 0
    }
    return enumerator.compactMap { item -> UInt64? in
        guard let fileURL = item as? URL,
              let values = try? fileURL.resourceValues(forKeys: [.fileSizeKey]),
              let size = values.fileSize else { return nil }
        return UInt64(size)
    }.reduce(0, +)
}
