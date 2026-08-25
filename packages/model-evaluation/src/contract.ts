import { readFileSync } from 'node:fs';
import {
  ALL_COMPARABLE_BIOMARKER_IDS,
  CATALOGUE_SCHEMA_VERSION,
  CATALOGUE_VERSION,
  comparableBiomarkers,
} from '@alyte/catalogue';
import {
  MODEL_EVALUATION_FIXTURE_VERSION,
  semanticEvaluationFixtures,
  type SemanticEvaluationFixture,
} from './fixtures';
import { qwenEvaluationManifest, SEMANTIC_MAPPER_SCHEMA_VERSION } from './manifest';
import { serializeOCRChunk } from './serialization';

export const MODEL_EVALUATION_CONTRACT_VERSION = 'alyte.qwen-evaluation.contract.v1' as const;

export type CanonicalEvaluationContract = {
  readonly contractVersion: typeof MODEL_EVALUATION_CONTRACT_VERSION;
  readonly manifestVersion: typeof qwenEvaluationManifest.manifestVersion;
  readonly fixtureVersion: typeof MODEL_EVALUATION_FIXTURE_VERSION;
  readonly schemaVersion: typeof SEMANTIC_MAPPER_SCHEMA_VERSION;
  readonly catalogueVersion: typeof CATALOGUE_VERSION;
  readonly catalogueSchemaVersion: typeof CATALOGUE_SCHEMA_VERSION;
  readonly model: {
    readonly repository: string;
    readonly revision: string;
    readonly filename: string;
    readonly sha256: string;
  };
  readonly runtime: {
    readonly repository: string;
    readonly release: string;
    readonly revision: string;
  };
  readonly thinking: boolean;
  readonly grammar: string;
  readonly grammarRoot: string;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxProposals: number;
  readonly allowedBiomarkerIds: readonly string[];
  readonly biomarkerCatalogue: readonly {
    readonly id: string;
    readonly specimens: readonly string[];
    readonly specimenCompatibility?: readonly (readonly string[])[];
  }[];
  readonly fixtures: readonly CanonicalFixture[];
};

export type CanonicalFixture = {
  readonly id: string;
  readonly language: string;
  readonly serializedInput: string;
  readonly observations: readonly {
    readonly id: string;
    readonly rowId: string;
    readonly text: string;
    readonly alternatives: readonly string[];
    readonly pageIndex: number;
    readonly locale: string;
    readonly specimenType: string;
  }[];
  readonly expected: readonly {
    readonly rowId: string;
    readonly sourceObservationIds: readonly string[];
    readonly sourceFactObservationIds: readonly string[];
    readonly biomarkerId: string | null;
    readonly role: string;
    readonly specimenType: string;
    readonly sourceFacts: {
      readonly valueString: string;
      readonly unit: string;
      readonly referenceInterval: string;
    };
  }[];
};

function grammarText(): string {
  return readFileSync(new URL('../schema/semantic-mapper-v1.gbnf', import.meta.url), 'utf8');
}

function promptFor(fixture: SemanticEvaluationFixture, serializedInput: string): string {
  const prompt = `<|im_start|>system
You are an offline semantic mapper. Return only the JSON object required by the grammar.
Do not provide values, units, intervals, translations, explanations or medical copy.<|im_end|>
<|im_start|>user
Schema version: ${SEMANTIC_MAPPER_SCHEMA_VERSION}. Locale: ${fixture.language}.
Known biomarker IDs are restricted to the checked-in catalogue allowlist.
OCR chunk: ${serializedInput}
Select source IDs and propose only bounded semantic fields.<|im_end|>
<|im_start|>assistant
<think>

</think>

`;
  if (new TextEncoder().encode(prompt).byteLength > qwenEvaluationManifest.prompt.maxInputBytes) {
    throw new Error(`input-too-large:${fixture.id}`);
  }
  return prompt;
}

function canonicalFixture(fixture: SemanticEvaluationFixture): CanonicalFixture {
  const knownBiomarkerIds = [
    ...new Set(
      fixture.expected.flatMap((expected) =>
        expected.biomarkerId === null ? [] : [expected.biomarkerId],
      ),
    ),
  ];
  const serializedInput = serializeOCRChunk(
    fixture.observations,
    fixture.language,
    knownBiomarkerIds,
  );
  promptFor(fixture, serializedInput);
  return {
    id: fixture.id,
    language: fixture.language,
    serializedInput,
    observations: fixture.observations,
    expected: fixture.expected,
  };
}

export function createCanonicalEvaluationContract(): CanonicalEvaluationContract {
  return {
    contractVersion: MODEL_EVALUATION_CONTRACT_VERSION,
    manifestVersion: qwenEvaluationManifest.manifestVersion,
    fixtureVersion: MODEL_EVALUATION_FIXTURE_VERSION,
    schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
    catalogueVersion: CATALOGUE_VERSION,
    catalogueSchemaVersion: CATALOGUE_SCHEMA_VERSION,
    model: {
      repository: qwenEvaluationManifest.model.repository,
      revision: qwenEvaluationManifest.model.revision,
      filename: qwenEvaluationManifest.model.filename,
      sha256: qwenEvaluationManifest.model.sha256,
    },
    runtime: {
      repository: qwenEvaluationManifest.runtime.repository,
      release: qwenEvaluationManifest.runtime.release,
      revision: qwenEvaluationManifest.runtime.revision,
    },
    thinking: qwenEvaluationManifest.prompt.thinking,
    grammar: grammarText(),
    grammarRoot: qwenEvaluationManifest.prompt.grammarRoot,
    maxInputBytes: qwenEvaluationManifest.prompt.maxInputBytes,
    maxOutputBytes: qwenEvaluationManifest.prompt.maxOutputBytes,
    maxProposals: qwenEvaluationManifest.prompt.maxProposals,
    allowedBiomarkerIds: [...ALL_COMPARABLE_BIOMARKER_IDS].sort(),
    biomarkerCatalogue: comparableBiomarkers.map((entry) => ({
      id: entry.id,
      specimens: [...entry.specimens],
      ...(entry.specimenCompatibility === undefined
        ? {}
        : { specimenCompatibility: entry.specimenCompatibility }),
    })),
    fixtures: semanticEvaluationFixtures.map(canonicalFixture),
  };
}
