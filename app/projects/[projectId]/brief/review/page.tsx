import { BriefReviewScreen } from "../../../../components/FlowClient";
import { guardProjectRoute } from "../../route-guard";

export default async function BriefReviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  guardProjectRoute(projectId, "review");
  return <BriefReviewScreen projectId={projectId} />;
}
