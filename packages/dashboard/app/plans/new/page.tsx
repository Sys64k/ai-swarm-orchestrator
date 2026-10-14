import { NewPlan } from "../../../components/new-plan.tsx";

export default async function Page({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams;
  return <NewPlan project={project} />;
}
