# Sol/Luna ticket orchestration

Use this runbook when implementation work is delegated from an Alyte ticket. It governs scheduling,
isolation, review, and integration; product behavior remains authoritative in the MVP spec and ADRs.

## Roles

**Sol is the manager and integrator.** Sol selects the dependency frontier, identifies collision
risk, creates worktrees, writes the complete assignment prompt, owns the one post-implementation
review, turns accepted findings into a remediation brief, integrates commits, runs cross-ticket
verification, and updates ticket status. Sol does not implement ticket code.

**Luna is the implementer.** Every implementation assignment uses model `gpt-5.6-luna` with
reasoning effort `xhigh`. Luna receives one ticket sized for a fresh context, works only in the
assigned branch and worktree, invokes Matt Pocock's `implement` skill, and returns an implementation
commit for Sol's review. Luna also owns every remediation code change Sol requests.

Project-wide architecture, dependency scheduling, shared-interface ownership, and integration stay
with Sol.

## Dispatch gate

Sol dispatches a ticket only when:

1. every declared blocker is integrated into the manager branch;
2. its acceptance criteria and the highest worthwhile test seam for its non-trivial risks are unambiguous;
3. its expected write set does not overlap another active ticket's write set;
4. shared contracts, migrations, catalogue IDs, and navigation extension points it consumes are
   already integrated;
5. the base branch is green; and
6. the assignment fits one fresh agent context.

Sol splits a ticket that exceeds the context bound before dispatch. A running Luna stays within the
assigned scope.

## Frontier and collision lanes

The dependency frontier contains tickets whose blockers are integrated. Frontier status permits a
ticket to start; it does not require every frontier ticket to run simultaneously.

Use these collision lanes:

- **foundation:** workspace configuration, lockfile, service container, root navigation, migrations,
  and generated native projects;
- **labs:** report import, sanitization, extraction, laboratory history, and comparison;
- **intake:** Home, Log, Snap, Intake Events, and Intake Components;
- **cloud-commerce:** identity, purchases, allowance, API, worker, queue, and result transport;
- **evidence:** catalogue schemas, reviewed content, relationships, and insight derivation; and
- **control-release:** export, deletion, privacy, onboarding, accessibility, and release assets.

At most one active ticket owns a lane. A ticket may consume stable interfaces from another lane
without owning it. A shared file makes tickets collision-prone even when their feature names differ;
Sol schedules those tickets sequentially or first lands an extension point.

The collaboration limit permits Sol plus three Luna agents. Three is a ceiling, not a target:
dispatch only the conflict-free subset of the frontier.

## Worktrees and exclusive resources

Ticket 01 establishes the repository and first green commit in the primary worktree. After that,
every parallel Luna receives a branch named `agent/<ticket>-<slug>` and a dedicated sibling
worktree. The primary worktree remains Sol's integration surface.

Sol records the base commit before dispatch. Agents do not switch branches in another worktree,
edit the primary worktree, rewrite shared history, merge the manager branch, or delete worktrees.
When an upstream contract changes during a ticket, Sol chooses whether to rebase, adjust the ticket,
or redispatch from the new base.

Lockfiles, root workspace configuration, database migration numbers, public contract schemas,
catalogue identifiers, root navigation registration, and generated native projects are exclusive
resources. Sol grants one ticket explicit ownership or lands the shared change before consumers
start.

## Luna assignment contract

Every Luna prompt states the ticket number, worktree, base commit, owned lane, permitted shared
surfaces, and required reading. It tells Luna to:

1. read the active agent instructions, domain glossary, relevant ADRs, MVP spec, and assigned ticket;
2. invoke Matt Pocock's `implement` skill for the ticket;
3. for Expo/EAS or mobile-app work, invoke official `expo-overview` first and every applicable leaf
   skill it selects before planning or editing; for mobile UI, also invoke
   `appllama-app-design-skill` and complete its reference-study and Simulator loop;
4. use TDD where practical for non-trivial or costly failure modes at the ticket's pre-agreed highest
   seam, without pursuing a coverage percentage or testing obvious low-risk wiring;
5. preserve unrelated work and remain inside the ticket boundary;
6. run typechecking and risk-focused tests throughout, then the complete existing suite once at the
   end; running it does not require expanding coverage beyond the ticket's worthwhile risks;
7. commit the complete implementation to the assigned branch; and
8. report the commit hash, tests run, acceptance criteria satisfied, residual risks, and any shared
   contract or migration introduced.

Luna stops and reports when a missing product decision would alter the spec, a required shared
surface belongs to another active agent, or real health data would be required.

## Sol integration contract

For each returned branch, Sol:

1. confirms the commit is based on the recorded base and contains only the assigned slice;
2. invokes Matt Pocock's `code-review` skill exactly once against the recorded base and assigned
   GitHub issue; the skill's internal Standards and Spec reviewers together count as that one pass;
3. filters the findings against the ticket boundary and sends Luna one consolidated, high-level
   remediation brief containing every accepted change, rather than prescribing line edits;
4. has Luna implement and commit the accepted remediation, then checks only that the named findings
   are resolved and the affected tests pass—Sol does not run a second review skill pass or edit code;
5. reruns focused tests and integration checks affected by already-merged tickets;
6. integrates one branch at a time and resolves no semantic conflict without rechecking both tickets;
7. runs combined typechecking and relevant tests after each integration;
8. marks the ticket complete only when every acceptance criterion is demonstrated; and
9. removes the worktree only after the commit is integrated and recoverable.

One review is enough. A remediation check verifies the accepted findings and green tests; it does
not reopen broad review. A fundamental spec conflict or missing product decision returns to the
maintainer instead of becoming an implementation guess.

A merge conflict is evidence that ownership or sequencing was wrong. Sol resolves the underlying
contract deliberately and adjusts later dispatches instead of mechanically accepting one side.

The delivery order is: make the smallest complete experience work, validate users and revenue, then
improve it. Sol declines speculative abstractions, broad refactors, polish, and low-value tests that
delay the first two stages without reducing a material release risk.

## Planned parallel waves

These are opportunities rather than promises; Sol recalculates after each integration.

1. Ticket 01 runs alone because no repository commit or stable extension surface exists yet.
2. Tickets 02 and 12 may run together after 01 when labs/persistence and cloud identity remain in
   separate lanes.
3. Tickets 03, 10, and 13 may run together after their blockers merge.
4. Tickets 04, 05, and 11 have separate native/feature ownership, but Sol serializes 04 and 05 if
   the import coordinator is not yet a stable extension point.
5. Tickets 06 and 14 may run together after their blockers merge.
6. Tickets 08, 09, and 15 may run together after ticket 07 and cloud transport are integrated,
   provided catalogue identifier allocation is assigned before dispatch.
7. Tickets 16, 17, and 19 overlap only when shared disclosure and catalogue surfaces are stable;
   otherwise Sol serializes them.
8. Ticket 18 follows the completed trend and relationship paths. Ticket 20 is the final integrated
   release gate and runs without parallel feature work.

## Planning-only boundary

Writing the spec, tickets, and this runbook does not authorize implementation. Sol starts ticket 01
only after the user explicitly asks implementation to begin.
