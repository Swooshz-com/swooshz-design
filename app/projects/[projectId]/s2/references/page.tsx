import { S2ReferencesScreen } from "../../../../components/S2Client";
import { guardProjectRoute } from "../../route-guard";

export default async function ReferencesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  guardProjectRoute(projectId, "s2");
  return <S2ReferencesScreen projectId={projectId} />;
}
