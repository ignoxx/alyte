# Ground health insights in versioned evidence

Cloud models may interpret Intake Images, structure Intake Components, select applicable
relationships, and explain them, but every displayed Potential Relationship or Related Wellness
Context must resolve to a curated, versioned Evidence Relationship with source material and
deterministic validation. This gives the
model room to reason about messy real-world inputs without allowing its pretrained associations to
become unsupported health claims. Candidate relationships that cannot be grounded are not shown as
facts or health insights.

The model is not constrained to the initial Comparable Biomarker catalogue when proposing
Influence Candidates. An Evidence Relationship may support a general Potential Relationship for a
Biomarker the app cannot yet chart, but the interface must state that limitation and must not turn
the relationship into a personal Measured Trend.

The same rule applies to local Biomarker education: explanations are reviewed, sourced, versioned
content. A model may simplify approved content but cannot invent a new explanation or medical fact
at request time.

Alyte may juxtapose logged intake patterns, Measured Trends, and general research, but it
does not state that a person's intake caused or probably contributed to a measured change. A
disclaimer does not make a diagnostic or personalized causal feature safe; this boundary is
enforced in the domain terms, evidence schema, deterministic validator, copy fixtures, and product
marketing.

Laboratory reference intervals remain distinct from `General guidance`. The report's own interval
and flag are shown first. Any app-supplied threshold must be an authoritative, versioned catalogue
entry with explicit applicability and jurisdiction; disagreement between authorities is disclosed.
When neither the report nor an applicable catalogue entry supplies a range, the app shows no range
instead of inventing a universal `good` or `optimal` zone.

A reviewed baseline evidence catalogue ships with the app and may receive signed, non-personal
updates without an account. Each saved insight retains the catalogue version that produced it;
updates can revalidate current insights locally without rewriting their historical provenance.
