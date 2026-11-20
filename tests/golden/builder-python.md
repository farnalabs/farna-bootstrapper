---
name: builder-python
description: Writes Python and runs the Python checks.
model: claude-sonnet-4-5
tools:
  - Bash
  - Bash(pytest *)
  - Edit
  - Read
  - Write
disallowedTools:
  - Agent
---
## House style

FBS_RULE_BUILDER_4a1c

Write the smallest change that satisfies the ticket.

Run the tests before you report.

## Python style

FBS_RULE_PYTHON_5e3b

Prefer pathlib over os.path.

Run pytest before you report.
