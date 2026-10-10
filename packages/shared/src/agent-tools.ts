import { z } from "zod";
import { NpmPackageNameSchema, RepoPathSchema, VersionRangeSchema } from "./protocol.js";

/**
 * Tools the coding agent can call. The Hub sends these definitions to the model; the worker
 * validates each call against the same schemas and executes it inside the task checkout.
 * Agents get no shell and no git: version control goes through AgentGitClient, dependencies
 * through request_dependency.
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
  request_dependency: {
    description:
      "Ask the Hub to add an npm package to the project. You cannot edit package.json or lockfiles yourself. " +
      "Blocks until the package is added on main, your branch is rebased (your edits are kept) and npm ci has run.",
    input: z.strictObject({
      name: NpmPackageNameSchema,
      version: VersionRangeSchema.optional().describe("Semver range; default latest"),
      dev: z.boolean().optional().describe("Add as a devDependency"),
    }),
  },
  finish: {
    description:
      "Call when the task is complete. Your changes are committed with commit_message and sent to QA. " +
      "Do not call it before the work is done and checked.",
    input: z.strictObject({
      summary: z.string().min(1).max(5000).describe("What you changed and how you verified it"),
      commit_message: z.string().min(1).max(500).describe("Conventional, imperative commit message"),
    }),
  },
} as const;

export type AgentToolName = keyof typeof AGENT_TOOLS;
export type AgentToolInput<N extends AgentToolName> = z.infer<(typeof AGENT_TOOLS)[N]["input"]>;

export function isAgentToolName(name: string): name is AgentToolName {
  return Object.hasOwn(AGENT_TOOLS, name);
}

/** Tool definitions in the shape the Messages API expects (`input_schema` is JSON Schema). */
export function agentToolDefinitions(): Array<{ name: AgentToolName; description: string; input_schema: Record<string, unknown> }> {
  return (Object.keys(AGENT_TOOLS) as AgentToolName[]).map((name) => {
    const { $schema: _, ...schema } = z.toJSONSchema(AGENT_TOOLS[name].input) as Record<string, unknown>;
    return { name, description: AGENT_TOOLS[name].description, input_schema: schema };
  });
}
