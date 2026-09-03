import { S7Screen } from "../../../components/S7Client";

export default async function S7Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <S7Screen projectId={projectId} />;
}
