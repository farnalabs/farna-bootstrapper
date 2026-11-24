---
description: Writes code, runs the tests, and follows the house conventions.
mode: primary
name: builder
model: anthropic/claude-sonnet-4-5
permission:
  read:
    '*': allow
  edit:
    '*': allow
  bash:
    '*': allow
    git push *: deny
  task:
    '*': deny
---
## House style

FBS_RULE_BUILDER_4a1c Write the smallest change that satisfies the ticket.
