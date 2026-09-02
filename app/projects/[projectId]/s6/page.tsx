import { S6Screen } from "../../../components/S6Client";

export default async function S6Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <S6Screen projectId={projectId} />;
}
