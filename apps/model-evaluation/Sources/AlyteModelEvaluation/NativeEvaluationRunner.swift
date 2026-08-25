import Foundation

public struct NativeEvaluationReport: Codable, Equatable, Sendable {
    public let manifestVersion: String
    public let promptBundleVersion: String?
    public let modelRepository: String
    public let modelRevision: String
    public let modelFilename: String
    public let modelSha256: String
    public let sourceModelId: String?
    public let sourceModelRepository: String?
    public let sourceModelRevision: String?
    public let runtimeRepository: String
    public let runtimeRelease: String
    public let runtimeRevision: String
    public let fixtureVersion: String
    public let schemaVersion: String
    public let thinking: Bool
    public let chatTemplate: String?
    public let chatTemplateSource: String?
    public let fixtureCount: Int
    public let expectedRowCount: Int
    public let modelReferencedRowCount: Int
    public let modelRecall: Double
    public let acceptedProposalCount: Int
    public let acceptedCorrectProposalCount: Int
    public let acceptedEndToEndPrecision: Double
    public let sourceFactsPreservedCount: Int
    public let schemaFailureCount: Int
    public let reviewBurden: Int
    public let failureCounts: [String: Int]
    public let deviceMetrics: DeviceMetricSnapshot

    public init(
        manifestVersion: String,
        promptBundleVersion: String?,
        modelRepository: String,
        modelRevision: String,
        modelFilename: String,
        modelSha256: String,
        sourceModelId: String?,
        sourceModelRepository: String?,
        sourceModelRevision: String?,
        runtimeRepository: String,
        runtimeRelease: String,
        runtimeRevision: String,
        fixtureVersion: String,
        schemaVersion: String,
        thinking: Bool,
        chatTemplate: String?,
        chatTemplateSource: String?,
        fixtureCount: Int,
        expectedRowCount: Int,
        modelReferencedRowCount: Int,
        modelRecall: Double,
        acceptedProposalCount: Int,
        acceptedCorrectProposalCount: Int,
        acceptedEndToEndPrecision: Double,
        sourceFactsPreservedCount: Int,
        schemaFailureCount: Int,
        reviewBurden: Int,
        failureCounts: [String: Int],
        deviceMetrics: DeviceMetricSnapshot
    ) {
        self.manifestVersion = manifestVersion
        self.promptBundleVersion = promptBundleVersion
        self.modelRepository = modelRepository
        self.modelRevision = modelRevision
        self.modelFilename = modelFilename
        self.modelSha256 = modelSha256
        self.sourceModelId = sourceModelId
        self.sourceModelRepository = sourceModelRepository
        self.sourceModelRevision = sourceModelRevision
        self.runtimeRepository = runtimeRepository
        self.runtimeRelease = runtimeRelease
        self.runtimeRevision = runtimeRevision
        self.fixtureVersion = fixtureVersion
        self.schemaVersion = schemaVersion
        self.thinking = thinking
        self.chatTemplate = chatTemplate
        self.chatTemplateSource = chatTemplateSource
        self.fixtureCount = fixtureCount
        self.expectedRowCount = expectedRowCount
        self.modelReferencedRowCount = modelReferencedRowCount
        self.modelRecall = modelRecall
        self.acceptedProposalCount = acceptedProposalCount
        self.acceptedCorrectProposalCount = acceptedCorrectProposalCount
        self.acceptedEndToEndPrecision = acceptedEndToEndPrecision
        self.sourceFactsPreservedCount = sourceFactsPreservedCount
        self.schemaFailureCount = schemaFailureCount
        self.reviewBurden = reviewBurden
        self.failureCounts = failureCounts
        self.deviceMetrics = deviceMetrics
    }
}

private struct NativeFixtureResult {
    var expectedRows = 0
    var referencedRows = 0
    var accepted = 0
    var correct = 0
    var preserved = 0
    var schemaFailures = 0
    var reviewBurden = 0
    var failureCounts: [String: Int] = [:]

    mutating func fail(_ code: String) {
        failureCounts[code, default: 0] += 1
        schemaFailures += 1
    }
}

