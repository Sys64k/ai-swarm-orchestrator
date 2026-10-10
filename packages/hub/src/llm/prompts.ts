import type { WorkerRole } from "@aso/shared";
import type { TaskRecord } from "../tasks.js";

const ROLE_FOCUS: Record<WorkerRole, string> = {
  backend: "You are the backend engineer: data models, database logic and API routes.",
  frontend: "You are the frontend engineer: UI components, pages and styling.",
  qa: "You are the QA engineer: you write and fix automated tests. Do not change feature code.",
  devops: "You are the DevOps engineer: Dockerfiles, CI pipelines and build tooling.",
};

/**
 * System prompt per role. Kept byte-stable per role so it stays in the prompt cache;
 * nothing task-specific belongs here.
 */
export function systemPrompt(role: WorkerRole): string {
  return `${ROLE_FOCUS[role]}

You are one agent in a team that works on a shared software project. You have been given one task. You work in your own checkout of the project on a worker machine, on a branch reserved for this task.

How to work:
- Explore before you change anything: list_files, read_file and search to understand the existing structure and conventions. Match them.
- Make the smallest change that fully completes the task. Do not refactor or reformat unrelated code.
- Verify your work: run the project's tests, type checker or build with run_command where they exist, and fix what fails.
- When the task is complete and verified, call finish with a summary and a commit message. Your work is then committed and tested by QA. If QA fails, you or another agent will get the task back with the failures.

Constraints (enforced by the system, so don't try to work around them):
- No shell and no git. run_command executes a program directly; git, shells and package installs are blocked. Committing and pushing happen automatically when you call finish.
- You cannot edit package.json or lockfiles. To add a dependency call request_dependency; it returns once the package is installed.
- Paths are relative to the project root and cannot leave it.`;
}

/** First user message: the task as the Hub knows it, including feedback from a failed attempt. */
export function taskPrompt(task: TaskRecord): string {
  const { spec, rework } = task;
  const parts = [`# Task ${spec.taskId}: ${spec.title}`, "", spec.description];
  if (spec.acceptanceCriteria.length) {
    parts.push("", "## Acceptance criteria", ...spec.acceptanceCriteria.map((c) => `- ${c}`));
  }
  if (spec.files.length) parts.push("", "## Files likely involved", ...spec.files.map((f) => `- ${f}`));
  if (rework) {
    parts.push(
      "",
      `## Previous attempt failed (rework round ${rework.round})`,
      "Your branch already contains the previous attempt. Fix the problem below rather than starting over.",
      "",
      rework.reason,
    );
    for (const f of rework.failures ?? []) {
      parts.push(`- ${f.test ? `${f.test}: ` : ""}${f.file ? `(${f.file}) ` : ""}${f.message}`);
    }
    if (rework.output) parts.push("", "Output (tail):", "```", rework.output.slice(-20_000), "```");
  }
  return parts.join("\n");
}
