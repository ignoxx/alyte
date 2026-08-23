# Issue 31 acceptance navigation simulator pass

- Date: 2026-08-23
- Device: iPhone 17 Pro simulator, iOS 26.5
- Build: clean `AlyteDevelopment` Debug build from the issue 31 worktree
- Input: `alyte-synthetic-lab-report.pdf` only
- Input method: virtual pointer through the Simulator accessibility interface

## Checks

1. Home showed exactly Home, Labs, and Settings in the native tab bar. Snap, Log, account, and paywall surfaces were absent.
2. Home > Import another Lab Report opened `Import a Lab Report` as a root full-screen task. The tab bar was not visible. Cancel returned to Home and restored the tab bar.
3. Labs > Import a report opened the same root full-screen task. The tab bar was not visible. Cancel returned to Labs and restored the tab bar.
4. Selecting the synthetic PDF from Files completed import and opened `Review Sanitized Report` in the full-screen PDFKit privacy workspace with Cancel and Done.
5. Done returned to the imported Lab Report detail and restored the three-tab shell.

Result: pass.
