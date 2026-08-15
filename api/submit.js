// AutoAcquire — Software Change Request intake.
// Vercel serverless function (Node 18+, global fetch). Zero dependencies.
//
// On POST it:
//   1. resolves the "Change Requests" -> "Intake" pipeline/stage (by label, or env override),
//   2. finds-or-creates the submitter contact by email,
//   3. creates a ticket with the scr_* properties + a composed description, associated
//      to the contact (ticket->contact associationTypeId 16),
//   4. posts a Slack notification with a link to the ticket,
//   5. returns { ok, ticketId }.
//
// Day-one safe: if the Change Requests pipeline or scr_* custom properties don't exist
// yet, it falls back to creating a plain ticket (subject + description) in the default
// pipeline — so the form works before the HubSpot build sheet is fully applied.

const HS = "https://api.hubapi.com";

const REQUIRED = [
  "firstname", "lastname", "email", "scr_request_type", "subject",
  "scr_where_in_product", "scr_current_behavior", "scr_desired_behavior",
  "scr_business_justification",
];

const SCR_PROPS = [
  "scr_requesting_on_behalf_of", "scr_request_type", "scr_where_in_product",
  "scr_current_behavior", "scr_desired_behavior", "scr_steps_to_reproduce",
  "scr_business_justification", "scr_reference_link",
];

export function buildDescription(b) {
  const line = (k, v) => (v && String(v).trim() ? `${k}: ${String(v).trim()}\n` : "");
  return (
    line("Submitter", `${b.firstname || ""} ${b.lastname || ""} <${b.email || ""}>`) +
    line("On behalf of", b.scr_requesting_on_behalf_of) +
    line("Request type", b.scr_request_type) +
    line("Where in the product", b.scr_where_in_product) +
    "\n" +
    line("What happens today", b.scr_current_behavior) +
    line("What should happen instead", b.scr_desired_behavior) +
    line("Steps to reproduce", b.scr_steps_to_reproduce) +
    line("Why it matters", b.scr_business_justification) +
    line("Related link", b.scr_reference_link)
  ).trim();
}

export function buildTicketProperties(b, { pipelineId, stageId } = {}) {
  const props = {
    subject: b.subject,
    content: buildDescription(b),
  };
  if (pipelineId) props.hs_pipeline = pipelineId;
  if (stageId) props.hs_pipeline_stage = stageId;
  for (const k of SCR_PROPS) {
    if (b[k] != null && String(b[k]).trim() !== "") props[k] = String(b[k]);
  }
  return props;
}

async function hsFetch(token, path, method = "GET", body) {
  const res = await fetch(HS + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function resolvePipeline(token) {
  if (process.env.HS_PIPELINE_ID && process.env.HS_STAGE_INTAKE_ID) {
    return { pipelineId: process.env.HS_PIPELINE_ID, stageId: process.env.HS_STAGE_INTAKE_ID };
  }
  const r = await hsFetch(token, "/crm/v3/pipelines/tickets");
  if (!r.ok || !Array.isArray(r.json?.results) || r.json.results.length === 0) return {};
  const pipes = r.json.results;
  const byOrder = (arr) =>
    (arr || []).slice().sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

  // Prefer the "Change Requests" -> "Intake" pipeline/stage.
  const cr = pipes.find((p) => (p.label || "").toLowerCase() === "change requests");
  if (cr) {
    const intake =
      (cr.stages || []).find((s) => (s.label || "").toLowerCase() === "intake") ||
      byOrder(cr.stages)[0];
    if (intake) return { pipelineId: cr.id, stageId: intake.id };
  }

  // Day-one fallback: the portal's default ticket pipeline + its first stage.
  // HubSpot requires hs_pipeline_stage on every ticket, so we must always resolve one.
  const def = pipes.find((p) => p.id === "0") || pipes[0];
  const firstStage = byOrder(def?.stages)[0];
  if (def && firstStage) return { pipelineId: def.id, stageId: firstStage.id };
  return {};
}

async function findOrCreateContact(token, b) {
  const search = await hsFetch(token, "/crm/v3/objects/contacts/search", "POST", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: b.email }] }],
    properties: ["email"],
    limit: 1,
  });
  if (search.ok && search.json?.results?.length) return search.json.results[0].id;

  const create = await hsFetch(token, "/crm/v3/objects/contacts", "POST", {
    properties: { email: b.email, firstname: b.firstname, lastname: b.lastname },
  });
  if (create.ok && create.json?.id) return create.json.id;
  // Race: contact created between search and create -> reuse existing.
  if (create.status === 409) {
    const again = await hsFetch(token, "/crm/v3/objects/contacts/search", "POST", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: b.email }] }],
      properties: ["email"], limit: 1,
    });
    if (again.ok && again.json?.results?.length) return again.json.results[0].id;
  }
  return null;
}

function contactAssociation(contactId) {
  if (!contactId) return undefined;
  return [{
    to: { id: contactId },
    types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 16 }],
  }];
}

async function createTicket(token, b, pipe, contactId) {
  const associations = contactAssociation(contactId);
  // Attempt 1: full payload (scr_* props + pipeline/stage).
  const full = await hsFetch(token, "/crm/v3/objects/tickets", "POST", {
    properties: buildTicketProperties(b, pipe),
    associations,
  });
  if (full.ok && full.json?.id) return { id: full.json.id, degraded: false };

  // Day-one-safe fallback: some scr_* props may not exist yet. Keep the resolved
  // pipeline/stage — HubSpot rejects a ticket with no hs_pipeline_stage.
  const minProps = { subject: b.subject, content: buildDescription(b) };
  if (pipe?.pipelineId) minProps.hs_pipeline = pipe.pipelineId;
  if (pipe?.stageId) minProps.hs_pipeline_stage = pipe.stageId;
  const minimal = await hsFetch(token, "/crm/v3/objects/tickets", "POST", {
    properties: minProps,
    associations,
  });
  if (minimal.ok && minimal.json?.id) return { id: minimal.json.id, degraded: true };

  throw new Error(`HubSpot ticket create failed: ${full.status} ${full.text}`);
}

async function postSlack(b, ticketId, degraded) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const portal = process.env.HS_PORTAL_ID || "43668701";
  const link = `https://app.hubspot.com/contacts/${portal}/record/0-5/${ticketId}`;
  const text =
    `:memo: *New Software Change Request* — <${link}|#${ticketId}>\n` +
    `*${b.subject}*\n` +
    `Type: ${b.scr_request_type} · From: ${b.firstname} ${b.lastname} (${b.email})` +
    (degraded ? `\n_(created with standard fields — Change Requests pipeline not applied yet)_` : "");
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    /* Slack is best-effort; never fail the submission on a notify error. */
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const b = await readBody(req);

  // Silent spam honeypot — pretend success, create nothing.
  if (b._hp) { res.status(200).json({ ok: true, ticketId: null }); return; }

  const missing = REQUIRED.filter((k) => !String(b[k] || "").trim());
  if (missing.length) {
    res.status(400).json({ error: "Missing required fields", missing });
    return;
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Server not configured: HUBSPOT_TOKEN missing" });
    return;
  }

  try {
    const pipe = await resolvePipeline(token);
    const contactId = await findOrCreateContact(token, b);
    const { id: ticketId, degraded } = await createTicket(token, b, pipe, contactId);
    await postSlack(b, ticketId, degraded);
    res.status(200).json({ ok: true, ticketId, degraded });
  } catch (err) {
    res.status(502).json({ error: "Upstream error creating ticket", detail: String(err.message || err) });
  }
}
