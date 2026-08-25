import { GenerateScreen } from "../../../components/FlowClient";

export default async function GeneratePage({ params }: { params: Promise<{ projectId: string }> }) {
  return <GenerateScreen projectId={(await params).projectId} />;
}
