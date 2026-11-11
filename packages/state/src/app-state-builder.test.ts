import type { Endpoint, TrafficFlow } from "@kanna/shared";
import { describe, expect, test } from "vitest";
import { AppStateBuilder, normalizePath } from "./index.js";

function flow(overrides: Partial<TrafficFlow> = {}): TrafficFlow {
  return {
    id: "flow_1",
    sessionId: "sess_1",
    proxyFlowKey: "proxy_1",
    timestampStart: 100,
    method: "GET",
    url: "http://localhost:3000/api/users/42?expand=roles",
    host: "localhost",
    port: 3000,
    path: "/api/users/42?expand=roles",
    requestHeaders: { authorization: "Bearer x" },
    statusCode: 200,
    responseHeaders: {
      server: "nginx",
      "x-powered-by": "Express",
      "set-cookie": "sid=abc; Path=/; HttpOnly; SameSite=Lax",
    },
    contentType: "application/json",
    source: "browser",
    browserActionId: "act_1",
    timing: {},
    securityMetadata: {},
    ...overrides,
  };
}

describe("AppStateBuilder", () => {
  test("normalizes unstable path segments", () => {
    expect(normalizePath("/users/42/orders/550e8400-e29b-41d4-a716-446655440000/a3f19c2d0e7b8a91")).toBe(
      "/users/:param/orders/:param/:param",
    );
  });

  test("aggregates endpoints, parameters, auth, cookies, technologies and traffic graph", () => {
    const saved: Endpoint[] = [];
    const builder = new AppStateBuilder("sess_1", { save: (_session, endpoint) => saved.push(endpoint) });
    builder.consume(flow());
    builder.consume(
      flow({
        id: "flow_2",
        timestampStart: 200,
        url: "http://localhost:3000/api/users/43?expand=teams",
        path: "/api/users/43?expand=teams",
        statusCode: 404,
      }),
    );

    const state = builder.snapshot();
    expect(state.endpoints).toHaveLength(1);
    expect(state.endpoints[0]).toMatchObject({
      pathTemplate: "/api/users/:param",
      observedStatusCodes: [200, 404],
      authRequired: true,
    });
    expect(state.parameters.find((p) => p.name === "expand")?.sampleValues).toEqual(["roles", "teams"]);
    expect(state.parameters.find((p) => p.name === "user_id")?.locations).toContain("path");
    expect(state.parameters.find((p) => p.name === "authorization")?.sampleValues).toEqual(["[present]"]);
    expect(state.authState).toMatchObject({ tokenHeaders: ["authorization"], cookieNames: ["sid"] });
    expect(state.cookies[0]).toMatchObject({ name: "sid", httpOnly: true, sameSite: "Lax" });
    expect(state.technologies.map((t) => t.name)).toEqual(expect.arrayContaining(["nginx", "Express"]));
    expect(state.trafficGraph).toEqual([{ actionId: "act_1", flowIds: ["flow_1", "flow_2"] }]);
    expect(saved.length).toBe(2);
  });

  test("bounds snapshot collections while retaining aggregate counts", () => {
    const builder = new AppStateBuilder("sess_1");
    for (let i = 0; i < 5; i++)
      builder.consume(
        flow({
          id: `flow_${i}`,
          url: `http://localhost:3000/p/${i}/x${i}`,
          path: `/p/${i}/x${i}`,
          timestampStart: i,
        }),
      );
    const compact = builder.compactSnapshot({ endpoints: 2, parameters: 1, graph: 1 });
    expect(compact.state.endpoints).toHaveLength(2);
    expect(compact.counts.endpoints).toBe(5);
  });
});
