import { BriefReviewScreen } from "../../../../components/FlowClient";

export default async function BriefReviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  return <BriefReviewScreen projectId={(await params).projectId} />;
}
