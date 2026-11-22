---
kind: rule
id: review-checklist
displayName: Review checklist
---

Read the diff before the summary.

Check that the change is tested, that a failure path is not silent, and that no
secret appears in a source, a log line or an error message.

Report what you could not verify instead of assuming it.
