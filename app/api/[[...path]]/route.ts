import { handleApiRequest } from "../../../src/lib/api";

type RouteContext = { params: Promise<{ path?: string[] }> };

async function route(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  return handleApiRequest(request, path);
}

export const GET = route;
export const POST = route;
export const PUT = route;
export const PATCH = route;
