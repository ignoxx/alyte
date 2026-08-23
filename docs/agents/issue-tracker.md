# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues. Use the `gh` CLI from this clone so the
`origin` remote selects `ignoxx/alyte` automatically.

## Conventions

- Create: `gh issue create --title "..." --body-file -`, using a quoted heredoc for multiline text.
- Read: `gh issue view <number> --comments` and fetch labels with `--json` when status matters.
- List: `gh issue list --state open --json number,title,body,labels,comments` with the applicable
  label and state filters.
- Comment: `gh issue comment <number> --body-file -` for multiline evidence.
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --reason completed` after integration and acceptance evidence.

Pull requests are not a request or triage surface for Alyte.

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch the
relevant ticket, read the complete GitHub issue and its comments.
