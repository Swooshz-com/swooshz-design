import { GeometryScreen } from "../../../components/FlowClient";
import { guardProjectRoute } from "../route-guard";

export default async function GeometryPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const project = guardProjectRoute(projectId, "geometry");
  return <GeometryScreen projectId={projectId} initialGeometry={project.boothGeometry} />;
}
