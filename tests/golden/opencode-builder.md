---
description: Writes code, runs the tests, and follows the house conventions.
mode: subagent
model: anthropic/claude-sonnet-4-5
permissions:
  - action: read
    resource: '*'
    effect: allow
  - action: edit
    resource: '*'
    effect: allow
  - action: shell
    resource: '*'
    effect: allow
  - action: shell
    resource: git push *
    effect: deny
  - action: subagent
    resource: '*'
    effect: deny
---
## House style

FBS_RULE_BUILDER_4a1c Write the smallest change that satisfies the ticket.
