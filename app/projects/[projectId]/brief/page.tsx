import { BriefUploadScreen } from "../../../components/FlowClient";

export default async function BriefPage({ params }: { params: Promise<{ projectId: string }> }) {
  return <BriefUploadScreen projectId={(await params).projectId} />;
}
