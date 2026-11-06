import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertErrorEnvelope, validateResponse } from "../../src/contract/validate";
import {
  handleAgentList,
  handleFormList,
  handleIntegrationList,
  handleMcpList,
  handleMcpResourceCatalog,
  handlePermissionSavedList,
  handleReferenceList,
  handleSkillList,
  handleWebsearchProviders,
} from "../../src/http/handlers/catalogs";
import {
  handleCredentialActivate,
  handleCredentialRemove,
  handleCredentialUpdate,
  handleIntegrationCommandCancel,
  handleIntegrationCommandConnect,
  handleIntegrationCommandStatus,
  handleIntegrationConnectExternal,
  handleIntegrationConnectKey,
  handleIntegrationConnectOAuth,
  handleIntegrationOAuthCancel,
  handleIntegrationOAuthComplete,
  handleIntegrationOAuthStatus,
  handleMcpConnect,
  handleMcpDisconnect,
  handleMigrationV1Status,
  handlePersistentPtyConnect,
  handlePersistentPtyConnectToken,
  handlePersistentPtyCreate,
  handlePersistentPtyList,
  handlePersistentPtySnapshot,
  handleServerPair,
  handleUsageLimits,
  handleWorktreeCreate,
  handleWorktreeList,
  handleWorktreeRefresh,
} from "../../src/http/handlers/degraded";

const WORK_DIR = import.meta.dir;

type Handler = (request: Request, url: URL) => Promise<Response>;
type Tagged = Record<string, unknown> & { _tag: string; message: string };

const INTEGRATION_ID = "anthropic";
const ATTEMPT_ID = "attempt-1";

function urlOf(path: string, params: Record<string, string> = {}): URL {
  const url = new URL(`http://bridge.test${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function requestOf(method: string, path: string): Request {
  return new Request(`http://bridge.test${path}`, { method });
}

async function call(handler: Handler, method: string, path: string): Promise<Response> {
  return handler(requestOf(method, path), urlOf(path));
}

async function tagged(response: Response): Promise<Tagged> {
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as Tagged;
  assertErrorEnvelope(body);
  expect(validateResponse("error.envelope", body)).toEqual({ ok: true });
  return body;
}

function expectNoContent(response: Response): void {
  expect(response.status).toBe(204);
  expect(response.headers.get("content-type")).toBeNull();
}

describe("worktree degradation", () => {
  test("list answers a contract-valid empty Worktree.List", async () => {
    const response = await call(handleWorktreeList, "GET", "/api/worktree");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual([]);
  });

  test("refresh is an idempotent no-op write", async () => {
    const response = await call(handleWorktreeRefresh, "POST", "/api/worktree/refresh");
    expectNoContent(response);
    expect(await response.text()).toBe("");
  });

  test("create answers the declared WorktreeError instead of pretending to create one", async () => {
    const response = await call(handleWorktreeCreate, "POST", "/api/worktree");
    expect(response.status).toBe(400);
    const body = await tagged(response);
    expect(body._tag).toBe("WorktreeError");
    expect(body.message).toBe("worktrees are not supported by the omo-native engine");
  });
});

describe("persistent terminal degradation", () => {
  test("list answers the endpoint's {data:[]} shape, not a location envelope", async () => {
    const response = await call(handlePersistentPtyList, "GET", "/api/experimental/session/ses-1/terminal");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.data).toEqual([]);
    expect("location" in body).toBe(false);
  });

  test("create answers the declared InvalidRequestError without a 5xx", async () => {
    const response = await call(handlePersistentPtyCreate, "POST", "/api/experimental/session/ses-1/terminal");
    expect(response.status).toBe(400);
    const body = await tagged(response);
    expect(body._tag).toBe("InvalidRequestError");
    expect(body.kind).toBe("unsupported");
  });

  test("snapshot answers PtyNotFoundError carrying the requested ptyID", async () => {
    const response = await call(
      handlePersistentPtySnapshot,
      "GET",
      "/api/experimental/persistent-pty/pty%201/snapshot",
    );
    expect(response.status).toBe(404);
    const body = await tagged(response);
    expect(body._tag).toBe("PtyNotFoundError");
    expect(body.ptyID).toBe("pty 1");
  });

  test("connect answers the same PtyNotFoundError as snapshot, carrying the requested ptyID", async () => {
    const response = await call(
      handlePersistentPtyConnect,
      "GET",
      "/api/experimental/persistent-pty/pty-1/connect",
    );
    expect(response.status).toBe(404);
    const body = await tagged(response);
    expect(body._tag).toBe("PtyNotFoundError");
    expect(body.ptyID).toBe("pty-1");
    expect(body.message).toBe("persistent terminal pty-1 is not available");
  });

  test("connectToken answers PtyNotFoundError carrying the requested ptyID", async () => {
    const response = await call(
      handlePersistentPtyConnectToken,
      "POST",
      "/api/experimental/persistent-pty/pty-1/connect-token",
    );
    expect(response.status).toBe(404);
    const body = await tagged(response);
    expect(body._tag).toBe("PtyNotFoundError");
    expect(body.ptyID).toBe("pty-1");
  });
});

