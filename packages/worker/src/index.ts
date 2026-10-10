export { DEFAULT_WORK_DIR, startWorker, type WorkerOptions, type WorkerHandle } from "./client.js";
export { profileHardware, sampleLoad, type LoadMetrics } from "./hardware.js";
export {
  AgentGitClient,
  AgentGitError,
  ProtectedFileError,
  RebaseConflictError,
  PROTECTED_FILENAMES,
  type AgentGitClientOptions,
  type CompletedTask,
} from "./git/agent-git-client.js";
