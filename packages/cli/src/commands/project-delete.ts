import { hubHttpBase } from "@aso/shared";
import { api } from "../hub-api.js";

export interface ProjectDeleteOptions {
  hub: string;
  force?: boolean;
}

interface ProjectDeleted {
  project: string;
  tasks: number;
  plans: number;
}

export async function projectDeleteCommand(project: string, opts: ProjectDeleteOptions): Promise<void> {
  const route = `/api/projects/${encodeURIComponent(project)}/delete`;
  const done = await api<ProjectDeleted>(hubHttpBase(opts.hub), route, { method: "POST", body: JSON.stringify({ force: opts.force ?? false }) });
  console.log(`deleted ${done.project} from the Hub, with its ${done.tasks} task(s) and ${done.plans} plan(s). Any GitHub repository is untouched`);
}
