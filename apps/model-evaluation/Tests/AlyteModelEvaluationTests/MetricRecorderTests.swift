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
        guard !LlamaCppRuntimeBridge.isFrameworkLinked else { return }
        XCTAssertFalse(LlamaCppRuntimeBridge.isFrameworkLinked)
        XCTAssertThrowsError(
            try LlamaCppRuntimeSession(
                modelURL: URL(fileURLWithPath: "/external/Qwen3.5-0.8B-Q4_0.gguf"),
                grammar: "",
                grammarRoot: "root",
                contextTokens: 2_048,
                batchTokens: 256,
                threads: 2
            )
        ) { error in
            XCTAssertEqual(error as? LlamaCppRuntimeError, .unavailable)
        }
    }

    func testNativeGenerationFailureMappingKeepsOnlyBoundedStatus() {
        XCTAssertEqual(
            LlamaCppRuntimeError.nativeGenerationError(for: -4),
            .tokenizationFailed
        )
        XCTAssertEqual(
            LlamaCppRuntimeError.nativeGenerationError(for: -5),
            .promptDecodeFailed
        )
        XCTAssertEqual(
            LlamaCppRuntimeError.nativeGenerationError(for: -6),
            .tokenDecodeFailed
        )
        XCTAssertEqual(
            LlamaCppRuntimeError.nativeGenerationError(for: -99),
            .inferenceFailed(status: -99)
        )
    }

    func testGemma4PromptUsesThePinnedTurnTemplateWithoutThinkingMarkers() {
        let fixture = CanonicalFixture(
            id: "synthetic-gemma",
            language: "de",
            serializedInput: "{\"version\":\"alyte.semantic-ocr-chunk.v1\"}",
            observations: [],
            expected: []
        )
        let prompt = EvaluationPrompt.render(
            fixture: fixture,
            schemaVersion: "alyte.semantic-mapper.v1",
            chatTemplate: "gemma4-v1"
        )
        XCTAssertTrue(prompt.hasPrefix("<bos><|turn>system\n"))
        XCTAssertTrue(prompt.contains("<|turn>user\nSchema version: alyte.semantic-mapper.v1. Locale: de."))
        XCTAssertTrue(prompt.hasSuffix("<|turn>model\n"))
        XCTAssertFalse(prompt.contains("<|im_start|>"))
        XCTAssertFalse(prompt.contains("<think>"))
    }

    func testQwenPromptPathRetainsTheExistingChatMLTemplate() {
        let fixture = CanonicalFixture(
            id: "synthetic-qwen",
            language: "en",
            serializedInput: "{\"version\":\"alyte.semantic-ocr-chunk.v1\"}",
            observations: [],
            expected: []
        )
        let prompt = EvaluationPrompt.render(
            fixture: fixture,
            schemaVersion: "alyte.semantic-mapper.v1",
            chatTemplate: nil
        )
        XCTAssertTrue(prompt.contains("<|im_start|>system"))
        XCTAssertTrue(prompt.contains("<|im_start|>assistant"))
        XCTAssertTrue(prompt.contains("<think>"))
        XCTAssertFalse(prompt.contains("<|turn>"))
    }

    func testPinnedRuntimeEvaluationWritesAggregateOnlyWhenStaged() throws {
        guard configuredValue("ALYTE_MODEL_EVAL_DEVICE_RUN") == "1" else {
            return
        }
        guard let modelPath = configuredValue("ALYTE_MODEL_EVAL_MODEL_PATH"),
              let aggregatePath = configuredValue("ALYTE_MODEL_EVAL_AGGREGATE_PATH") else {
            XCTFail("device mode requires container-relative model and aggregate paths")
            return
        }
        guard LlamaCppRuntimeBridge.isFrameworkLinked else {
            XCTFail("device mode requires the pinned llama.cpp XCFramework")
            return
        }
        guard let contractURL = Bundle(for: MetricRecorderTests.self).url(
            forResource: "evaluation-contract-v1",
            withExtension: "json"
        ) else {
            XCTFail("canonical evaluation contract resource is missing")
            return
        }
        let modelURL: URL
        let aggregateURL: URL
        do {
            modelURL = try applicationSupportURL(for: modelPath)
            aggregateURL = try applicationSupportURL(for: aggregatePath)
        } catch {
            XCTFail("device mode paths must resolve inside the app data container: \(error)")
            return
        }
        let runtimeBytes = embeddedRuntimeBytes()
        guard runtimeBytes > 0 else {
            XCTFail("pinned llama.cpp framework is not embedded in the evaluator app")
            return
        }
        let report = try NativeEvaluationRunner.run(
            modelURL: modelURL,
            contractURL: contractURL,
            packBytes: fileSize(modelURL),
            runtimeBytes: runtimeBytes,
            deviceClass: configuredValue("ALYTE_MODEL_EVAL_DEVICE_CLASS") ?? "paired",
            deviceModel: configuredValue("ALYTE_MODEL_EVAL_DEVICE_MODEL") ?? "unknown",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString
        )
        try FileManager.default.createDirectory(
            at: aggregateURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try AggregateReportWriter.write(report, to: aggregateURL)
        XCTAssertEqual(report.fixtureCount, 6)
        XCTAssertEqual(report.expectedRowCount, 12)
        XCTAssertLessThanOrEqual(report.schemaFailureCount + report.acceptedProposalCount, 24 * 6)
    }
}

private func configuredValue(_ key: String) -> String? {
    if let value = ProcessInfo.processInfo.environment[key], !value.isEmpty {
        return value
    }
    return Bundle(for: MetricRecorderTests.self).object(forInfoDictionaryKey: key) as? String
}

private func applicationSupportURL(for relativePath: String) throws -> URL {
    guard !relativePath.isEmpty, !relativePath.hasPrefix("/") else {
        throw NSError(domain: "AlyteModelEvaluationTests", code: 1)
    }
    guard let applicationSupport = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
    ).first else {
        throw NSError(domain: "AlyteModelEvaluationTests", code: 2)
    }
    let root = applicationSupport.standardizedFileURL
    let candidate = root.appendingPathComponent(relativePath).standardizedFileURL
    guard candidate.path == root.path || candidate.path.hasPrefix(root.path + "/") else {
        throw NSError(domain: "AlyteModelEvaluationTests", code: 3)
    }
    return candidate
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

private func embeddedRuntimeBytes() -> UInt64 {
    let appBundle = Bundle(identifier: "com.alyte.model-evaluation") ?? Bundle.main
    guard let frameworks = appBundle.privateFrameworksURL else {
        return 0
    }
    return directorySize(frameworks.appendingPathComponent("llama.framework"))
}
