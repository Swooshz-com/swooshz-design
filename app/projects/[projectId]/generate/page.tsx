import { GenerateScreen } from "../../../components/FlowClient";
import { guardProjectRoute } from "../route-guard";

export default async function GeneratePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  guardProjectRoute(projectId, "generate");
  return <GenerateScreen projectId={projectId} />;
}
