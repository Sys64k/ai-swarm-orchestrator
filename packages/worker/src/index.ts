export { DEFAULT_WORK_DIR, startWorker, type WorkerOptions, type WorkerHandle } from "./client.js";
export { profileHardware, sampleLoad, type LoadMetrics } from "./hardware.js";
export {
  AgentGitClient,
  AgentGitError,
  ProtectedFileError,
  RebaseConflictError,
  type AgentGitClientOptions,
  type CompletedTask,
} from "./git/agent-git-client.js";
export {
  DependencyRejectedError,
  JobRunner,
  unconfiguredExecutor,
  type DependencyRequest,
  type ModelReply,
  type ModelTurn,
  type ExecutionContext,
  type TaskAssignment,
  type TaskExecutor,
  type TestExecution,
} from "./jobs.js";
export { runCommand, type CommandResult } from "./run-command.js";
export { LlmTaskExecutor, ModelError } from "./agent/executor.js";
export { AgentTools, TOOL_OUTPUT_LIMIT, type ToolCall, type ToolHost, type ToolResult } from "./agent/tools.js";
