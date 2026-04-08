# AGENTS.md

## Formatting Memory

Only stop a task if the user explicitly asks to stop.
When showing tables in terminal responses for this repo, use a fixed-width code block table, not markdown tables, with vertically aligned columns.
When a list is easier to reference, use numbered points instead of plain bullets.

## Delete Rule

If deleting files or directories is part of the fix in this repo, do it directly.
Do not stop to ask for permission again once the user has already said to just do it.
Prefer direct non-interactive deletes over pausing the work.