/// Runs the complete checked-in synthetic contract through the real pinned runtime and retains
/// only aggregate counts. This intentionally does not share production report or extraction code.
public enum NativeEvaluationRunner {
    public static func run(
        modelURL: URL,
        contractURL: URL,
        packBytes: UInt64,
        runtimeBytes: UInt64,
        deviceClass: String,
        deviceModel: String,
        osVersion: String,
        contextTokens: Int = 2_048,
        outputTokens: Int = 256,
        threads: Int = 4
    ) throws -> NativeEvaluationReport {
        let contract = try EvaluationContract.load(from: contractURL)
        guard contextTokens == 2_048, outputTokens == 256 else {
            throw EvaluationContractError.invalidContract
        }
        var metrics = EvaluationMetricRecorder()
        metrics.beginColdLoad()
        let session = try LlamaCppRuntimeSession(
            modelURL: modelURL,
            grammar: contract.grammar,
            grammarRoot: contract.grammarRoot,
            contextTokens: contextTokens,
            batchTokens: min(contextTokens, 256),
            threads: threads
        )
        metrics.endColdLoad()

        var aggregate = NativeFixtureResult()
        for fixture in contract.fixtures {
            let prompt = EvaluationPrompt.render(
                fixture: fixture,
                schemaVersion: contract.schemaVersion,
                chatTemplate: contract.chatTemplate,
                promptBundleVersion: contract.promptBundleVersion
            )
            guard prompt.data(using: .utf8)?.count ?? .max <= contract.maxInputBytes else {
                throw LlamaCppRuntimeError.inputLimitExceeded
            }
            let start = EvaluationMetricRecorder.clockNanoseconds()
            let output = try session.generate(prompt: prompt, maxOutputTokens: outputTokens)
            let end = EvaluationMetricRecorder.clockNanoseconds()
            metrics.recordWarmInference(startNanoseconds: start, endNanoseconds: end)
            let result = validate(output: output, fixture: fixture, contract: contract)
            aggregate.expectedRows += result.expectedRows
            aggregate.referencedRows += result.referencedRows
            aggregate.accepted += result.accepted
            aggregate.correct += result.correct
            aggregate.preserved += result.preserved
            aggregate.schemaFailures += result.schemaFailures
            aggregate.reviewBurden += result.reviewBurden
            for (code, count) in result.failureCounts {
                aggregate.failureCounts[code, default: 0] += count
            }
        }

        metrics.recordCurrentMemory()
        let snapshot = metrics.snapshot(
            deviceClass: deviceClass,
            deviceModel: deviceModel,
            osVersion: osVersion,
            packBytes: packBytes,
            runtimeBytes: runtimeBytes
        )
        return NativeEvaluationReport(
            manifestVersion: contract.manifestVersion,
            promptBundleVersion: contract.promptBundleVersion,
            modelRepository: contract.model.repository,
            modelRevision: contract.model.revision,
            modelFilename: contract.model.filename,
            modelSha256: contract.model.sha256,
            sourceModelId: contract.sourceModel?.id,
            sourceModelRepository: contract.sourceModel?.repository,
            sourceModelRevision: contract.sourceModel?.revision,
            runtimeRepository: contract.runtime.repository,
            runtimeRelease: contract.runtime.release,
            runtimeRevision: contract.runtime.revision,
            fixtureVersion: contract.fixtureVersion,
            schemaVersion: contract.schemaVersion,
            thinking: contract.thinking,
            chatTemplate: contract.chatTemplate,
            chatTemplateSource: contract.chatTemplateSource,
            fixtureCount: contract.fixtures.count,
            expectedRowCount: aggregate.expectedRows,
            modelReferencedRowCount: aggregate.referencedRows,
            modelRecall: ratio(aggregate.referencedRows, aggregate.expectedRows),
            acceptedProposalCount: aggregate.accepted,
            acceptedCorrectProposalCount: aggregate.correct,
            acceptedEndToEndPrecision: ratio(aggregate.correct, aggregate.accepted),
            sourceFactsPreservedCount: aggregate.preserved,
            schemaFailureCount: aggregate.schemaFailures,
            reviewBurden: aggregate.reviewBurden,
            failureCounts: aggregate.failureCounts,
            deviceMetrics: snapshot
        )
    }

}

