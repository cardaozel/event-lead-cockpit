// Vercel serverless function: POST /api/hubspot
//
// Body: { "ids": ["lead-id", ...] }
//
// The browser only sends lead IDs. Lead data is read from the bundled
// data/cockpit.json, so this endpoint can only ever write leads that the
// pipeline produced; nobody can use it to write arbitrary data into HubSpot.
//
// Env vars (Vercel → Project → Settings → Environment Variables):
//   HUBSPOT_TOKEN  Private app token. Scopes: crm.objects.contacts.read/write,
//                  crm.objects.companies.read/write. If missing, runs as a dry run.
//   PUSH_KEY       Optional shared key. If set, the request must send it in the
//                  x-push-key header, so a public cockpit link cannot write to the CRM.

const cockpit = require("../data/cockpit.json");

const HS = "https://api.hubapi.com";
const MAX_BATCH = 25;

async function hs(token, method, path, body) {
  const res = await fetch(HS + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data.message || text || res.statusText;
    throw new Error(`HubSpot ${res.status} on ${method} ${path}: ${msg}`);
  }
  return data;
}

function splitName(full) {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstname: parts[0], lastname: "" };
  return { firstname: parts.slice(0, -1).join(" "), lastname: parts[parts.length - 1] };
}

async function findOne(token, object, filters) {
  const r = await hs(token, "POST", `/crm/v3/objects/${object}/search`, {
    filterGroups: [{ filters }],
    limit: 1,
  });
  return r.results && r.results[0] ? r.results[0] : null;
}

// Dedupe companies by domain first, then by exact name.
async function upsertCompany(token, lead) {
  let found = null;
  if (lead.domain) found = await findOne(token, "companies", [{ propertyName: "domain", operator: "EQ", value: lead.domain }]);
  if (!found) found = await findOne(token, "companies", [{ propertyName: "name", operator: "EQ", value: lead.company }]);
  if (found) return { id: found.id, created: false };

  const props = { name: lead.company, country: lead.country || "" };
  if (lead.domain) props.domain = lead.domain;
  const c = await hs(token, "POST", "/crm/v3/objects/companies", { properties: props });
  return { id: c.id, created: true };
}

// Speakers have no e-mail yet, so dedupe on first + last name + company.
async function upsertContact(token, lead) {
  const { firstname, lastname } = splitName(lead.name);
  const found = await findOne(token, "contacts", [
    { propertyName: "firstname", operator: "EQ", value: firstname },
    { propertyName: "lastname", operator: "EQ", value: lastname },
    { propertyName: "company", operator: "EQ", value: lead.company },
  ]);
  if (found) return { id: found.id, created: false };

  const c = await hs(token, "POST", "/crm/v3/objects/contacts", {
    properties: {
      firstname,
      lastname,
      jobtitle: lead.title || "",
      company: lead.company,
      lifecyclestage: "lead",
      hs_lead_status: "NEW",
    },
  });
  return { id: c.id, created: true };
}

function noteBody(lead) {
  const lines = [
    `<b>Event-sourced lead · ${lead.event_name}</b>`,
    `Role at event: ${lead.role}`,
    `ICP score: ${lead.score}/100 (tier ${lead.tier}) · ${lead.persona} · ${lead.seniority}`,
    ...lead.breakdown.map((b) => `– ${b.factor}: ${b.points}/${b.max} (${b.why})`),
  ];
  if (lead.reference) lines.push(`Suggested opener: ${lead.reference.customer} – ${lead.reference.story}`);
  if (lead.flags && lead.flags.length) lines.push(`Flags: ${lead.flags.join("; ")}`);
  if (lead.source_url) lines.push(`Source: ${lead.source_url}`);
  return lines.join("<br>");
}

async function addNote(token, lead, contactId, companyId) {
  const associations = [];
  if (contactId) associations.push({ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] });
  if (companyId) associations.push({ to: { id: companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }] });
  await hs(token, "POST", "/crm/v3/objects/notes", {
    properties: { hs_timestamp: new Date().toISOString(), hs_note_body: noteBody(lead) },
    associations,
  });
}

async function pushLead(token, lead) {
  const company = await upsertCompany(token, lead);
  let contact = null;
  if (lead.kind === "contact") {
    contact = await upsertContact(token, lead);
    await hs(token, "PUT", `/crm/v4/objects/contacts/${contact.id}/associations/default/companies/${company.id}`);
  }
  // The note carries score, tier reason and source. If it fails (e.g. a missing scope),
  // the contact and company are still synced and the warning is reported back.
  let noteWarning = null;
  try {
    await addNote(token, lead, contact && contact.id, company.id);
  } catch (err) {
    noteWarning = `Note not added: ${String(err.message || err)}`;
  }
  return {
    id: lead.id,
    status: "synced",
    company: { id: company.id, created: company.created },
    contact: contact ? { id: contact.id, created: contact.created } : null,
    warning: noteWarning,
  };
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.status(200).json({
      mode: process.env.HUBSPOT_TOKEN ? "live" : "dry-run",
      keyRequired: Boolean(process.env.PUSH_KEY),
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  if (process.env.PUSH_KEY && req.headers["x-push-key"] !== process.env.PUSH_KEY) {
    return res.status(401).json({ error: "Push key missing or wrong" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, MAX_BATCH) : [];
  if (!ids.length) return res.status(400).json({ error: "Send { ids: [...] }" });

  const byId = new Map(cockpit.leads.map((l) => [l.id, l]));
  const leads = ids.map((id) => byId.get(id)).filter(Boolean);
  const unknown = ids.filter((id) => !byId.has(id));

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return res.status(200).json({
      mode: "dry-run",
      unknown,
      results: leads.map((l) => ({
        id: l.id,
        status: "dry-run",
        would_create: {
          company: { name: l.company, domain: l.domain || null },
          contact: l.kind === "contact" ? { ...splitName(l.name), jobtitle: l.title, lifecyclestage: "lead" } : null,
          note: `ICP ${l.score}/100, tier ${l.tier}, ${l.event_name}`,
        },
      })),
    });
  }

  const results = [];
  for (const lead of leads) {
    try {
      results.push(await pushLead(token, lead));
    } catch (err) {
      results.push({ id: lead.id, status: "error", error: String(err.message || err) });
    }
  }
  return res.status(200).json({ mode: "live", unknown, results });
};
