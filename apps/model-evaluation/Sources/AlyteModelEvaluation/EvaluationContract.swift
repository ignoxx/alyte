import Foundation

struct EvaluationContract: Decodable, Sendable {
    let contractVersion: String
    let manifestVersion: String
    let fixtureVersion: String
    let schemaVersion: String
    let catalogueVersion: String
    let catalogueSchemaVersion: String
    let model: CanonicalModelProvenance
    let runtime: CanonicalRuntimeProvenance
    let thinking: Bool
    let grammar: String
    let grammarRoot: String
    let maxInputBytes: Int
    let maxOutputBytes: Int
    let maxProposals: Int
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
        guard contractVersion == "alyte.qwen-evaluation.contract.v1",
              manifestVersion == "alyte.qwen-evaluation.manifest.v1",
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

struct CanonicalRuntimeProvenance: Decodable, Sendable {
    let repository: String
    let release: String
    let revision: String
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
