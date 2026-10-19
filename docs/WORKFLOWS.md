# Workflows

## Goal

Turn repeated terminal procedures into local, editable workflows that can be
reviewed, adjusted for a particular run, and shared as files. A workflow is a
guided runbook rather than an unattended shell script.

## First release

- Store workflow definitions on this device in the Orbit SSH webview storage.
- Include an editable Nginx configuration check, edit, restart, and verification
  workflow on first launch.
- Let users create and edit workflows with parameters, named terminal targets,
  ordered steps, and declared prerequisites.
- From the workflow library, start a run by choosing an SSH host. Reuse a
  connected terminal for that host, or connect to it before loading the run.
- Open the workflow panel beside a terminal, load a local workflow, and bind its
  named targets only to SSH terminals on the current host.
- Let users run, skip, mark complete, mark failed, retry, or jump to any step.
  Missing prerequisites produce a warning but do not block an intentional jump.
- Keep parameter values and one-run command edits out of the saved workflow.
- Export and import one versioned JSON file at a time. Imports are only added to
  the local library; they never execute automatically.
- Render commands before sending them. Quote parameter values for POSIX shells,
  and require an extra confirmation for commands that look destructive.
- Keep run results as user-confirmed states. The app does not infer command
  success from terminal output in this release.
- Keep step states and parameter overrides in the current app session; they do
  not become workflow defaults or export with the workflow.

## Current boundaries

Terminal history currently stores output, not submitted input or a structured
event trace. Reliable recording and AI summarization therefore need a separate
capture layer before they can create trustworthy workflow drafts. Command
execution is deliberately step-by-step, and each step's target must be an
  connected SSH session on the selected host. Automatic completion detection,
  parallel execution, branches, retries, and cross-device sync are out of scope
  for this release.

Imported workflow files contain commands. Review the workflow and the rendered
command before sending it to a server. Workflow files do not include saved
connection credentials, terminal output, or runtime parameter values. Parameter
defaults and commands are part of the workflow, so import and export warn when
they look like they contain hard-coded credentials. This check is heuristic;
review the file before sharing it.

## Next stages

1. Capture structured terminal events, including submitted commands, session
   identity, order, and completion boundaries; allow a user to select a session
   and ask AI to turn its trace into an editable draft.
2. Add multi-terminal run history and reliable completion checks where the
   shell protocol provides them.
3. Add optional branches and condition steps after linear workflows have proven
   useful in day-to-day operation.