enum EvaluationPrompt {
    static func render(
        fixture: CanonicalFixture,
        schemaVersion: String,
        chatTemplate: String?,
        promptBundleVersion: String? = nil
    ) -> String {
        if chatTemplate == "gemma4-v1" {
            return gemma4Prompt(
                for: fixture,
                schemaVersion: schemaVersion,
                promptBundleVersion: promptBundleVersion
            )
        }
        return legacyQwenPrompt(for: fixture, schemaVersion: schemaVersion)
    }

    private static func legacyQwenPrompt(for fixture: CanonicalFixture, schemaVersion: String) -> String {
        """
<|im_start|>system
You are an offline semantic mapper. Return only the JSON object required by the grammar.
Do not provide values, units, intervals, translations, explanations or medical copy.<|im_end|>
<|im_start|>user
Schema version: \(schemaVersion). Locale: \(fixture.language).
Known biomarker IDs are restricted to the checked-in catalogue allowlist.
OCR chunk: \(fixture.serializedInput)
Select source IDs and propose only bounded semantic fields.<|im_end|>
<|im_start|>assistant
<think>

</think>

"""
    }

    /// Exact text-only subset of Google's Gemma 4 template with reasoning disabled. The pinned
    /// llama.cpp revision exposes metadata lookup but does not provide Gemma 4's newer `<|turn>`
    /// template in its built-in apply API, so this reviewed template is bound explicitly.
    private static func gemma4Prompt(
        for fixture: CanonicalFixture,
        schemaVersion: String,
        promptBundleVersion: String?
    ) -> String {
        let rowGroupingInstructions = promptBundleVersion == "alyte.gemma4-e2b-evaluation.prompt.v2"
            ? "For each unambiguous physical measurement row, emit exactly one proposal. Combine all relevant source observation IDs/cells from that row (including label, value, unit, and reference-range cells) into that single proposal. Never emit separate proposals for label, value, unit, or range cells belonging to one row. If grouping a row is ambiguous, omit that row rather than duplicate-consuming any source row."
            : ""
        let system = """
You are an offline semantic mapper. Return only the JSON object required by the grammar.
Do not provide values, units, intervals, translations, explanations or medical copy.
\(rowGroupingInstructions)
""".trimmingCharacters(in: .whitespacesAndNewlines)
        let user = """
Schema version: \(schemaVersion). Locale: \(fixture.language).
Known biomarker IDs are restricted to the checked-in catalogue allowlist.
OCR chunk: \(fixture.serializedInput)
Select source IDs and propose only bounded semantic fields.
""".trimmingCharacters(in: .whitespacesAndNewlines)
        return "<bos><|turn>system\n\(system)<turn|>\n<|turn>user\n\(user)<turn|>\n<|turn>model\n"
    }
}

