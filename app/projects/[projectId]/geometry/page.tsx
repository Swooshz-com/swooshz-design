import { GeometryScreen } from "../../../components/FlowClient";

export default async function GeometryPage({ params }: { params: Promise<{ projectId: string }> }) {
  return <GeometryScreen projectId={(await params).projectId} />;
}
