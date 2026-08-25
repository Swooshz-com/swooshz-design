import { GenerationProgressScreen } from "../../../../components/FlowClient";
import { guardProjectRoute } from "../../route-guard";

export default async function GenerationPage({ params }: { params: Promise<{ projectId: string; generationSetId: string }> }) {
  const { projectId, generationSetId } = await params;
  guardProjectRoute(projectId, "generation", generationSetId);
  return <GenerationProgressScreen projectId={projectId} generationSetId={generationSetId} />;
}
