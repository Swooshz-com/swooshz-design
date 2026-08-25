import { GenerationProgressScreen } from "../../../../components/FlowClient";

export default async function GenerationPage({ params }: { params: Promise<{ projectId: string; generationSetId: string }> }) {
  const values = await params;
  return <GenerationProgressScreen projectId={values.projectId} generationSetId={values.generationSetId} />;
}
