import { S4Screen } from "../../../components/S4Client";

export default async function S4Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <S4Screen projectId={projectId} />;
}
