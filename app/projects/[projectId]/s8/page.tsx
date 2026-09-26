import { S8Screen } from "../../../components/S8Client";

export default async function S8Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <S8Screen projectId={projectId} />;
}