describe("migration degradation", () => {
  test("v1 status is already completed so the overlay never opens", async () => {
    const response = await call(handleMigrationV1Status, "GET", "/api/experimental/migration/v1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "completed" });
  });
});

describe("integration degradation", () => {
  test("key connect answers IntegrationNotFoundError", async () => {
    const response = await call(
      handleIntegrationConnectKey,
      "POST",
      `/api/integration/${INTEGRATION_ID}/connect/key`,
    );
    expect(response.status).toBe(404);
    const body = await tagged(response);
    expect(body._tag).toBe("IntegrationNotFoundError");
    expect(body.integrationID).toBe(INTEGRATION_ID);
  });

  test("external connect answers IntegrationNotFoundError", async () => {
    const response = await call(
      handleIntegrationConnectExternal,
      "POST",
      `/api/integration/${INTEGRATION_ID}/connect/external`,
    );
    expect(response.status).toBe(404);
    expect((await tagged(response))._tag).toBe("IntegrationNotFoundError");
  });

  test("oauth connect cannot start an attempt", async () => {
    const response = await call(
      handleIntegrationConnectOAuth,
      "POST",
      `/api/integration/${INTEGRATION_ID}/connect/oauth`,
    );
    expect(response.status).toBe(404);
    const body = await tagged(response);
    expect(body._tag).toBe("IntegrationAttemptNotFoundError");
    expect(body.integrationID).toBe(INTEGRATION_ID);
    expect(body.attemptID).toBe("");
  });

  test("oauth status reports the missing attempt", async () => {
    const response = await call(
      handleIntegrationOAuthStatus,
      "GET",
      `/api/integration/${INTEGRATION_ID}/connect/oauth/${ATTEMPT_ID}`,
    );
    expect(response.status).toBe(404);
    const body = await tagged(response);
    expect(body._tag).toBe("IntegrationAttemptNotFoundError");
    expect(body.attemptID).toBe(ATTEMPT_ID);
  });

  test("oauth complete reports the missing attempt", async () => {
    const response = await call(
      handleIntegrationOAuthComplete,
      "POST",
      `/api/integration/${INTEGRATION_ID}/connect/oauth/${ATTEMPT_ID}/complete`,
    );
    expect(response.status).toBe(404);
    const body = await tagged(response);
    expect(body._tag).toBe("IntegrationAttemptNotFoundError");
    expect(body.attemptID).toBe(ATTEMPT_ID);
  });

  test("oauth cancel is an idempotent no-op for an attempt that never existed", async () => {
    const response = await call(
      handleIntegrationOAuthCancel,
      "DELETE",
      `/api/integration/${INTEGRATION_ID}/connect/oauth/${ATTEMPT_ID}`,
    );
    expectNoContent(response);
  });

  test("command connect cannot start an attempt", async () => {
    const response = await call(
      handleIntegrationCommandConnect,
      "POST",
      `/api/integration/${INTEGRATION_ID}/connect/command`,
    );
    expect(response.status).toBe(404);
    expect((await tagged(response))._tag).toBe("IntegrationAttemptNotFoundError");
  });

  test("command status reports the missing attempt", async () => {
    const response = await call(
      handleIntegrationCommandStatus,
      "GET",
      `/api/integration/${INTEGRATION_ID}/connect/command/${ATTEMPT_ID}`,
    );
    expect(response.status).toBe(404);
    const body = await tagged(response);
    expect(body._tag).toBe("IntegrationAttemptNotFoundError");
    expect(body.attemptID).toBe(ATTEMPT_ID);
  });

  test("command cancel reports the missing attempt", async () => {
    const response = await call(
      handleIntegrationCommandCancel,
      "DELETE",
      `/api/integration/${INTEGRATION_ID}/connect/command/${ATTEMPT_ID}`,
    );
    expect(response.status).toBe(404);
    const body = await tagged(response);
    expect(body._tag).toBe("IntegrationAttemptNotFoundError");
    expect(body.attemptID).toBe(ATTEMPT_ID);
  });
});

describe("credential degradation", () => {
  const cases: Array<[string, Handler, string]> = [
    ["activate", handleCredentialActivate, "POST"],
    ["update", handleCredentialUpdate, "PATCH"],
    ["remove", handleCredentialRemove, "DELETE"],
  ];

  for (const [name, handler, method] of cases) {
    test(`${name} answers InvalidRequestError instead of a no-op 204`, async () => {
      const response = await handler(requestOf(method, "/api/credential/cred-1"), urlOf("/api/credential/cred-1"));
      expect(response.status).toBe(400);
      const body = await tagged(response);
      expect(body._tag).toBe("InvalidRequestError");
      expect(body.message).toContain("not supported");
    });
  }
});

describe("server pairing degradation", () => {
  test("pair answers InvalidRequestError instead of a pairing code", async () => {
    const response = await call(handleServerPair, "POST", "/api/pair");
    expect(response.status).toBe(400);
    const body = await tagged(response);
    expect(body._tag).toBe("InvalidRequestError");
    expect(body).not.toHaveProperty("code");
  });
});

describe("usage limits degradation", () => {
  test("answers a null budget with a valid location envelope", async () => {
    const path = "/api/experimental/usage/limits";
    const response = await handleUsageLimits(
      requestOf("GET", path),
      urlOf(path, { "location[directory]": WORK_DIR }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { location: { directory: string }; data: unknown };
    expect(body.data).toBeNull();
    expect(body.location).toEqual({ directory: WORK_DIR });
    expect(validateResponse("usage.limits", body)).toEqual({ ok: true });
  });

  test("a missing location directory is a 404 FileNotFoundError, not a fabricated location", async () => {
    const path = "/api/experimental/usage/limits";
    const response = await handleUsageLimits(
      requestOf("GET", path),
      urlOf(path, { "location[directory]": join(WORK_DIR, "no-such-directory") }),
    );
    expect(response.status).toBe(404);
    expect((await tagged(response))._tag).toBe("FileNotFoundError");
  });
});

describe("experimental MCP degradation", () => {
  test("connect accepts the request without changing state", async () => {
    expectNoContent(await call(handleMcpConnect, "POST", "/api/experimental/mcp/demo/connect"));
  });

  test("disconnect accepts the request without changing state", async () => {
    expectNoContent(await call(handleMcpDisconnect, "POST", "/api/experimental/mcp/demo/disconnect"));
  });
});

describe("catalog-backed degradation families", () => {
  const lists: Array<[string, Handler]> = [
    ["/api/skill", handleSkillList],
    ["/api/reference", handleReferenceList],
    ["/api/websearch/provider", handleWebsearchProviders],
    ["/api/integration", handleIntegrationList],
    ["/api/mcp", handleMcpList],
    ["/api/permission/saved", handlePermissionSavedList],
    ["/api/form", handleFormList],
  ];

  for (const [path, handler] of lists) {
    test(`${path} answers an empty list through catalogs.ts`, async () => {
      const response = await handler(
        requestOf("GET", path),
        urlOf(path, { "location[directory]": WORK_DIR }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = (await response.json()) as { data: unknown };
      expect(body.data).toEqual([]);
      expect(response.status).toBeLessThan(500);
    });
  }

  test("/api/mcp/resource answers an empty resource catalog through catalogs.ts", async () => {
    const response = await handleMcpResourceCatalog(
      requestOf("GET", "/api/mcp/resource"),
      urlOf("/api/mcp/resource", { "location[directory]": WORK_DIR }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { resources: unknown[]; templates: unknown[] } };
    expect(body.data).toEqual({ resources: [], templates: [] });
    expect(response.status).toBeLessThan(500);
  });
});

describe("degradation sweep", () => {
  const cases: Array<{ name: string; method: string; path: string; handler: Handler }> = [
    { name: "worktree.list", method: "GET", path: "/api/worktree", handler: handleWorktreeList },
    { name: "worktree.refresh", method: "POST", path: "/api/worktree/refresh", handler: handleWorktreeRefresh },
    { name: "worktree.create", method: "POST", path: "/api/worktree", handler: handleWorktreeCreate },
    {
      name: "persistentPty.list",
      method: "GET",
      path: "/api/experimental/session/ses-1/terminal",
      handler: handlePersistentPtyList,
    },
    {
      name: "persistentPty.create",
      method: "POST",
      path: "/api/experimental/session/ses-1/terminal",
      handler: handlePersistentPtyCreate,
    },
    {
      name: "persistentPty.snapshot",
      method: "GET",
      path: "/api/experimental/persistent-pty/pty-1/snapshot",
      handler: handlePersistentPtySnapshot,
    },
    {
      name: "persistentPty.connect",
      method: "GET",
      path: "/api/experimental/persistent-pty/pty-1/connect",
      handler: handlePersistentPtyConnect,
    },
    {
      name: "persistentPty.connectToken",
      method: "POST",
      path: "/api/experimental/persistent-pty/pty-1/connect-token",
      handler: handlePersistentPtyConnectToken,
    },
    {
      name: "migration.v1.status",
      method: "GET",
      path: "/api/experimental/migration/v1",
      handler: handleMigrationV1Status,
    },
    {
      name: "integration.connect.key",
      method: "POST",
      path: `/api/integration/${INTEGRATION_ID}/connect/key`,
      handler: handleIntegrationConnectKey,
    },
    {
      name: "integration.connect.external",
      method: "POST",
      path: `/api/integration/${INTEGRATION_ID}/connect/external`,
      handler: handleIntegrationConnectExternal,
    },
    {
      name: "integration.oauth.connect",
      method: "POST",
      path: `/api/integration/${INTEGRATION_ID}/connect/oauth`,
      handler: handleIntegrationConnectOAuth,
    },
    {
      name: "integration.oauth.status",
      method: "GET",
      path: `/api/integration/${INTEGRATION_ID}/connect/oauth/${ATTEMPT_ID}`,
      handler: handleIntegrationOAuthStatus,
    },
    {
      name: "integration.oauth.complete",
      method: "POST",
      path: `/api/integration/${INTEGRATION_ID}/connect/oauth/${ATTEMPT_ID}/complete`,
      handler: handleIntegrationOAuthComplete,
    },
    {
      name: "integration.oauth.cancel",
      method: "DELETE",
      path: `/api/integration/${INTEGRATION_ID}/connect/oauth/${ATTEMPT_ID}`,
      handler: handleIntegrationOAuthCancel,
    },
    {
      name: "integration.command.connect",
      method: "POST",
      path: `/api/integration/${INTEGRATION_ID}/connect/command`,
      handler: handleIntegrationCommandConnect,
    },
    {
      name: "integration.command.status",
      method: "GET",
      path: `/api/integration/${INTEGRATION_ID}/connect/command/${ATTEMPT_ID}`,
      handler: handleIntegrationCommandStatus,
    },
    {
      name: "integration.command.cancel",
      method: "DELETE",
      path: `/api/integration/${INTEGRATION_ID}/connect/command/${ATTEMPT_ID}`,
      handler: handleIntegrationCommandCancel,
    },
    {
      name: "credential.activate",
      method: "POST",
      path: "/api/credential/cred-1/activate",
      handler: handleCredentialActivate,
    },
    { name: "credential.update", method: "PATCH", path: "/api/credential/cred-1", handler: handleCredentialUpdate },
    { name: "credential.remove", method: "DELETE", path: "/api/credential/cred-1", handler: handleCredentialRemove },
    { name: "server.pair", method: "POST", path: "/api/pair", handler: handleServerPair },
    {
      name: "usage.limits",
      method: "GET",
      path: "/api/experimental/usage/limits",
      handler: handleUsageLimits,
    },
    { name: "experimental.mcp.connect", method: "POST", path: "/api/experimental/mcp/demo/connect", handler: handleMcpConnect },
    {
      name: "experimental.mcp.disconnect",
      method: "POST",
      path: "/api/experimental/mcp/demo/disconnect",
      handler: handleMcpDisconnect,
    },
  ];

  for (const entry of cases) {
    test(`${entry.name} never answers 5xx`, async () => {
      const response = await entry.handler(
        requestOf(entry.method, entry.path),
        urlOf(entry.path, { "location[directory]": WORK_DIR }),
      );
      expect(response.status).toBeLessThan(500);
      if (response.status === 204) {
        expect(await response.text()).toBe("");
        return;
      }
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status >= 400) {
        expect(typeof body._tag).toBe("string");
        expect(typeof body.message).toBe("string");
      }
    });
  }
});
