import { notFound, redirect } from "next/navigation";
import { AppError, type Project } from "../../../src/lib/types";
import { createWorkflowService, projectContinuationPath, type S1Route } from "../../../src/lib/workflow";

export function guardProjectRoute(projectId: string, requested: S1Route, generationSetId?: string): Project {
  const service = createWorkflowService();
  let project: Project;
  try {
    project = service.getProject(projectId);
  } catch (error) {
    if (error instanceof AppError && error.code === "PROJECT_NOT_FOUND") notFound();
    throw error;
  }
  const continuation = projectContinuationPath(project, requested, generationSetId);
  if (continuation) redirect(continuation);
  return project;
}
