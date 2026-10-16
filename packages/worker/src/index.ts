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
export { holdsLock, lockWorkDir, WORK_DIR_LOCK, WorkDirLockedError, type LockEnv, type WorkDirLock } from "./work-dir-lock.js";
export { runCommand, type CommandResult } from "./run-command.js";
export {
  DockerSandbox,
  defaultSandboxImage,
  dockerRunArgs,
  hostRunner,
  type CommandRunner,
  type DockerRunSpec,
  type DockerSandboxOptions,
  type RunOptions,
} from "./sandbox.js";
export { AgentStoppedError, LlmTaskExecutor, ModelError, callModelWithRetry, describe as describeToolCall } from "./agent/executor.js";
export { ModelChannel, type ModelSubject } from "./model-channel.js";
export { AgentTools, TOOL_OUTPUT_LIMIT, type ToolCall, type ToolHost, type ToolResult } from "./agent/tools.js";
