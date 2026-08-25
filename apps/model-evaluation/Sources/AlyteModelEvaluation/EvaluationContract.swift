import Foundation

struct EvaluationContract: Decodable, Sendable {
    let contractVersion: String
    let manifestVersion: String
    let promptBundleVersion: String?
    let fixtureVersion: String
    let schemaVersion: String
    let catalogueVersion: String
    let catalogueSchemaVersion: String
    let model: CanonicalModelProvenance
    let sourceModel: CanonicalSourceModelProvenance?
    let runtime: CanonicalRuntimeProvenance
    let thinking: Bool
    let grammar: String
    let grammarRoot: String
    let maxInputBytes: Int
    let maxOutputBytes: Int
    let maxProposals: Int
    let chatTemplate: String?
    let chatTemplateSource: String?
    let allowedBiomarkerIds: [String]
    let biomarkerCatalogue: [CanonicalBiomarker]
    let fixtures: [CanonicalFixture]

    static func load(from url: URL) throws -> EvaluationContract {
        let data = try Data(contentsOf: url)
        let contract = try JSONDecoder().decode(EvaluationContract.self, from: data)
        try contract.validate()
        return contract
    }

    func validate() throws {
        guard let identity = EvaluationCandidateIdentity(contractVersion: contractVersion),
              manifestVersion == identity.manifestVersion,
              fixtureVersion == "alyte.qwen-evaluation-fixtures.v1",
              schemaVersion == "alyte.semantic-mapper.v1",
              model.revision.count == 40,
              model.revision.allSatisfy(\.isHexDigit),
              model.sha256.count == 64,
              model.sha256.allSatisfy(\.isHexDigit),
              !model.repository.isEmpty,
              !model.filename.isEmpty,
              !runtime.repository.isEmpty,
              !runtime.release.isEmpty,
              runtime.revision.count == 40,
              runtime.revision.allSatisfy(\.isHexDigit),
              thinking == false,
              maxInputBytes > 0,
              maxOutputBytes > 0,
              maxProposals > 0,
              !grammar.isEmpty,
              !grammarRoot.isEmpty,
              fixtures.count == 6,
              Set(fixtures.map(\.language)) == ["en", "de", "lt", "pl", "fr", "es"] else {
            throw EvaluationContractError.invalidContract
        }
        guard model.repository == identity.modelRepository,
              model.revision == identity.modelRevision,
              model.filename == identity.modelFilename,
              model.sha256 == identity.modelSha256,
              runtime.repository == identity.runtimeRepository,
              runtime.release == identity.runtimeRelease,
              runtime.revision == identity.runtimeRevision,
              sourceModel?.id == identity.sourceModelID,
              sourceModel?.repository == identity.sourceModelRepository,
              sourceModel?.revision == identity.sourceModelRevision,
              promptBundleVersion == identity.promptBundleVersion,
              chatTemplate == identity.chatTemplate,
              chatTemplateSource == identity.chatTemplateSource else {
            throw EvaluationContractError.invalidContract
        }
        if let chatTemplate {
            guard chatTemplate == "gemma4-v1",
                  chatTemplateSource == "explicit-pinned-google-gemma-4-template-v1",
                  promptBundleVersion == "alyte.gemma4-e2b-evaluation.prompt.v2",
                  contractVersion == "alyte.gemma4-e2b-evaluation.contract.v1" else {
                throw EvaluationContractError.invalidContract
            }
        } else if chatTemplateSource != nil || contractVersion != "alyte.qwen-evaluation.contract.v1" {
            throw EvaluationContractError.invalidContract
        }
        let knownIds = Set(allowedBiomarkerIds)
        let catalogueIds = Set(biomarkerCatalogue.map(\.id))
        guard knownIds.count == allowedBiomarkerIds.count,
              catalogueIds == knownIds else {
            throw EvaluationContractError.invalidContract
        }
        for fixture in fixtures {
            guard fixture.observations.count == 8,
                  fixture.expected.count == 2,
                  fixture.serializedInput.data(using: .utf8)?.count ?? .max <= maxInputBytes else {
                throw EvaluationContractError.invalidContract
            }
            for expected in fixture.expected {
                guard expected.sourceObservationIds.count >= 1,
                      expected.sourceObservationIds.count <= 8,
                      expected.sourceFactObservationIds.allSatisfy(expected.sourceObservationIds.contains),
                      expected.biomarkerId == nil || knownIds.contains(expected.biomarkerId!) else {
                    throw EvaluationContractError.invalidContract
                }
            }
        }
    }

    func catalogueEntry(for id: String) -> CanonicalBiomarker? {
        biomarkerCatalogue.first(where: { $0.id == id })
    }
}

enum EvaluationContractError: Error, Equatable {
    case invalidContract
}

struct CanonicalBiomarker: Decodable, Sendable {
    let id: String
    let specimens: [String]
    let specimenCompatibility: [[String]]?
}

