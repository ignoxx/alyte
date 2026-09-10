# macOS import evaluation harness

This harness evaluates local report adapters against source-checked, report-hash-bound truth. It
keeps extraction recall separate from canonical mapping and trend eligibility. Detailed matches
contain report fields and belong only under the private evaluation root; ordinary output and the
comparison aggregate contain counts, timings, and diagnostic totals.

The contract is deliberately repeated here so the runner remains understandable without opening a
scratch file. Every JSON artifact uses `schemaVersion: "alyte.import-eval.v1"` and a `reportId` plus
the SHA-256 of the original report. Ground truth also carries `groundTruthVersion: 1`, a review
object, and every source-checked measurement. A measurement preserves source label, value string,
value type, parsed value, comparator, unit, reference interval, flag, collection date and group,
specimen, one-based page, optional normalized location, and explicit ambiguous fields. Canonical
biomarker and trend fields are optional and never gate extraction truth. Adapter results add pipeline
identity, stage timings, measurements, and diagnostic counts. An adapter failure still produces a
valid result with zero measurements and a failure count.

The runner refuses to evaluate draft truth or a report whose hash differs from truth. Matching is
one-to-one: source label + page + value is preferred, then source label + page, source label + date,
and finally source label. It never matches by value alone. Scores report exact matches, correct
critical rows, missing rows, non-duplicate spurious rows, duplicate outputs, wrong non-null
associations, field scores, group membership, mapping availability, trend eligibility, and changed
or unresolved-field proxies. Mapping reports both observed pipeline mapped/unmapped/absent counts
and reviewed-truth correctness; when canonical truth is intentionally absent, correctness remains
unevaluated rather than looking like a zero-error mapping score. A source-null ambiguous field is excluded from its strict denominator,
but a populated value is counted separately as an unexpected or invented value. A missing field is
not labeled a wrong association unless both source and parser supplied conflicting non-null values.

The aggregate distinguishes produced output rows from recovered rows: recovered means source label
and value fields matched, while strict critical-row correctness additionally requires the scored
critical fields.

The private layout is:

```text
.scratch/import-evaluation/
  reports/{id}.pdf
  ground-truth/{id}.json
  runs/{run-id}/{pipeline}/{id}.json  # when --run-id is supplied
  runs/{pipeline}/{id}.json           # without --run-id
  aggregate/{run-id}/{id}.json
  aggregate/{run-id}/{id}.md
  aggregate/{run-id}/comparison.json
  aggregate/{run-id}/comparison.md
```

The expected file must have `review.status: "source-checked"`, and its `reportSha256` must match
the report before an adapter is run. A draft or hash mismatch stops the run before parsing.

To prepare a private canonical-mapping and trend-eligibility proposal without modifying sealed
ground truth, run:

```sh
node --import tsx scripts/import-evaluation/annotate-ground-truth.ts \
  --root .scratch/import-evaluation \
  --reports lt,en,de
```

The tool writes health-bearing proposals under
`.scratch/import-evaluation/ground-truth-proposals/catalogue-0.2.0/` and prints only aggregate
counts. It maps only one exact normalized catalogue alias; every other row receives an explicit
null unsupported mapping. Trend eligibility is false unless the proposal has a numeric point,
finite value, known unambiguous date, exact case-sensitive supported unit, exact supported
specimen, and satisfied method policy. Review the private proposal before applying any fields to
the sealed expected-results files.

After both adapters exist, run the baseline against the private report set with one explicit
command. `--run-id` places results under a new immutable run directory so a later experiment does
not overwrite the baseline:

```sh
node --import tsx scripts/import-evaluation/run.ts \
  --root .scratch/import-evaluation \
  --reports lt,en,de \
  --run-id baseline \
  --adapter alyte=scripts/import-evaluation/alyte-service-baseline.ts \
  --adapter vitametr=scripts/import-evaluation/vitametr.mjs
```

The Alyte adapter runs the production report-service path with the cached local Qwen pack by
default. Use `--deterministic-only` only when invoking that adapter directly to capture the
pre-model checkpoint; that is a distinct pipeline version and is not the faithful production
baseline. On macOS, run the comparison where Metal is visible. A sandbox that hides Metal forces
the command-line model adapter onto a CPU path and makes its elapsed time misleading.

