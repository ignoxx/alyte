# Alyte

Alyte is a personal biomarker-history and intake-awareness product. This glossary keeps
source documents, collection events, biological concepts, and measured values distinct.

## Laboratory history

**Lab Report**:
An imported source document or image issued by a laboratory. A Lab Report may contain one or more
Lab Records.
_Avoid_: Test, results file

**Lab Record**:
A set of laboratory Measurements belonging to one specimen-collection event. Its date is the
collection date, not the date a Lab Report was created or delivered.
_Avoid_: Lab Report, Blood Test, panel

**Specimen Type**:
The biological material from which a Measurement was obtained, such as blood, serum, plasma,
urine, stool, saliva, or an unknown material.
_Avoid_: Panel

**Biomarker**:
A biological characteristic that can be measured, such as LDL cholesterol or vitamin D. It is the
thing being measured, not the measured value.
_Avoid_: Result, value

**Comparable Biomarker**:
A Biomarker with tested identity, specimen, value-type, and unit rules that allow compatible
Measurements to form a Measured Trend.
_Avoid_: Any extracted label, Influence-linked Biomarker

**Influence-linked Biomarker**:
A Biomarker supported by at least one approved Evidence Relationship. It need not yet be a
Comparable Biomarker in the laboratory-history catalogue.
_Avoid_: Comparable Biomarker

**Measurement**:
An observed value for one Biomarker in one Lab Record, including its original unit and applicable
reference information.
_Avoid_: Biomarker, test

**Laboratory Reference Interval**:
The comparison interval or decision information printed by the issuing laboratory for a
Measurement. It is preserved as source provenance and is not replaced by Alyte guidance.
_Avoid_: General Guidance, good zone, personal target

**General Guidance**:
A separately labelled, authoritative, versioned comparison threshold whose jurisdiction and
applicability are known. It can be a fallback when a report has no reference interval, but it is
not a universal healthy range or personal treatment target.
_Avoid_: Laboratory Reference Interval, optimal range, Alyte range

**Panel**:
An optional named grouping of related Measurements within a Lab Record, such as a lipid panel.
_Avoid_: Lab Record

**Extraction Draft**:
Locally or remotely extracted proposed Lab Records and Measurements that remain editable and
unconfirmed until the person reviews them. Recognition uncertainty belongs to individual fields or
rows rather than implying medical confidence.
_Avoid_: Lab Record, confirmed history, diagnosis confidence

## Intake awareness

**Intake Event**:
A time-stamped record of something a person consumed or administered, such as food, a drink, a
supplement, or medication. An Intake Event may contain one or more Intake Components.
_Avoid_: Meal, log entry

**Analysis Inclusion**:
A reversible local state controlling whether an Intake Event may contribute to Related Wellness
Context. Exclusion retains the event and its source media in the timeline but removes it from
future analysis inputs.
_Avoid_: Deletion, cloud consent, scientific validity

**Intake Component**:
One identified substance within an Intake Event, such as croissant, vitamin D, or a medication.
_Avoid_: Intake Event

**Intake Image**:
A photo deliberately submitted to help identify or describe an Intake Event or Intake Component,
including a meal, drink, supplement, medication, package, label, or ingredient list.
_Avoid_: Lab Report

**Snap**:
The fast capture action that saves an Intake Image locally, creates an Intake Event, and—when the
person has enabled and purchased cloud processing—queues its analysis without making them wait on
the result screen.
_Avoid_: Cloud Analysis, confirmed interpretation, Lab Report scan

**Nutrition Bucket**:
A versioned qualitative category derived from estimated Intake Components and portion context,
such as lower, moderate, or higher energy. It communicates a broad estimate rather than an exact
calorie or nutrient measurement.
_Avoid_: Nutrition fact, exact macro, laboratory measurement

## Trends and insights

**Measured Trend**:
A change or pattern calculated only from comparable laboratory Measurements collected at different
times.
_Avoid_: Prediction, Related Wellness Context

**Evidence Relationship**:
A versioned, sourced scientific association between an intake concept and a Biomarker, including
its direction, evidence strength, applicable time horizon, and important caveats.
_Avoid_: Model opinion, personal effect

**Influence Candidate**:
An internal model proposal that an Intake Component may relate to a Biomarker. It is not shown as a
health insight unless an evidence-validation step resolves it to an Evidence Relationship.
_Avoid_: Evidence Relationship, Related Wellness Context

**Potential Relationship**:
A general educational explanation of an Evidence Relationship relevant to a recent Intake Event.
It does not claim that a personal pattern exists.
_Avoid_: Related Wellness Context, effect

**Related Wellness Context**:
A user-facing view that places logged intake patterns, a Measured Trend, and one or more general
Evidence Relationships side by side without deciding what caused the person's result.
_Avoid_: Possible Influence, personal effect, prediction, cause, personalized interpretation

**Insight Feedback**:
A person's correction, dismissal, or relevance judgment about Related Wellness Context or its
inputs.
It can guide that person's future experience but is not scientific counter-evidence.
_Avoid_: Proof, model training label

**Invalidated Insight**:
A previously saved insight whose source Measurement, Intake Event, Analysis Inclusion, or evidence
version changed in a way that makes its prior conclusion inapplicable. It is retained as history but
is not treated as current.
_Avoid_: Deleted insight, corrected source, current insight

## Documents and privacy

**Original Report**:
The unchanged Lab Report imported by the user and retained only on the device.
_Avoid_: Sanitized Report

**Sanitized Report**:
A separately rendered derivative of an Original Report from which selected information and
recoverable document metadata have been irreversibly removed.
_Avoid_: Original Report, redaction overlay

**Full Export**:
A portable copy of all user-controlled local records and all app-controlled cloud account data,
including source media when the user chooses to include it.
_Avoid_: Cloud sync, iPhone backup

## Commercial access

**Cloud Request**:
An accepted asynchronous backend job identified by an opaque request ID. A Cloud Request may still
be pending or may fail; creating it alone does not consume an allowance.
_Avoid_: Cloud Analysis, local job, Intake Event

**Cloud Analysis**:
One Cloud Request that has produced a schema-valid, usable report-extraction or Intake Image result.
It consumes the applicable allowance whether or not the device fetches that result before its
transient retrieval window expires.
_Avoid_: Cloud Request, local processing, provider call
