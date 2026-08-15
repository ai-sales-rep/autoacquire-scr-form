// Mocked end-to-end test — no real network. Run: node api/submit.test.mjs
import handler, { buildDescription, buildTicketProperties } from "./submit.js";
import assert from "node:assert";

function makeRes() {
  return { _s: 0, _j: null, status(c){ this._s = c; return this; }, json(o){ this._j = o; return this; } };
}

function mockFetch(calls, { ticketFullFails = false } = {}) {
  return async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method || "GET", body });
    const ok = (json, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(json) });
    const bad = (status, json = {}) => ({ ok: false, status, text: async () => JSON.stringify(json) });

    if (url.includes("/crm/v3/pipelines/tickets"))
      return ok({ results: [{ id: "42", label: "Change Requests", stages: [{ id: "101", label: "Intake" }] }] });
    if (url.includes("/crm/v3/objects/contacts/search"))
      return ok({ results: [] });                       // force create path
    if (url.endsWith("/crm/v3/objects/contacts"))
      return ok({ id: "C1" });
    if (url.endsWith("/crm/v3/objects/tickets")) {
      const hasScr = body && body.properties && (body.properties.scr_request_type || body.properties.hs_pipeline);
      if (ticketFullFails && hasScr) return bad(400, { message: "Property scr_request_type does not exist" });
      return ok({ id: hasScr ? "T123" : "T999" });
    }
    if (url.startsWith("https://hooks.slack")) return ok({});
    return bad(404, {});
  };
}

const GOOD = {
  firstname: "Sam", lastname: "Nasim", email: "sam@autoacquireai.com",
  scr_request_type: "Something is broken", subject: "Login button dead on staff page",
  scr_where_in_product: "Staff page header", scr_current_behavior: "Nothing happens",
  scr_desired_behavior: "It should log me in", scr_business_justification: "Blocks all staff logins",
  scr_steps_to_reproduce: "1. click login", scr_reference_link: "https://x/y",
};

const origFetch = globalThis.fetch;
process.env.HUBSPOT_TOKEN = "test-token";
process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/x";

let passed = 0;
async function run(name, fn){ await fn(); console.log("  ok -", name); passed++; }

// 1. Happy path
await run("valid submit -> 200 + ticketId, right pipeline/assoc/props, slack fires", async () => {
  const calls = []; globalThis.fetch = mockFetch(calls);
  const res = makeRes();
  await handler({ method: "POST", body: { ...GOOD } }, res);
  assert.equal(res._s, 200, "status");
  assert.equal(res._j.ok, true);
  assert.equal(res._j.ticketId, "T123");
  const ticket = calls.find(c => c.url.endsWith("/crm/v3/objects/tickets"));
  assert.equal(ticket.body.properties.hs_pipeline, "42");
  assert.equal(ticket.body.properties.hs_pipeline_stage, "101");
  assert.equal(ticket.body.properties.scr_request_type, "Something is broken");
  assert.ok(ticket.body.properties.content.includes("Blocks all staff logins"), "description composed");
  assert.equal(ticket.body.associations[0].types[0].associationTypeId, 16, "contact assoc");
  assert.ok(calls.some(c => c.url.startsWith("https://hooks.slack")), "slack posted");
});

// 2. Missing required -> 400
await run("missing required field -> 400", async () => {
  const calls = []; globalThis.fetch = mockFetch(calls);
  const res = makeRes();
  const bad = { ...GOOD }; delete bad.subject;
  await handler({ method: "POST", body: bad }, res);
  assert.equal(res._s, 400);
  assert.ok(res._j.missing.includes("subject"));
  assert.equal(calls.length, 0, "no HubSpot calls on validation failure");
});

// 3. Honeypot -> silent 200, nothing created
await run("honeypot _hp set -> 200, no ticket created", async () => {
  const calls = []; globalThis.fetch = mockFetch(calls);
  const res = makeRes();
  await handler({ method: "POST", body: { ...GOOD, _hp: "bot" } }, res);
  assert.equal(res._s, 200);
  assert.equal(res._j.ticketId, null);
  assert.equal(calls.length, 0);
});

// 4. Day-one-safe fallback when scr_*/pipeline not applied yet
await run("full create fails -> minimal fallback, degraded=true", async () => {
  const calls = []; globalThis.fetch = mockFetch(calls, { ticketFullFails: true });
  const res = makeRes();
  await handler({ method: "POST", body: { ...GOOD } }, res);
  assert.equal(res._s, 200);
  assert.equal(res._j.ticketId, "T999");
  assert.equal(res._j.degraded, true);
  const ticketPosts = calls.filter(c => c.url.endsWith("/crm/v3/objects/tickets"));
  assert.equal(ticketPosts.length, 2, "tried full then minimal");
});

// 5. GET -> 405
await run("GET -> 405", async () => {
  globalThis.fetch = mockFetch([]);
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res._s, 405);
});

// pure helpers
await run("buildTicketProperties includes scr_* + pipeline", async () => {
  const p = buildTicketProperties(GOOD, { pipelineId: "42", stageId: "101" });
  assert.equal(p.subject, GOOD.subject);
  assert.equal(p.scr_where_in_product, "Staff page header");
  assert.ok(buildDescription(GOOD).includes("Request type: Something is broken"));
});

globalThis.fetch = origFetch;
console.log(`\n${passed} checks passed`);