The isolated date-exclusion experiment changes only which observations the date pass removes. It
loads `apps/mobile/src/features/labs/report-service-date-exclusion.eval.ts` and its private domain
shim; production service and domain files remain unchanged. Run the same reports through the
runner with a distinct immutable run ID:

```sh
node --import tsx scripts/import-evaluation/run.ts \
  --root .scratch/import-evaluation \
  --reports lt,en,de \
  --run-id date-exclusion-v1 \
  --adapter alyte-date-exclusion=scripts/import-evaluation/alyte-service-date-exclusion.ts \
  --adapter vitametr=scripts/import-evaluation/vitametr.mjs
```

The wrapper forces `date-exclusion-v1`; the faithful baseline continues to use
`alyte-service-baseline.ts` directly.

The uniform Vision/layout experiment routes every PDF page through the native Vision reader,
including pages with selectable text, and runs the unchanged report-service geometry reconstruction
with the document model omitted. It is an evaluation-only adapter; use a new immutable run ID when
comparing its results with the sealed LT/EN/DE truth:

```sh
node --import tsx scripts/import-evaluation/run.ts \
  --root .scratch/import-evaluation \
  --reports lt,en,de \
  --run-id vision-geometry-v1 \
  --adapter alyte-vision-geometry=scripts/import-evaluation/alyte-service-vision-geometry.ts
```

The adapter retains the PDF reader's page dimensions while discarding its selectable-text
observations before extraction, so source boxes and date ambiguity remain the responsibility of the
Vision observations and existing deterministic geometry path. Weak or unsupported associations stay
unmapped rather than being filled by a document model.

For a selectable-text-only Poppler control, use the separate bbox-layout adapter. It reads exact
Poppler words and boxes, reconstructs same-row geometry, and admits only a unique numeric value with
generic unit or reference context. Image-only pages intentionally produce zero rows:

```sh
node --import tsx scripts/import-evaluation/run.ts \
  --root .scratch/import-evaluation \
  --reports lt,en,de \
  --run-id poppler-bbox-v3 \
  --adapter alyte-poppler-bbox=scripts/import-evaluation/alyte-poppler-bbox.ts
```

Each adapter receives `--report`, `--report-id`, and `--output`. It must write one
`alyte.import-eval.v1` pipeline result to the output path. The runner invokes adapters sequentially,
then writes private detailed scores and the safe comparison aggregate. It never sends a report to a
remote parser and discards adapter stdout/stderr so report text cannot enter the normal run log.

Vitametr is a research-only external dependency. Provision its checkout and dependencies outside
the Alyte repository before the command above:

```sh
git clone https://github.com/ACiDekCZ/vitametr.git /tmp/alyte-vitametr-research
git -C /tmp/alyte-vitametr-research checkout 9d1366fbd7e3f3712190f27f5f190a83c9703989
npm ci --prefix /tmp/alyte-vitametr-research
```

The pinned checkout reports Vitametr version `1.2.1`; its public parser uses the pinned lockfile,
`pdfjs-dist` and `esbuild`. Keep that checkout and its `node_modules` outside Alyte production and
do not add its dependencies to the app. The adapter uses the checkout at the default
`/tmp/alyte-vitametr-research` location, bundles the public parser locally, and writes only its
contract result under the private evaluation root.

The runner requires reports, expected truth, pipeline results, detailed scores, and aggregate files
to resolve inside the private root; symlink escapes are rejected. The root is
`.scratch/import-evaluation`, which is git-ignored by the repository. Evaluation directories are
restricted to mode `0700`; health-bearing JSON and text artifacts are written with mode `0600`, and
existing private inputs are tightened before use.

To score a previously written pipeline result without running an adapter:

```sh
node --import tsx scripts/import-evaluation/score.ts \
  --private-root .scratch/import-evaluation \
  --report .scratch/import-evaluation/reports/lt.pdf \
  --report-id lt \
  --expected .scratch/import-evaluation/ground-truth/lt.json \
  --pipeline .scratch/import-evaluation/runs/alyte/lt.json \
  --output .scratch/import-evaluation/runs/alyte/lt.score.json \
  --aggregate-output .scratch/import-evaluation/runs/alyte/lt.aggregate.json
```

