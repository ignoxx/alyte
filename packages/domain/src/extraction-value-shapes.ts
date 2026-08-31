const CORE_CATEGORICAL_RESULT_VALUES =
  '(?:not detected|positive|negative|detected|normal|abnormal|nicht nachgewiesen|nicht nachweisbar|nachgewiesen|positiv|negativ|auffällig|unauffällig|teigiamas|neigiamas|aptikta|neaptikta|nenustatyta|normalus|nenormalus)';

// Exact result cells can safely support common qualitative microbiology and immunology states.
// These remain opaque measured source values: Alyte does not rank or medically interpret them.
const EXTENDED_CATEGORICAL_RESULT_VALUES =
  '(?:present|absent|reactive|non[ -]?reactive|susceptible|sensitive|resistant|intermediate|growth|no growth|equivocal|borderline|vorhanden|nicht vorhanden|reaktiv|nicht reaktiv|sensibel|empfindlich|resistent|intermediär|intermediaer|wachstum|kein wachstum|grenzwertig)';

const EXACT_CATEGORICAL_RESULT_PATTERN = new RegExp(
  `^(?:${CORE_CATEGORICAL_RESULT_VALUES}|${EXTENDED_CATEGORICAL_RESULT_VALUES})$`,
  'iu',
);
const CORE_CATEGORICAL_RESULT_SUFFIX_PATTERN = new RegExp(
  `(?:^|\\s)(${CORE_CATEGORICAL_RESULT_VALUES})\\s*$`,
  'iu',
);

/** True only for a complete source cell containing a reviewed qualitative result shape. */
export function isExtractionCategoricalResultValue(input: string): boolean {
  return EXACT_CATEGORICAL_RESULT_PATTERN.test(input.trim());
}

/**
 * Whole-line parsing remains narrower than exact-cell parsing. Broad qualitative words at the
 * end of prose are not enough to prove that the suffix is the observed result.
 */
export function coreExtractionCategoricalResultSuffix(
  input: string,
): { readonly value: string; readonly index: number } | null {
  const match = CORE_CATEGORICAL_RESULT_SUFFIX_PATTERN.exec(input);
  if (match === null || match[1] === undefined) return null;
  return { value: match[1], index: match.index };
}
