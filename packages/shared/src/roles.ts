import type { AgentToolName } from "./agent-tools.js";
import type { AgentRole } from "./protocol.js";

export interface RolePolicy {
  /** Tools this role's agent is given. */
  tools: readonly AgentToolName[];
  /**
   * Repo paths the role may create, edit or delete. "any" still excludes protected files
   * (package.json, lockfiles). Patterns: `*` within a segment, `**` across segments.
   */
  writable: "any" | "none" | readonly string[];
}

const EXPLORE: AgentToolName[] = ["list_files", "read_file", "search"];
const BUILD: AgentToolName[] = [
  ...EXPLORE,
  "write_file",
  "edit_file",
  "delete_file",
  "run_command",
  "request_dependencies",
  "set_package_scripts",
  "finish",
];

/** Test code, specs and their configuration. */
export const QA_WRITABLE = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/test/**",
  "**/tests/**",
  "**/e2e/**",
  "**/fixtures/**",
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  "**/playwright.config.*",
  "**/jest.config.*",
] as const;

/** Containers, CI and deployment configuration. */
export const DEVOPS_WRITABLE = [
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/*.dockerfile",
  "**/.dockerignore",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  "**/compose*.yml",
  "**/compose*.yaml",
  ".github/**",
  ".gitlab-ci.yml",
  ".circleci/**",
  "infra/**",
  "deploy/**",
  "ops/**",
  "scripts/**",
  "Makefile",
  ".env.example",
] as const;

/**
 * What each role may do. The worker's tools enforce this, and the Hub re-checks every task
 * branch against it before QA. Backend and frontend are scoped by their prompts, not by
 * paths, because project layouts vary too much for a fixed rule.
 */
export const ROLE_POLICIES: Record<AgentRole, RolePolicy> = {
  architect: { tools: [...EXPLORE, "submit_plan", "ask_questions"], writable: "none" },
  backend: { tools: BUILD, writable: "any" },
  frontend: { tools: BUILD, writable: "any" },
  qa: { tools: BUILD, writable: QA_WRITABLE },
  devops: { tools: BUILD, writable: DEVOPS_WRITABLE },
};

const globCache = new Map<string, RegExp>();

/** Minimal glob: `**` spans directories, `*` and `?` stay within one path segment. */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) return re;
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  re = new RegExp(`^${out}$`);
  globCache.set(glob, re);
  return re;
}

export function matchesAny(repoPath: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(repoPath));
}

/** Why `role` may not modify `repoPath`, or undefined if it may. */
export function writeDenial(role: AgentRole, repoPath: string): string | undefined {
  const { writable } = ROLE_POLICIES[role];
  if (writable === "any") return undefined;
  if (writable === "none") return `the ${role} role is read-only`;
  if (matchesAny(repoPath, writable)) return undefined;
  const what = role === "qa" ? "test files" : role === "devops" ? "container, CI and deployment files" : "its own files";
  return `the ${role} role may only modify ${what}; ${repoPath} is outside that scope`;
}
