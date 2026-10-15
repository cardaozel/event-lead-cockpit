# Event lead cockpit

Case study for GeneralMind (GTM Engineer). Live: **https://event-lead-cockpit.vercel.app**

Ten upcoming events relevant to GeneralMind's buyers, a pipeline that turns each event's public
speaker and sponsor lists into scored leads, a review cockpit, and a HubSpot push for the leads a
human approves.

## How it works

```
data/raw/events.json      10 events: dates, why they matter, whether a list is published
data/raw/people.json      public speaker / sponsor lists per event (no contact data)
data/raw/companies.json   enrichment seed: company type, segment, country, domain
config/icp.json           ICP: weights, keywords, tiers, reference customer stories
        │
        ▼
scripts/build.py          route → score → tier  ➜  data/cockpit.json
        │
        ▼
index.html + app.js       cockpit: filter by event / tier / status, inspect score, approve or reject
        │  (lead IDs only)
        ▼
api/hubspot.js            Vercel function: upsert company (by domain) and contact,
                          associate them, attach a note with score, reason and source
```

**Routing.** Every record lands in one bucket: *leads* (buyer-side people and accounts),
*partners* (SAP / logistics integrators: channel, not pipeline) or *filtered out* (vendors,
consultancies, academics, organisers, public sector). Conference stages are full of sellers;
keeping them out of the CRM is half the value.

**Scoring (0–100).** Segment fit 30, function 30, seniority 20, region 10, event signal 10.
Segment weights follow GeneralMind's public customers: metal distribution (Kloeckner Metals),
food & beverage (Oatly, bofrost*), distribution, logistics (Müller – Die Lila Logistik),
manufacturing (TMD Friction). Function weights favour Procure-to-Pay and Order-to-Cash owners.
Tier A ≥ 88, B ≥ 70. Each lead carries the closest customer story as a suggested opener.

**HubSpot.** The browser sends lead IDs only; the function reads lead data from the bundled
`cockpit.json`, so the endpoint cannot be used to write arbitrary data. Without a token it runs
as a dry run and returns what it would create.

## Run locally

```bash
python3 scripts/build.py          # rebuild data/cockpit.json after editing raw data or ICP
python3 -m http.server 8000       # open http://localhost:8000 (HubSpot push needs `vercel dev`)
```

## Environment variables (Vercel)

| Name | Purpose |
| --- | --- |
| `HUBSPOT_TOKEN` | Private app token. Scopes: `crm.objects.contacts.read/write`, `crm.objects.companies.read/write`. |
| `PUSH_KEY` | Optional. When set, pushing asks for this key, so a shared link can view but not write. |

## Honest limits of this build

- Attendee lists are not public. Speakers and sponsors are used as the attending-leads proxy.
- Seven of the ten events have no buyer-side names yet: five have not published their programmes,
  EuroBLECH buyers attend as unlisted visitors, and LogiMAT's stage is vendors. The cockpit says
  so per event instead of filling the gap with guesses; the full system plan covers how to fill it.
- Enrichment is a hand-built seed. In production this is an enrichment provider keyed on domain.
- Review state is saved in the viewer's browser. In production it lives in a shared store.