The standalone scorer requires `--private-root` and applies the same real-path containment check to
every input and output. It rejects paths that escape through a symlink before reading or writing
health-bearing artifacts.

The correction counts in a score are unresolved and changed-field proxies. They are not estimates
of user correction time. `unexpectedPopulatedFieldCount` counts fields populated where source truth
is null, while `inventedAmbiguousCollectionDateCount` separately records a non-null date returned
for a source-ambiguous date; neither turns the value into ground truth. A missing value, unit, or
date is not counted as a wrong association unless both source and parser supplied conflicting
non-null values.

Matching applies Unicode NFKC and whitespace normalization. Source labels are compared
case-insensitively for association; units preserve case after normalization (`mU` and `MU` remain
distinct). Strict critical association also includes value type and parsed value, so a numeric
shape change is visible even when the displayed value string looks similar.

The synthetic seam tests are run with:

```sh
node --import tsx --test scripts/import-evaluation/score.test.ts scripts/import-evaluation/run.test.ts
```

To repeat the evaluation-only Qwen3.5 full-page proposal and deterministic source-grounding
experiment, render or copy page images below the private root, then run:

```sh
node --import tsx scripts/import-evaluation/qwen35-fullpage.ts \
  --report .scratch/import-evaluation/reports/lt.pdf \
  --report-id lt \
  --private-root .scratch/import-evaluation \
  --output .scratch/import-evaluation/runs/qwen35-lt-fullpage.json \
  --source-image-dir .scratch/import-evaluation/qwen35-source/lt \
  --page-count 4 \
  --locale lt-LT

node --import tsx scripts/import-evaluation/qwen35-grounding-run.ts \
  --proposals .scratch/import-evaluation/runs/qwen35-lt-fullpage.json \
  --vision .scratch/import-evaluation/raw/lt.service.pdfkit.json \
  --output .scratch/import-evaluation/runs/qwen35-lt-grounded.json \
  --private-root .scratch/import-evaluation
```

The model receives only rendered pages and the fixed document JSON prompt. Grounding retains a
label/value proposal only when native observations provide one unique row or bounded contiguous
span; model-only units, dates, specimen context, mappings, and trend eligibility remain unresolved.
The result records model, projector, runtime, prompt, grammar, and locale provenance. This is an
evaluation pipeline, not a production admission path.

Native reader snapshots are reusable only after the baseline adapter writes a matching private
binding. The binding records the report SHA-256, reader and runtime versions, reader binary and
source hashes, and snapshot SHA-256; it has no report ID. A fresh baseline run is the default:

```sh
node --import tsx scripts/import-evaluation/run.ts \
  --root .scratch/import-evaluation \
  --reports lt,en,de \
  --run-id baseline-v5 \
  --adapter alyte=scripts/import-evaluation/alyte-service-baseline.ts
```

To reuse the already bound native reader snapshots for another immutable run, repeat the command
with a new run ID and `ALYTE_EVAL_REUSE_READERS=1`:

```sh
ALYTE_EVAL_REUSE_READERS=1 node --import tsx scripts/import-evaluation/run.ts \
  --root .scratch/import-evaluation \
  --reports lt,en,de \
  --run-id baseline-reuse-v5 \
  --adapter alyte=scripts/import-evaluation/alyte-service-baseline.ts
```

The adapter verifies the binding against the selected report, reader toolchain, and snapshot bytes
before parsing. A mismatch stops reuse. To assemble a safe comparison from existing aggregate
files without rerunning an adapter or model, provide those paths explicitly:

```sh
node --import tsx scripts/import-evaluation/collect-comparison.ts \
  --private-root .scratch/import-evaluation \
  --input .scratch/import-evaluation/aggregate/final-baseline-v5/lt.json \
  --input .scratch/import-evaluation/aggregate/final-baseline-v5/en.json \
  --input .scratch/import-evaluation/aggregate/final-baseline-v5/de.json \
  --output .scratch/import-evaluation/aggregate/final-baseline-v5/comparison.json
```

The collector accepts individual safe aggregates and per-report aggregate wrappers, validates
report hashes and expected counts, and writes only safe counts and timings to the comparison JSON
and Markdown. Detailed scores and source observations remain in their original private artifacts.