struct CanonicalModelProvenance: Decodable, Sendable {
    let repository: String
    let revision: String
    let filename: String
    let sha256: String
}

struct CanonicalSourceModelProvenance: Decodable, Sendable {
    let id: String
    let repository: String
    let revision: String
}

struct CanonicalRuntimeProvenance: Decodable, Sendable {
    let repository: String
    let release: String
    let revision: String
}

private struct EvaluationCandidateIdentity {
    let manifestVersion: String
    let modelRepository: String
    let modelRevision: String
    let modelFilename: String
    let modelSha256: String
    let sourceModelID: String?
    let sourceModelRepository: String?
    let sourceModelRevision: String?
    let runtimeRepository: String
    let runtimeRelease: String
    let runtimeRevision: String
    let promptBundleVersion: String?
    let chatTemplate: String?
    let chatTemplateSource: String?

    private init(
        manifestVersion: String,
        modelRepository: String,
        modelRevision: String,
        modelFilename: String,
        modelSha256: String,
        sourceModelID: String?,
        sourceModelRepository: String?,
        sourceModelRevision: String?,
        runtimeRepository: String,
        runtimeRelease: String,
        runtimeRevision: String,
        promptBundleVersion: String?,
        chatTemplate: String?,
        chatTemplateSource: String?
    ) {
        self.manifestVersion = manifestVersion
        self.modelRepository = modelRepository
        self.modelRevision = modelRevision
        self.modelFilename = modelFilename
        self.modelSha256 = modelSha256
        self.sourceModelID = sourceModelID
        self.sourceModelRepository = sourceModelRepository
        self.sourceModelRevision = sourceModelRevision
        self.runtimeRepository = runtimeRepository
        self.runtimeRelease = runtimeRelease
        self.runtimeRevision = runtimeRevision
        self.promptBundleVersion = promptBundleVersion
        self.chatTemplate = chatTemplate
        self.chatTemplateSource = chatTemplateSource
    }

    init?(contractVersion: String) {
        switch contractVersion {
        case "alyte.qwen-evaluation.contract.v1":
            self.init(
                manifestVersion: "alyte.qwen-evaluation.manifest.v1",
                modelRepository: "ggml-org/Qwen3.5-0.8B-GGUF",
                modelRevision: "8fea620810c4afa23dd6443f999a48574c1611a3",
                modelFilename: "Qwen3.5-0.8B-Q4_0.gguf",
                modelSha256: "57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf",
                sourceModelID: nil,
                sourceModelRepository: nil,
                sourceModelRevision: nil,
                runtimeRepository: "ggml-org/llama.cpp",
                runtimeRelease: "v0.2.0",
                runtimeRevision: "bb4caa7540188872173c44d161602d9271386413",
                promptBundleVersion: nil,
                chatTemplate: nil,
                chatTemplateSource: nil
            )
        case "alyte.gemma4-e2b-evaluation.contract.v1":
            self.init(
                manifestVersion: "alyte.gemma4-e2b-evaluation.manifest.v1",
                modelRepository: "ggml-org/gemma-4-E2B-it-GGUF",
                modelRevision: "b4243c156154b6dca9324415f8c7ccc098b4aed1",
                modelFilename: "gemma-4-E2B-it-Q4_0.gguf",
                modelSha256: "8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52",
                sourceModelID: "gemma-4-e2b-it",
                sourceModelRepository: "google/gemma-4-E2B-it",
                sourceModelRevision: "3e22461f65e89153144f8adb70e3b8c2cc9845a7",
                runtimeRepository: "ggml-org/llama.cpp",
                runtimeRelease: "v0.2.0",
                runtimeRevision: "bb4caa7540188872173c44d161602d9271386413",
                promptBundleVersion: "alyte.gemma4-e2b-evaluation.prompt.v2",
                chatTemplate: "gemma4-v1",
                chatTemplateSource: "explicit-pinned-google-gemma-4-template-v1"
            )
        default:
            return nil
        }
    }
}

struct CanonicalFixture: Decodable, Sendable {
    let id: String
    let language: String
    let serializedInput: String
    let observations: [CanonicalObservation]
    let expected: [CanonicalExpectedRow]
}

struct CanonicalObservation: Decodable, Sendable {
    let id: String
    let rowId: String
    let text: String
    let alternatives: [String]
    let pageIndex: Int
    let locale: String
    let specimenType: String
}

struct CanonicalExpectedRow: Decodable, Sendable {
    let rowId: String
    let sourceObservationIds: [String]
    let sourceFactObservationIds: [String]
    let biomarkerId: String?
    let role: String
    let specimenType: String
    let sourceFacts: CanonicalSourceFacts
}

struct CanonicalSourceFacts: Decodable, Sendable {
    let valueString: String
    let unit: String
    let referenceInterval: String
}
