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
            chatTemplate: "gemma4-v1",
            promptBundleVersion: "alyte.gemma4-e2b-evaluation.prompt.v2"
        )
        XCTAssertTrue(prompt.hasPrefix("<bos><|turn>system\n"))
        XCTAssertTrue(prompt.contains("<|turn>user\nSchema version: alyte.semantic-mapper.v1. Locale: de."))
        XCTAssertTrue(prompt.hasSuffix("<|turn>model\n"))
        XCTAssertFalse(prompt.contains("<|im_start|>"))
        XCTAssertFalse(prompt.contains("<think>"))
        XCTAssertTrue(prompt.contains("For each unambiguous physical measurement row, emit exactly one proposal."))
        XCTAssertTrue(prompt.contains("Combine all relevant source observation IDs/cells from that row"))
        XCTAssertTrue(prompt.contains("Never emit separate proposals for label, value, unit, or range cells"))
        XCTAssertTrue(prompt.contains("omit that row rather than duplicate-consuming any source row"))
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

    func testGemmaContractRequiresTheExactPairedCandidateIdentity() throws {
        let valid = syntheticContract(candidate: "gemma4")
        XCTAssertNoThrow(try valid.validate())

        XCTAssertThrowsError(
            try syntheticContract(candidate: "gemma4", modelRepository: "ggml-org/other-GGUF").validate()
        )
        XCTAssertThrowsError(
            try syntheticContract(
                candidate: "gemma4",
                sourceModelRevision: "0000000000000000000000000000000000000000"
            ).validate()
        )
        XCTAssertThrowsError(
            try syntheticContract(
                candidate: "gemma4",
                runtimeRevision: "0000000000000000000000000000000000000000"
            ).validate()
        )
        XCTAssertThrowsError(
            try syntheticContract(
                candidate: "gemma4",
                promptBundleVersion: "alyte.gemma4-e2b-evaluation.prompt.v1"
            ).validate()
        )
        XCTAssertThrowsError(
            try syntheticContract(candidate: "gemma4", chatTemplateSource: "unreviewed-template").validate()
        )
    }

    func testQwenContractIdentityRemainsValidWithoutAnUpstreamSourcePin() throws {
        XCTAssertNoThrow(try syntheticContract(candidate: "qwen").validate())
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

private func syntheticContract(
    candidate: String,
    modelRepository: String? = nil,
    sourceModelRevision: String? = nil,
    runtimeRevision: String? = nil,
    chatTemplateSource: String? = nil,
    promptBundleVersion: String? = nil
) -> EvaluationContract {
    let isGemma = candidate == "gemma4"
    let languageCodes = ["en", "de", "lt", "pl", "fr", "es"]
    let fixtures = languageCodes.map { language in
        let observations = (0..<8).map { index in
            CanonicalObservation(
                id: "\(language)-observation-\(index)",
                rowId: index < 4 ? "\(language)-row-0" : "\(language)-row-1",
                text: "synthetic",
                alternatives: [],
                pageIndex: 0,
                locale: language,
                specimenType: "serum"
            )
        }
        let facts = CanonicalSourceFacts(valueString: "1", unit: "mg/dL", referenceInterval: "0–2")
        let expected = [
            CanonicalExpectedRow(
                rowId: "\(language)-row-0",
                sourceObservationIds: ["\(language)-observation-0"],
                sourceFactObservationIds: ["\(language)-observation-0"],
                biomarkerId: "biomarker.ldl_c",
                role: "primary",
                specimenType: "serum",
                sourceFacts: facts
            ),
            CanonicalExpectedRow(
                rowId: "\(language)-row-1",
                sourceObservationIds: ["\(language)-observation-4"],
                sourceFactObservationIds: ["\(language)-observation-4"],
                biomarkerId: "biomarker.hdl_c",
                role: "primary",
                specimenType: "serum",
                sourceFacts: facts
            ),
        ]
        return CanonicalFixture(
            id: "synthetic-\(language)",
            language: language,
            serializedInput: "{\"version\":\"alyte.semantic-ocr-chunk.v1\"}",
            observations: observations,
            expected: expected
        )
    }
    return EvaluationContract(
        contractVersion: isGemma ? "alyte.gemma4-e2b-evaluation.contract.v1" : "alyte.qwen-evaluation.contract.v1",
        manifestVersion: isGemma ? "alyte.gemma4-e2b-evaluation.manifest.v1" : "alyte.qwen-evaluation.manifest.v1",
        promptBundleVersion: isGemma
            ? (promptBundleVersion ?? "alyte.gemma4-e2b-evaluation.prompt.v2")
            : nil,
        fixtureVersion: "alyte.qwen-evaluation-fixtures.v1",
        schemaVersion: "alyte.semantic-mapper.v1",
        catalogueVersion: "synthetic-catalogue",
        catalogueSchemaVersion: "synthetic-catalogue-schema",
        model: CanonicalModelProvenance(
            repository: modelRepository ?? (isGemma ? "ggml-org/gemma-4-E2B-it-GGUF" : "ggml-org/Qwen3.5-0.8B-GGUF"),
            revision: isGemma ? "b4243c156154b6dca9324415f8c7ccc098b4aed1" : "8fea620810c4afa23dd6443f999a48574c1611a3",
            filename: isGemma ? "gemma-4-E2B-it-Q4_0.gguf" : "Qwen3.5-0.8B-Q4_0.gguf",
            sha256: isGemma ? "8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52" : "57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf"
        ),
        sourceModel: isGemma
            ? CanonicalSourceModelProvenance(
                id: "gemma-4-e2b-it",
                repository: "google/gemma-4-E2B-it",
                revision: sourceModelRevision ?? "3e22461f65e89153144f8adb70e3b8c2cc9845a7"
            )
            : nil,
        runtime: CanonicalRuntimeProvenance(
            repository: "ggml-org/llama.cpp",
            release: "v0.2.0",
            revision: runtimeRevision ?? "bb4caa7540188872173c44d161602d9271386413"
        ),
        thinking: false,
        grammar: "root ::= object",
        grammarRoot: "root",
        maxInputBytes: 8192,
        maxOutputBytes: 16384,
        maxProposals: 24,
        chatTemplate: isGemma ? "gemma4-v1" : nil,
        chatTemplateSource: isGemma
            ? (chatTemplateSource ?? "explicit-pinned-google-gemma-4-template-v1")
            : nil,
        allowedBiomarkerIds: ["biomarker.hdl_c", "biomarker.ldl_c"],
        biomarkerCatalogue: [
            CanonicalBiomarker(id: "biomarker.hdl_c", specimens: ["serum"], specimenCompatibility: nil),
            CanonicalBiomarker(id: "biomarker.ldl_c", specimens: ["serum"], specimenCompatibility: nil),
        ],
        fixtures: fixtures
    )
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
