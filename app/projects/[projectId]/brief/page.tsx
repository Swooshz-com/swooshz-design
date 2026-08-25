import { BriefUploadScreen } from "../../../components/FlowClient";
import { guardProjectRoute } from "../route-guard";

export default async function BriefPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  guardProjectRoute(projectId, "brief");
  return <BriefUploadScreen projectId={projectId} />;
}
