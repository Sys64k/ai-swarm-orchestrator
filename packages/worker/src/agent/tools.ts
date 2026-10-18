import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AGENT_TOOLS,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  isAgentToolName,
  isProtectedPath,
  ROLE_POLICIES,
  writeDenial,
  type AgentRole,
  type AgentToolInput,
  type MessageOf,
} from "@aso/shared";
import { DependencyRejectedError, type DependencyRequest } from "../jobs.js";
import type { CommandRunner } from "../sandbox.js";
import { probeImage } from "./image.js";

const exec = promisify(execFile);

/** Characters of tool output returned to the model per call. */
export const TOOL_OUTPUT_LIMIT = 50_000;
const READ_DEFAULT_LINES = 2000;
const LIST_LIMIT = 2000;
const SEARCH_LIMIT_LINES = 300;

/** Programs the agent may not run: version control is managed for it, and shells would bypass every other rule. */
const BLOCKED_PROGRAMS = new Set(["git", "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "sudo", "su", "doas"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const BLOCKED_PM_COMMANDS = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "link", "dedupe", "prune",
]);

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
  /** view_image: the image itself, base64-encoded, sent to the model with `content`. */
  image?: { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string };
}

export interface ToolHost {
  repoDir: string;
  /** Decides which tools are available and which paths may be written. */
  role: AgentRole;
  requestDependencies(packages: DependencyRequest[]): Promise<{ mainCommit: string }>;
  setPackageScripts(scripts: Record<string, string>): Promise<{ mainCommit: string }>;
  fileOperation(op: Omit<MessageOf<"FILE_OPERATION">["payload"], "taskId">): void;
  /** Where run_command executes: the job sandbox, or directly on this machine. */
  commands: CommandRunner;
}

class ToolError extends Error {}

/**
 * Executes the agent's tool calls inside the task checkout. Inputs come from the model and
 * are untrusted: every call is schema-validated and every path is confined to the checkout.
 * The file tools and the program blocklist are guardrails for a cooperative agent. What
 * contains a misbehaving one is the job sandbox `run_command` executes in (when the worker
 * runs with Docker) and the Hub's checks (push policy, protected files, QA), which protect main.
 */
export class AgentTools {
  private rootReal?: string;

  constructor(private readonly host: ToolHost) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const done = (content: string, isError = false): ToolResult => ({
      toolUseId: call.id,
      content: truncate(content),
      isError,
    });
    // finish / submit_plan / ask_questions end the agent loop and are handled by its caller.
    if (!isAgentToolName(call.name) || call.name === "finish" || call.name === "submit_plan" || call.name === "ask_questions") {
      return done(`unknown tool: ${call.name}`, true);
    }
    if (!ROLE_POLICIES[this.host.role].tools.includes(call.name)) {
      return done(`${call.name} is not available to the ${this.host.role} role`, true);
    }

