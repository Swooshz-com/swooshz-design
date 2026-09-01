import { S5Screen } from "../../../components/S5Client";

export default async function S5Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <S5Screen projectId={projectId} />;
}