private extension NativeEvaluationRunner {
    static func validate(
        output: String,
        fixture: CanonicalFixture,
        contract: EvaluationContract
    ) -> NativeFixtureResult {
        var result = NativeFixtureResult()
        result.expectedRows = fixture.expected.count
        guard let data = output.data(using: .utf8), data.count <= contract.maxOutputBytes else {
            result.fail("oversized-output")
            result.reviewBurden = fixture.expected.count
            return result
        }
        guard let root = try? JSONSerialization.jsonObject(with: data), let object = root as? [String: Any] else {
            result.fail("malformed-schema")
            result.reviewBurden = fixture.expected.count
            return result
        }
        guard Set(object.keys) == ["schemaVersion", "proposals"], object["schemaVersion"] as? String == contract.schemaVersion,
              let proposals = object["proposals"] as? [[String: Any]], proposals.count <= contract.maxProposals else {
            result.fail("malformed-schema")
            result.reviewBurden = fixture.expected.count
            return result
        }

        let observationToRow = Dictionary(uniqueKeysWithValues: fixture.expected.flatMap { row in
            row.sourceObservationIds.map { ($0, row.rowId) }
        })
        var consumedRows = Set<String>()
        var referencedRows = Set<String>()
        let knownBiomarkers = Set(contract.allowedBiomarkerIds)
        for proposal in proposals {
            if let sourceIDs = proposal["sourceObservationIds"] as? [String] {
                for sourceID in sourceIDs {
                    if let row = observationToRow[sourceID] { referencedRows.insert(row) }
                }
            }
        }
        for proposal in proposals {
            let allowedKeys: Set<String> = ["sourceObservationIds", "role", "specimenType", "biomarkerId"]
            let authoritativeKeys: Set<String> = [
                "value", "valueString", "unit", "referenceInterval", "reference", "range", "flag",
                "conversion", "normalizedValue", "normalizedUnit", "translation", "translatedLabel",
                "explanation", "medicalCopy"
            ]
            let extraKeys = Set(proposal.keys).subtracting(allowedKeys)
            if !extraKeys.isEmpty {
                for key in extraKeys {
                    result.fail(authoritativeKeys.contains(key) ? "authoritative-field" : "extra-field")
                }
                continue
            }
            guard proposal.count == allowedKeys.count,
                  let sourceIDs = proposal["sourceObservationIds"] as? [String],
                  let role = proposal["role"] as? String,
                  let specimen = proposal["specimenType"] as? String else {
                result.fail("malformed-schema")
                continue
            }
            guard role == "measurement" || role == "specimen-context" || role == "ignore" else {
                result.fail("invalid-role")
                continue
            }
            guard ["blood", "serum", "plasma", "urine", "stool", "saliva", "unknown"].contains(specimen) else {
                result.fail("invalid-specimen")
                continue
            }
            let biomarker: String?
            if proposal["biomarkerId"] is NSNull {
                biomarker = nil
            } else if let value = proposal["biomarkerId"] as? String {
                biomarker = value
            } else {
                result.fail("unknown-biomarker-id")
                continue
            }
            if (role == "measurement" && biomarker == nil) ||
                (role != "measurement" && biomarker != nil) {
                result.fail("invalid-biomarker-role")
                continue
            }
            guard !sourceIDs.isEmpty,
                  sourceIDs.count <= 8,
                  sourceIDs.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 96 }) else {
                result.fail("oversized-proposal")
                continue
            }
            if let biomarker, !knownBiomarkers.contains(biomarker) {
                result.fail("unknown-biomarker-id")
                continue
            }
            guard Set(sourceIDs).count == sourceIDs.count else {
                result.fail("duplicate-source-observation")
                continue
            }
            guard sourceIDs.allSatisfy({ observationToRow[$0] != nil }) else {
                result.fail("unknown-source-id")
                continue
            }
            let rows = Set(sourceIDs.compactMap { observationToRow[$0] })
            guard rows.count == 1, let row = rows.first else {
                result.fail("duplicate-source-row")
                continue
            }
            guard !consumedRows.contains(row) else {
                result.fail("duplicate-source-row")
                continue
            }
            consumedRows.insert(row)
            if let biomarker,
               let entry = contract.catalogueEntry(for: biomarker),
               !specimenCompatible(entry, specimen) {
                result.fail("incompatible-specimen")
                consumedRows.remove(row)
                continue
            }
            result.accepted += 1
            if let expected = fixture.expected.first(where: { $0.rowId == row }),
               role == expected.role, specimen == expected.specimenType, biomarker == expected.biomarkerId {
                result.correct += 1
            }
            if let expected = fixture.expected.first(where: { $0.rowId == row }),
               Set(expected.sourceFactObservationIds).isSubset(of: Set(sourceIDs)) {
                result.preserved += 1
            }
        }
        result.referencedRows = referencedRows.count
        result.reviewBurden = max(0, fixture.expected.count - result.correct)
        return result
    }

    private static func specimenCompatible(_ entry: CanonicalBiomarker, _ specimen: String) -> Bool {
        if entry.specimens.contains(specimen) { return true }
        return entry.specimenCompatibility?.contains { group in
            group.contains(specimen) && group.contains(where: entry.specimens.contains)
        } ?? false
    }

    private static func ratio(_ numerator: Int, _ denominator: Int) -> Double {
        denominator == 0 ? 0 : Double(numerator) / Double(denominator)
    }
}
