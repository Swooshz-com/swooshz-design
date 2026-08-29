import { S3Screen } from "../../../components/S3Client";

export default async function S3Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <S3Screen projectId={projectId} />;
}
