export type Route = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  handler: (ctx: RouteContext) => Response | Promise<Response>;
};

export type RouteContext = {
  request: Request;
  url: URL;
  params: Record<string, string>;
};

const JSON_CONTENT_TYPE = "application/json";

type CompiledRoute = {
  route: Route;
  pattern: string[];
};

type PathMatch = {
  route: Route;
  params: Record<string, string>;
};

function errorResponse(
  status: number,
  tag: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ _tag: tag, message }), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE, ...headers },
  });
}

function matchPath(pattern: string[], segments: string[]): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!;
    const actual = segments[index]!;
    if (expected.startsWith(":")) {
      if (actual.length === 0) return null;
      params[expected.slice(1)] = decodePathSegment(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createRouter(routes: Route[]): (request: Request) => Promise<Response> {
  const compiled: CompiledRoute[] = routes.map((route) => ({ route, pattern: route.path.split("/") }));

  return async function routeRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/");

    const matches: PathMatch[] = [];
    for (const candidate of compiled) {
      const params = matchPath(candidate.pattern, segments);
      if (params !== null) matches.push({ route: candidate.route, params });
    }

    if (matches.length === 0) {
      return errorResponse(404, "NotFoundError", `no route for ${request.method} ${url.pathname}`);
    }

    const allowed = [...new Set(matches.map((match) => match.route.method))];
    const match = matches.find((candidate) => candidate.route.method === request.method);
    if (match === undefined) {
      return errorResponse(
        405,
        "MethodNotAllowedError",
        `${request.method} is not allowed on ${url.pathname}`,
        { allow: allowed.join(", ") },
      );
    }

    return match.route.handler({ request, url, params: match.params });
  };
}
