# <Title>

| field          | value                                  |
| -------------- | -------------------------------------- |
| task_id        | YYYY-MM-DD-<kebab-slug>                |
| current_stage  | new_feature                            |
| created_at     | YYYY-MM-DD                             |
| project_path   | <abs path to the user's project>       |
| host_session_id| <Cursor host session bound to this task; empty until chat starts> |

## Intent

### Background
What's the current state of the world that makes this task necessary? Why now?

### Objective
The single sentence that defines "done." If you can't write this in one sentence,
the scope is still fuzzy.

### Scope
- **In:**  bullet list of what is in scope
- **Out:** bullet list of what is explicitly NOT in scope (this matters as much as In)

## Structure

### Entities
Business / domain objects this task introduces or modifies. One per bullet.

### Relations
How the entities relate to each other and to existing helm entities (FKs, refs, ...).

### Planned Files
- `path/to/file.ts` — what changes here, and why
- `path/to/another.ts` — ...

The planned_files list is the implement-stage scope contract. To read or modify
anything outside this list, edit it here first with a one-line reason.

## Execution

### Actual Files
Filled during implement. Lists files actually touched + a one-liner per file.

### Patterns Used
Filled during implement. Names of design patterns / helpers reused or introduced.

## Validation

### Test Plan
What will be tested, and how (unit / e2e / manual).

### Cases Added
Filled during implement. Test file paths + the named cases added.

### Lint Results
Filled during implement. Final state of `pnpm typecheck` / `pnpm test` / etc.

## Decisions

Append-only list of non-trivial choices and the reasoning that led to them.
This section is HIDDEN from the reviewer agent — it must form an independent
opinion uncorrupted by the implementer's narrative.

## Risks

Open issues, known footguns, and follow-ups that won't land in this task.

## Related Tasks

Pointers to archive cards for prior tasks that touch overlapping entities or
files. Auto-populated at task creation by `harness_search_archive`.

## Stage Log

Append-only timeline. Every substantive turn appends one entry:

- `YYYY-MM-DD HH:MM` — what changed in the task doc / what stage transition occurred / file budget used
