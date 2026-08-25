import Foundation

public struct NativeEvaluationReport: Codable, Equatable, Sendable {
    public let manifestVersion: String
    public let modelRepository: String
    public let modelRevision: String
    public let modelFilename: String
    public let modelSha256: String
    public let runtimeRepository: String
    public let runtimeRevision: String
    public let fixtureVersion: String
    public let schemaVersion: String
    public let thinking: Bool
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
        modelRepository: String,
        modelRevision: String,
        modelFilename: String,
        modelSha256: String,
        runtimeRepository: String,
        runtimeRevision: String,
        fixtureVersion: String,
        schemaVersion: String,
        thinking: Bool,
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
        self.modelRepository = modelRepository
        self.modelRevision = modelRevision
        self.modelFilename = modelFilename
        self.modelSha256 = modelSha256
        self.runtimeRepository = runtimeRepository
        self.runtimeRevision = runtimeRevision
        self.fixtureVersion = fixtureVersion
        self.schemaVersion = schemaVersion
        self.thinking = thinking
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

private struct NativeFixture: Sendable {
    let id: String
    let locale: String
    let prompt: String
    let expectedRows: [NativeExpectedRow]
}

private struct NativeExpectedRow: Sendable {
    let rowID: String
    let sourceObservationIDs: Set<String>
    let sourceFactObservationIDs: Set<String>
    let biomarkerID: String
    let specimenType: String
}

private struct NativeProposal {
    let sourceObservationIDs: [String]
    let role: String
    let specimenType: String
    let biomarkerID: String?
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

/// Runs the six synthetic prompts through the real pinned runtime and retains only aggregate
/// counts. This intentionally does not share production report or extraction code.
public enum NativeEvaluationRunner {
    public static let fixtureVersion = "alyte.qwen-evaluation-fixtures.v1"
    public static let schemaVersion = "alyte.semantic-mapper.v1"
    public static let grammar = #"""
root ::= "{" ws "\"schemaVersion\"" ws ":" ws "\"alyte.semantic-mapper.v1\"" ws "," ws "\"proposals\"" ws ":" ws proposals ws "}"
proposals ::= "[" ws (proposal (ws "," ws proposal)*)? ws "]"
proposal ::= "{" ws "\"sourceObservationIds\"" ws ":" ws string-list ws "," ws "\"role\"" ws ":" ws role ws "," ws "\"specimenType\"" ws ":" ws specimen ws "," ws "\"biomarkerId\"" ws ":" ws (string | "null") ws "}"
string-list ::= "[" ws string (ws "," ws string)* ws "]"
role ::= "\"measurement\"" | "\"specimen-context\"" | "\"ignore\""
specimen ::= "\"blood\"" | "\"serum\"" | "\"plasma\"" | "\"urine\"" | "\"stool\"" | "\"saliva\"" | "\"unknown\""
string ::= "\"" ([^"\\] | escape)* "\""
escape ::= "\\" (["\\/bfnrt] | "u" hex4)
hex4 ::= [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]
ws ::= [ \t\n\r]*
"""#

    public static func run(
        modelURL: URL,
        packBytes: UInt64,
        runtimeBytes: UInt64,
        deviceClass: String,
        deviceModel: String,
        osVersion: String,
        contextTokens: Int = 2_048,
        outputTokens: Int = 256,
        threads: Int = 4
    ) throws -> NativeEvaluationReport {
        var metrics = EvaluationMetricRecorder()
        metrics.beginColdLoad()
        let session = try LlamaCppRuntimeSession(
            modelURL: modelURL,
            grammar: grammar,
            grammarRoot: "root",
            contextTokens: contextTokens,
            batchTokens: min(contextTokens, 256),
            threads: threads
        )
        metrics.endColdLoad()

        var aggregate = NativeFixtureResult()
        for fixture in fixtures {
            let prompt = fixture.prompt
            let start = EvaluationMetricRecorder.clockNanoseconds()
            let output = try session.generate(prompt: prompt, maxOutputTokens: outputTokens)
            let end = EvaluationMetricRecorder.clockNanoseconds()
            metrics.recordWarmInference(startNanoseconds: start, endNanoseconds: end)
            let result = validate(output: output, fixture: fixture)
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
            manifestVersion: "alyte.qwen-evaluation.manifest.v1",
            modelRepository: "ggml-org/Qwen3.5-0.8B-GGUF",
            modelRevision: "8fea620810c4afa23dd6443f999a48574c1611a3",
            modelFilename: "Qwen3.5-0.8B-Q4_0.gguf",
            modelSha256: "57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf",
            runtimeRepository: "ggml-org/llama.cpp",
            runtimeRevision: "bb4caa7540188872173c44d161602d9271386413",
            fixtureVersion: fixtureVersion,
            schemaVersion: schemaVersion,
            thinking: false,
            fixtureCount: fixtures.count,
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

    private static let fixtures: [NativeFixture] = [
        makeFixture(id: "qwen-v1-en-mixed", locale: "en", label: "LDL cholesterol", specimen: "serum", biomarker: "biomarker.ldl_c"),
        makeFixture(id: "qwen-v1-de-mixed", locale: "de", label: "LDL-Cholesterin", specimen: "plasma", biomarker: "biomarker.ldl_c"),
        makeFixture(id: "qwen-v1-lt-mixed", locale: "lt", label: "Feritinas", specimen: "serum", biomarker: "biomarker.ferritin"),
        makeFixture(id: "qwen-v1-pl-mixed", locale: "pl", label: "Hemoglobina", specimen: "blood", biomarker: "biomarker.hemoglobin"),
        makeFixture(id: "qwen-v1-fr-mixed", locale: "fr", label: "Vitamine B12", specimen: "serum", biomarker: "biomarker.vitamin_b12_total"),
        makeFixture(id: "qwen-v1-es-mixed", locale: "es", label: "Glucosa", specimen: "urine", biomarker: "biomarker.glucose"),
    ]

    private static func makeFixture(
        id: String,
        locale: String,
        label: String,
        specimen: String,
        biomarker: String
    ) -> NativeFixture {
        let row = "\(id)-row"
        let ids = ["\(row)-label", "\(row)-value", "\(row)-unit", "\(row)-interval"]
        let prompt = """
        <|im_start|>system
        You are an offline semantic mapper. Return only the JSON object required by the grammar.
        Do not provide values, units, intervals, translations, explanations or medical copy.<|im_end|>
        <|im_start|>user
        Schema version: alyte.semantic-mapper.v1. Locale: \(locale). Specimen: \(specimen).
        Known biomarker IDs: \(biomarker).
        OCR observations: \(ids[0])=\(label); \(ids[1])=synthetic-value; \(ids[2])=synthetic-unit; \(ids[3])=synthetic-interval.
        Select source IDs and propose only the known biomarker ID.<|im_end|>
        <|im_start|>assistant
        <think>

        </think>

        """
        return NativeFixture(
            id: id,
            locale: locale,
            prompt: prompt,
            expectedRows: [NativeExpectedRow(
                rowID: row,
                sourceObservationIDs: Set(ids),
                sourceFactObservationIDs: Set(ids.dropFirst()),
                biomarkerID: biomarker,
                specimenType: specimen
            )]
        )
    }

    private static func validate(output: String, fixture: NativeFixture) -> NativeFixtureResult {
        var result = NativeFixtureResult()
        result.expectedRows = fixture.expectedRows.count
        guard let data = output.data(using: .utf8), data.count <= 16_384 else {
            result.fail("oversized-output")
            result.reviewBurden = fixture.expectedRows.count
            return result
        }
        guard let root = try? JSONSerialization.jsonObject(with: data), let object = root as? [String: Any] else {
            result.fail("malformed-schema")
            result.reviewBurden = fixture.expectedRows.count
            return result
        }
        guard Set(object.keys) == ["schemaVersion", "proposals"], object["schemaVersion"] as? String == schemaVersion,
              let proposals = object["proposals"] as? [[String: Any]], proposals.count <= 24 else {
            result.fail("malformed-schema")
            result.reviewBurden = fixture.expectedRows.count
            return result
        }

        let observationToRow = Dictionary(uniqueKeysWithValues: fixture.expectedRows.flatMap { row in
            row.sourceObservationIDs.map { ($0, row.rowID) }
        })
        var consumedRows = Set<String>()
        var referencedRows = Set<String>()
        let knownBiomarkers = Set(fixture.expectedRows.map(\.biomarkerID))
        for proposal in proposals {
            guard Set(proposal.keys) == ["sourceObservationIds", "role", "specimenType", "biomarkerId"],
                  let sourceIDs = proposal["sourceObservationIds"] as? [String], !sourceIDs.isEmpty,
                  sourceIDs.count <= 8,
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
            if let biomarker, !knownBiomarkers.contains(biomarker) {
                result.fail("unknown-biomarker-id")
                continue
            }
            guard Set(sourceIDs).count == sourceIDs.count, sourceIDs.allSatisfy({ observationToRow[$0] != nil }) else {
                result.fail("unknown-or-duplicate-source-id")
                continue
            }
            let rows = Set(sourceIDs.compactMap { observationToRow[$0] })
            guard rows.count == 1, let row = rows.first else {
                result.fail("duplicate-source-row")
                continue
            }
            referencedRows.insert(row)
            guard !consumedRows.contains(row) else {
                result.fail("duplicate-source-row")
                continue
            }
            consumedRows.insert(row)
            result.accepted += 1
            if let expected = fixture.expectedRows.first(where: { $0.rowID == row }),
               role == "measurement", specimen == expected.specimenType, biomarker == expected.biomarkerID {
                result.correct += 1
                if expected.sourceFactObservationIDs.isSubset(of: Set(sourceIDs)) { result.preserved += 1 }
            }
        }
        result.referencedRows = referencedRows.count
        result.reviewBurden = max(0, fixture.expectedRows.count - result.correct)
        return result
    }

    private static func ratio(_ numerator: Int, _ denominator: Int) -> Double {
        denominator == 0 ? 0 : Double(numerator) / Double(denominator)
    }
}
