import { createSemanticMapperPrompt } from './model-evaluation-production';

export const COMPACT_KEY_CANDIDATE_PROMPT_VERSION =
  'alyte.semantic-mapper.production-compact-key-candidate.v1' as const;

const PRODUCTION_KEY_SENTENCE = 'with grammar keys only and no extra fields.';
const CANDIDATE_KEY_SENTENCE =
  'with compact grammar keys only (rowKey r0/r1; each *Key is a row-local compact cell key such as c0/c1/c2), never source text, and no extra fields.';

/** One evaluator-only wording factor; the production prompt is imported, not copied. */
export function createCompactKeyCandidatePrompt(locale: string, serializedChunk: string): string {
  const productionPrompt = createSemanticMapperPrompt(locale, serializedChunk);
  if (!productionPrompt.includes(PRODUCTION_KEY_SENTENCE))
    throw new Error('model-evaluation-failed:prompt-drift');
  return productionPrompt.replace(PRODUCTION_KEY_SENTENCE, CANDIDATE_KEY_SENTENCE);
}