    const parsed = AGENT_TOOLS[call.name].input.safeParse(call.input);
    if (!parsed.success) {
      return done(`invalid input for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, true);
    }
    try {
      switch (call.name) {
        case "list_files":
          return done(await this.listFiles(parsed.data as AgentToolInput<"list_files">));
        case "read_file":
          return done(await this.readFile(parsed.data as AgentToolInput<"read_file">));
        case "search":
          return done(await this.search(parsed.data as AgentToolInput<"search">));
        case "view_image":
          return { ...done(""), ...(await this.viewImage(parsed.data as AgentToolInput<"view_image">)) };
        case "write_file":
          return done(await this.writeFile(parsed.data as AgentToolInput<"write_file">));
        case "edit_file":
          return done(await this.editFile(parsed.data as AgentToolInput<"edit_file">));
        case "delete_file":
          return done(await this.deleteFile(parsed.data as AgentToolInput<"delete_file">));
        case "run_command":
          return await this.runCommand(parsed.data as AgentToolInput<"run_command">, done);
        case "request_dependencies":
          return done(await this.requestDependencies(parsed.data as AgentToolInput<"request_dependencies">));
        case "set_package_scripts":
          return done(await this.setPackageScripts(parsed.data as AgentToolInput<"set_package_scripts">));
      }
    } catch (err) {
      return done(err instanceof ToolError ? err.message : `${call.name} failed: ${(err as Error).message}`, true);
    }
  }

  /** Absolute path inside the checkout; rejects anything (including via symlinks) that leaves it. */
  private async resolve(repoPath: string): Promise<string> {
    this.rootReal ??= await realpath(this.host.repoDir);
    const target = path.resolve(this.host.repoDir, repoPath);
    let probe = target;
    while (!existsSync(probe)) probe = path.dirname(probe);
    const real = await realpath(probe);
    const rel = path.relative(this.rootReal, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ToolError(`${repoPath} resolves outside the project`);
    return target;
  }

  private writable(repoPath: string): void {
    if (isProtectedPath(repoPath)) {
      throw new ToolError(`${repoPath} is managed by the Hub; use request_dependencies to add packages`);
    }
    const denial = writeDenial(this.host.role, repoPath);
    if (denial) throw new ToolError(denial);
  }

  private async listFiles({ path: dir }: AgentToolInput<"list_files">): Promise<string> {
    if (dir) await this.resolve(dir);
    const { stdout } = await exec(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", dir ?? "."],
      { cwd: this.host.repoDir, maxBuffer: 32 * 1024 * 1024 },
    );
    const files = [...new Set(stdout.split("\n").filter(Boolean))].sort();
    if (files.length === 0) return "(no files)";
    const shown = files.slice(0, LIST_LIMIT).join("\n");
    return files.length > LIST_LIMIT ? `${shown}\n… ${files.length - LIST_LIMIT} more (narrow with path)` : shown;
  }

  private async readFile({ path: p, offset = 1, limit = READ_DEFAULT_LINES }: AgentToolInput<"read_file">): Promise<string> {
    const abs = await this.resolve(p);
    const info = await stat(abs).catch(() => undefined);
    if (!info) throw new ToolError(`${p} does not exist`);
    if (info.isDirectory()) throw new ToolError(`${p} is a directory; use list_files`);
    const buf = await readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) throw new ToolError(`${p} looks like a binary file`);
    const lines = buf.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
    const end = offset - 1 + slice.length;
    return end < lines.length ? `${body}\n… lines ${end + 1}-${lines.length} not shown (use offset)` : body || "(empty file)";
  }

  private async viewImage({ path: p }: AgentToolInput<"view_image">): Promise<Pick<ToolResult, "content" | "image">> {
    const abs = await this.resolve(p);
    const info = await stat(abs).catch(() => undefined);
    if (!info) throw new ToolError(`${p} does not exist`);
    if (info.isDirectory()) throw new ToolError(`${p} is a directory; use list_files`);
    const kb = `${Math.ceil(info.size / 1000).toLocaleString("en-US")} KB`;
    if (info.size > IMAGE_MAX_BYTES) {
      throw new ToolError(`${p} is ${kb}, over the ${IMAGE_MAX_BYTES / 1_000_000} MB limit; screenshot a smaller area or at a lower device scale factor`);
    }
    const buf = await readFile(abs);
    const image = probeImage(buf);
    if (!image) throw new ToolError(`${p} is not a PNG, JPEG, GIF or WebP image`);
    if (image.width < 1 || image.height < 1) throw new ToolError(`${p} has no pixels (${image.width}×${image.height})`);
    if (Math.max(image.width, image.height) > IMAGE_MAX_SIDE) {
      throw new ToolError(`${p} is ${image.width}×${image.height} pixels; the model takes at most ${IMAGE_MAX_SIDE} on a side`);
    }
    const type = image.mediaType.slice("image/".length).toUpperCase();
    return {
      content: `${p}: ${type}, ${image.width}×${image.height} pixels, ${kb}`,
      image: { mediaType: image.mediaType, data: buf.toString("base64") },
    };
  }

  private async search({ pattern, path: p, ignore_case }: AgentToolInput<"search">): Promise<string> {
    if (p) await this.resolve(p);
    const args = ["grep", "-n", "-I", "-E", "--untracked", ...(ignore_case ? ["-i"] : []), "-e", pattern, "--", p ?? "."];
    try {
      const { stdout } = await exec("git", args, { cwd: this.host.repoDir, maxBuffer: 32 * 1024 * 1024 });
      const lines = stdout.split("\n").filter(Boolean);
      const shown = lines.slice(0, SEARCH_LIMIT_LINES).join("\n");
      return lines.length > SEARCH_LIMIT_LINES ? `${shown}\n… ${lines.length - SEARCH_LIMIT_LINES} more matches` : shown;
    } catch (err) {
      const e = err as { code?: number; stderr?: string };
      if (e.code === 1 && !e.stderr) return "(no matches)";
      throw new ToolError(`search failed: ${e.stderr?.trim() || (err as Error).message}`);
    }
  }

  private async writeFile({ path: p, content }: AgentToolInput<"write_file">): Promise<string> {
    this.writable(p);
    const abs = await this.resolve(p);
    const existed = existsSync(abs);
    if (existed && (await stat(abs)).isDirectory()) throw new ToolError(`${p} is a directory`);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    this.host.fileOperation({ op: existed ? "update" : "create", path: p });
    return `${existed ? "updated" : "created"} ${p} (${content.split("\n").length} lines)`;
  }

  private async editFile({ path: p, old_string, new_string, replace_all }: AgentToolInput<"edit_file">): Promise<string> {
    this.writable(p);
    const abs = await this.resolve(p);
    if (!existsSync(abs)) throw new ToolError(`${p} does not exist`);
    const text = await readFile(abs, "utf8");
    const count = text.split(old_string).length - 1;
    if (count === 0) throw new ToolError(`old_string not found in ${p}; read the file and copy the text exactly`);
    if (count > 1 && !replace_all) {
      throw new ToolError(`old_string occurs ${count} times in ${p}; add surrounding context to make it unique or set replace_all`);
    }
    const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
    await writeFile(abs, next);
    this.host.fileOperation({ op: "update", path: p });
    return `edited ${p} (${replace_all ? count : 1} replacement${(replace_all ? count : 1) === 1 ? "" : "s"})`;
  }

  private async deleteFile({ path: p }: AgentToolInput<"delete_file">): Promise<string> {
    this.writable(p);
    const abs = await this.resolve(p);
    const info = await stat(abs).catch(() => undefined);
    if (!info) throw new ToolError(`${p} does not exist`);
    if (info.isDirectory()) throw new ToolError(`${p} is a directory; delete the files in it`);
    await unlink(abs);
    this.host.fileOperation({ op: "delete", path: p });
    return `deleted ${p}`;
  }

  private async runCommand(
    { argv, timeout_sec = 120 }: AgentToolInput<"run_command">,
    done: (content: string, isError?: boolean) => ToolResult,
  ): Promise<ToolResult> {
    const program = path.basename(argv[0]);
    if (BLOCKED_PROGRAMS.has(program)) {
      return done(`${program} is not available to agents (version control happens when you call finish; there is no shell)`, true);
    }
    if (PACKAGE_MANAGERS.has(program) && argv.slice(1).some((a) => BLOCKED_PM_COMMANDS.has(a))) {
      return done(`\`${argv.join(" ")}\` would change dependencies; use request_dependencies instead`, true);
    }
    let result;
    try {
      result = await this.host.commands.run(argv, { cwd: this.host.repoDir, timeoutMs: timeout_sec * 1000, env: { CI: "1" } });
    } catch (err) {
      return done(`cannot run ${argv[0]}: ${(err as Error).message}`, true);
    }
    const status = result.timedOut
      ? `timed out after ${timeout_sec}s`
      : `exit code ${result.exitCode ?? result.signal}`;
    return done(`${status} (${(result.durationMs / 1000).toFixed(1)}s)\n${tail(result.output, TOOL_OUTPUT_LIMIT - 200)}`, result.exitCode !== 0);
  }

  private async setPackageScripts({ scripts }: AgentToolInput<"set_package_scripts">): Promise<string> {
    try {
      const { mainCommit } = await this.host.setPackageScripts(scripts);
      return `package.json scripts updated on main @ ${mainCommit.slice(0, 8)} (${Object.keys(scripts).join(", ")}); your branch was rebased onto it`;
    } catch (err) {
      if (err instanceof DependencyRejectedError) throw new ToolError(`script change rejected by the Hub: ${err.message}`);
      throw err;
    }
  }

  private async requestDependencies({ packages }: AgentToolInput<"request_dependencies">): Promise<string> {
    try {
      const { mainCommit } = await this.host.requestDependencies(packages);
      const names = packages.map((p) => `${p.name}${p.version ? `@${p.version}` : ""}`).join(", ");
      return `${names} ${packages.length === 1 ? "is" : "are"} installed (main @ ${mainCommit.slice(0, 8)}); package.json and the lockfile were updated on main and your branch was rebased`;
    } catch (err) {
      if (err instanceof DependencyRejectedError) throw new ToolError(`dependency rejected by the Hub: ${err.message}`);
      throw err;
    }
  }
}

function truncate(s: string): string {
  return s.length <= TOOL_OUTPUT_LIMIT ? s : `${s.slice(0, TOOL_OUTPUT_LIMIT)}\n… output truncated (${s.length} chars)`;
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : `… (earlier output truncated)\n${s.slice(-n)}`;
}
