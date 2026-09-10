# Hybrid import evaluation runner

`run-hybrid-import.sh` is the evaluation-only one-command path for one report:

```sh
scripts/import-evaluation/run-hybrid-import.sh \
  --private-root .scratch/import-evaluation \
  --report .scratch/import-evaluation/reports/en.pdf \
  --report-id en \
  --expected .scratch/import-evaluation/ground-truth/en.json \
  --run-id hybrid-q8 \
  --paddle-adapter scripts/import-evaluation/paddleocr-vl16-runtime-adapter.ts \
  --model /path/to/paddleocr-vl-1.6-q8.gguf \
  --projector /path/to/paddleocr-vl-1.6-mmproj.gguf \
  --runtime /path/to/llama-mtmd-cli
```

The repository's concrete runtime adapter is
`scripts/import-evaluation/paddleocr-vl16-runtime-adapter.ts`; pass that path to
`--paddle-adapter` when using the local PaddleOCR-VL1.6 Q8 GGUF and projector. It renders each
planned page as a lossless PNG with Poppler, normalized to 1,800 pixels high while preserving the
page aspect ratio. Pathological responses receive one retry as overlapping 600-pixel vertical
bands with 200-pixel overlap, cropped from the top-left with ImageMagick. It invokes
`llama-mtmd-cli` with a fixed `OCR:` prompt, deterministic decoder settings, and a 30-second hard
timeout per inference, then passes accepted responses through the proven
`paddleocr-vl16-adapter.ts` parser. Each raw stdout, stderr, and rendered crop stays below the
private root with mode `0600`.

The runner validates source-checked ground truth with the existing evaluation preflight, hashes
the report, and reuses a report-bound Poppler layout snapshot when present. Selectable-text pages
with the compatible provenance are routed to the existing header-table v3 extractor. Image,
empty, or mixed-provenance pages are deferred to the PaddleOCR-VL adapter. If no deferred page
exists, the adapter is never invoked.

The adapter seam is `alyte.import-eval.paddle-ocr-vl-llama-mtmd-seam.v1`. The runner invokes a
module or executable with `--report`, `--report-id`, `--private-root`, `--output`, `--plan`,
`--seam-version`, and `--retry`, plus optional `--model`, `--projector`, and `--runtime` paths.
The private plan has no source text or expected rows. An empty `bands` list means a full-page
attempt. A repetition retry supplies overlapping normalized vertical bands; the adapter maps them
to its rendered page size (600px bands with 200px overlap at the default 1,800px height). The adapter
writes an `alyte.import-eval.v1` `PipelineResult` to `--output` and keeps raw model responses and
rendered crops below the private root. The runner discards adapter stdout/stderr, validates report
identity, retries pages that report repetition, and removes exact duplicate rows across crops.

The final pipeline, detailed score, safe aggregate, route plan, adapter outputs, and model/runtime
hashes are mode `0600` below the private root. Ordinary stdout contains only report identity,
pipeline identity, safe counts, and elapsed time.
