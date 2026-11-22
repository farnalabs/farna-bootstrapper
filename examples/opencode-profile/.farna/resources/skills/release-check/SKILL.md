---
kind: skill
id: release-check
description: Walks the release checklist and reports what it could not verify.
---

Use this skill before a release.

1. Confirm the source tree is clean and `check` exits `0`.
2. Read the changelog entry and the limitations it states.
3. Report every step you could not verify, instead of assuming it passed.
