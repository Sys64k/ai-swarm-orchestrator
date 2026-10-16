import { WorkerPage } from "../../../components/worker-page.tsx";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkerPage id={id} />;
}
