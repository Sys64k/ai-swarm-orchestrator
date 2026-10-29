import { z } from "zod";
import { AGENT_SUMMARY_MAX, CONVERSATION_MAX_IMAGES, IMAGE_MAX_BYTES, QA_SCREENSHOTS_MAX } from "./constants.js";
import {
  MAX_PACKAGES_PER_REQUEST,
  NpmPackageNameSchema,
  PLAN_QUESTIONS_MAX,
  PlannedTaskSchema,
  RepoPathSchema,
  ScriptCommandSchema,
  ScreenshotTargetsSchema,
  ScriptNameSchema,
  VersionRangeSchema,
} from "./protocol.js";

/**
 * Tools the coding agent can call. The Hub sends these definitions to the model; the worker
 * validates each call against the same schemas and executes it inside the task checkout.
 * Agents get no shell and no git: version control goes through AgentGitClient, dependencies
 * through request_dependencies.
 */
export const AGENT_TOOLS = {
  list_files: {
    description:
      "List files in the project (tracked and untracked, honouring .gitignore). Optionally restrict to a directory.",
    input: z.strictObject({
      path: RepoPathSchema.optional().describe("Directory relative to the project root; default: whole project"),
    }),
  },
  read_file: {
    description:
      "Read a text file. Returns numbered lines. Use offset/limit for large files (default: first 2000 lines).",
    input: z.strictObject({
      path: RepoPathSchema,
      offset: z.number().int().min(1).optional().describe("1-based line to start at"),
      limit: z.number().int().min(1).max(5000).optional().describe("Number of lines"),
    }),
  },
  search: {
    description:
      "Search file contents with an extended regular expression (git grep -E). Returns matching lines with file:line prefixes.",
    input: z.strictObject({
      pattern: z.string().min(1).max(500),
      path: RepoPathSchema.optional().describe("Directory or file to restrict the search to"),
      ignore_case: z.boolean().optional(),
    }),
  },
  view_image: {
    description:
      "Look at an image file in the project (PNG, JPEG, GIF or WebP, up to " + IMAGE_MAX_BYTES / 1_000_000 + " MB), e.g. a screenshot " +
      "you saved with run_command (a Playwright script or test that calls page.screenshot). Use it to check how a visual " +
      "change looks. Every image stays in the conversation and costs input on each later turn, so screenshot just the part " +
      "you need at normal scale; a conversation holds at most " + CONVERSATION_MAX_IMAGES + " images.",
    input: z.strictObject({ path: RepoPathSchema }),
  },
  write_file: {
    description: "Create or overwrite a file with the given content. Parent directories are created.",
    input: z.strictObject({ path: RepoPathSchema, content: z.string().max(1_000_000) }),
  },
  edit_file: {
    description:
      "Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Read the file first.",
    input: z.strictObject({
      path: RepoPathSchema,
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
  },
  delete_file: {
    description: "Delete a file.",
    input: z.strictObject({ path: RepoPathSchema }),
  },
  run_command: {
    description:
      "Run a program in the project root, e.g. [\"npm\", \"test\"] or [\"npx\", \"tsc\", \"--noEmit\"]. " +
      "argv is executed directly without a shell (no pipes, globs or &&). git, shells and package installs are not allowed. " +
      "Returns exit code and the tail of combined output.",
    input: z.strictObject({
      argv: z.array(z.string().min(1)).min(1).max(100),
      timeout_sec: z.number().int().min(1).max(900).optional().describe("Default 120"),
    }),
  },
  request_dependencies: {
    description:
      "Ask the Hub to add npm packages to the project. You cannot edit package.json or lockfiles yourself. " +
      "Request every package you need in one call (up to " + MAX_PACKAGES_PER_REQUEST + "): each call is a commit on main " +
      "and the number of calls per task is limited. " +
      "Blocks until the packages are added on main, your branch is rebased (your edits are kept) and npm ci has run.",
    input: z.strictObject({
      packages: z
        .array(
          z.strictObject({
            name: NpmPackageNameSchema,
            version: VersionRangeSchema.optional().describe("Semver range; default latest"),
            dev: z.boolean().optional().describe("Add as a devDependency"),
          }),
        )
        .min(1)
        .max(MAX_PACKAGES_PER_REQUEST)
        .refine((list) => new Set(list.map((p) => p.name)).size === list.length, { message: "each package may appear only once" }),
    }),
  },
  set_package_scripts: {
    description:
      "Ask the Hub to add or update npm scripts in package.json (e.g. test, build, dev, lint). You cannot edit package.json " +
      "yourself. If the project has no package.json yet, the Hub creates one. QA runs `npm test`, so the project needs a test " +
      "script. Install lifecycle scripts (postinstall, prepare, ...) are not allowed. Blocks until the change is on main and " +
      "your branch is rebased (your edits are kept).",
    input: z.strictObject({
      scripts: z
        .record(ScriptNameSchema, ScriptCommandSchema)
        .describe('Script name -> command, e.g. {"test": "node --test", "build": "tsc"}'),
    }),
  },
  finish: {
    description:
      "Call when the task is complete. Your changes are committed with commit_message and sent to QA. " +
      "Do not call it before the work is done and checked.",
    input: z.strictObject({
      summary: z.string().min(1).max(AGENT_SUMMARY_MAX).describe("What you changed and how you verified it"),
      commit_message: z.string().min(1).max(500).describe("Conventional, imperative commit message"),
      screenshots: ScreenshotTargetsSchema.optional().describe(
        "Only when the project has a \"screenshots\" npm script and your change shows in the UI: the views that show it " +
          `(up to ${QA_SCREENSHOTS_MAX}), e.g. the changed page in light and dark and at a phone width. QA screenshots them ` +
          "from the tested commit and shows them to the reviewer; without a list it takes none. List them on every finish, rework included.",
      ),
    }),
  },
  dispute_tests: {
    description:
      "Only for a task whose tests were written first, and only when you are sure one of them is wrong: it contradicts the " +
      "task or the existing code. It ends your attempt (your work so far is kept), and the tests go back to their writer " +
      "once, with your reason. Not for a test that is hard to pass, nor for work you couldn't finish.",
    input: z.strictObject({
      test: z.string().min(1).max(500).describe("The test that is wrong: its file and name"),
      reason: z.string().min(1).max(4000).describe("What in the task or the existing code it contradicts"),
    }),
  },
  submit_plan: {
    description:
      "Architect only. Submit the plan: a summary and the tasks to delegate. Each task has a plan-local key; " +
      "dependsOn lists keys of tasks that must be merged first. The plan goes to a human for approval.",
    input: z.strictObject({
      summary: z.string().min(1).max(10_000).describe("The approach, key design decisions and how the tasks fit together"),
      tasks: z.array(PlannedTaskSchema).min(1).max(25),
    }),
  },
  ask_questions: {
    description:
      "Architect only. Ask the human questions before planning, when the answers would change the plan substantially " +
      "(scope, behaviour, data, which of several reasonable approaches). Planning stops here; it continues with their answers.",
    input: z.strictObject({
      questions: z.array(z.string().min(1).max(1000)).min(1).max(PLAN_QUESTIONS_MAX).describe("Short, specific questions, one per item"),
      context: z.string().max(2000).optional().describe("What you found so far, so the questions make sense"),
    }),
  },
} as const;

export type AgentToolName = keyof typeof AGENT_TOOLS;
export type AgentToolInput<N extends AgentToolName> = z.infer<(typeof AGENT_TOOLS)[N]["input"]>;

export function isAgentToolName(name: string): name is AgentToolName {
  return Object.hasOwn(AGENT_TOOLS, name);
}

/** Tool definitions in the shape the Messages API expects (`input_schema` is JSON Schema). */
export function agentToolDefinitions(
  names: readonly AgentToolName[] = Object.keys(AGENT_TOOLS) as AgentToolName[],
): Array<{ name: AgentToolName; description: string; input_schema: Record<string, unknown> }> {
  return names.map((name) => {
    const { $schema: _, ...schema } = z.toJSONSchema(AGENT_TOOLS[name].input) as Record<string, unknown>;
    return { name, description: AGENT_TOOLS[name].description, input_schema: schema };
  });
}
