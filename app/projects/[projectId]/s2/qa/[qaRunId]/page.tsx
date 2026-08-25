import { S2QaScreen } from "../../../../../components/S2Client";
import { guardProjectRoute } from "../../../route-guard";

export default async function QaPage({ params }: { params: Promise<{ projectId: string; qaRunId: string }> }) {
  const { projectId, qaRunId } = await params;
  guardProjectRoute(projectId, "s2");
  return <S2QaScreen projectId={projectId} qaRunId={qaRunId} />;
}
