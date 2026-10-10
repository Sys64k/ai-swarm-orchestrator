export { startWorker, type WorkerOptions, type WorkerHandle } from "./client.js";
export { profileHardware } from "./hardware.js";
export {
  AgentGitClient,
  AgentGitError,
  ProtectedFileError,
  RebaseConflictError,
  PROTECTED_FILENAMES,
  type AgentGitClientOptions,
  type CompletedTask,
} from "./git/agent-git-client.js";
