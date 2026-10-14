import { PlanPage } from "../../../components/plan-page.tsx";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlanPage id={id} />;
}
