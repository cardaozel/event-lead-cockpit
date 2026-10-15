#!/usr/bin/env python3
"""
Build step: raw event data + enrichment + ICP config -> data/cockpit.json

    raw/events.json     the 10 events (dates, why, list status)
    raw/people.json     public speakers and sponsors per event
    raw/companies.json  enrichment seed (type, segment, country, domain)
    config/icp.json     scoring weights, keywords, reference stories

Every record ends up in exactly one bucket:
    leads     buyer-side people and accounts, scored and tiered A/B/C
    partners  SAP / logistics integrators (channel, not pipeline)
    excluded  vendors, consultancies, academics, associations, public sector
"""
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load(rel):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def slug(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def match_keywords(title, rules, key="keywords"):
    """Return the highest-scoring rule whose keyword appears in the title."""
    t = f" {title.lower()} "
    best = None
    for rule in rules:
        if any(k in t for k in rule[key]):
            if best is None or rule["points"] > best["points"]:
                best = rule
    return best


def seniority_of(title, rules):
    t = f" {title.lower()} "
    for rule in rules:  # ordered top-down, first hit wins
        if rule["keywords"] and any(k in t for k in rule["keywords"]):
            return rule
    return rules[-1]


def region_of(country, regions):
    for name, r in regions.items():
        if country in r["countries"]:
            return name, r["points"]
    return "Other", regions["Other"]["points"]


def pick_reference(persona, segment, refs):
    refs = {k: v for k, v in refs.items() if not k.startswith("_")}
    for test in (
        lambda r: persona in r["fits_personas"] and segment in r["fits_segments"],
        lambda r: persona in r["fits_personas"],
        lambda r: segment in r["fits_segments"],
    ):
        for key, r in refs.items():
            if test(r):
                return {"id": key, "customer": r["customer"], "story": r["story"]}
    return None


def score_person(p, company, icp):
    w = icp["weights"]
    seg = icp["segments"].get(company.get("segment", "other"), icp["segments"]["other"])
    func = match_keywords(p.get("title", ""), icp["functions"])
    sen = seniority_of(p.get("title", ""), icp["seniority"])
    region, region_pts = region_of(company.get("country", ""), icp["regions"])
    signal = icp["signals"].get(p.get("role", "speaker"), {"points": 0, "label": ""})

    parts = [
        {"factor": "Segment", "points": round(w["segment"] * seg["points"]), "max": w["segment"], "why": seg["label"]},
        {"factor": "Function", "points": round(w["function"] * (func["points"] if func else 0)), "max": w["function"],
         "why": func["persona"] if func else "No P2P / O2C / supply chain function in title"},
        {"factor": "Seniority", "points": round(w["seniority"] * sen["points"]), "max": w["seniority"], "why": sen["level"]},
        {"factor": "Region", "points": round(w["region"] * region_pts), "max": w["region"], "why": region},
        {"factor": "Event signal", "points": round(w["signal"] * signal["points"]), "max": w["signal"], "why": signal["label"]},
    ]
    total = sum(x["points"] for x in parts)
    tiers = icp["tiers"]
    tier = "A" if total >= tiers["A"] else "B" if total >= tiers["B"] else "C"

    flags = []
    if not p.get("title"):
        flags.append("Title missing: enrich before outreach")
    if not company.get("domain"):
        flags.append("No domain: company dedupe in HubSpot by name only")

    persona = func["persona"] if func else "Unclassified"
    return {
        "score": total,
        "tier": tier,
        "persona": persona,
        "seniority": sen["level"],
        "region": region,
        "breakdown": parts,
        "reference": pick_reference(persona, company.get("segment", "other"), icp["references"]),
        "flags": flags,
    }


def main():
    events = load("data/raw/events.json")
    raw = load("data/raw/people.json")
    companies = load("data/raw/companies.json")["companies"]
    icp = load("config/icp.json")
    sources = raw["sources"]
    event_by_id = {e["id"]: e for e in events}

    leads, partners, excluded = [], [], []

    def route(record, company_name, role):
        company = companies.get(company_name)
        if company is None:
            raise SystemExit(f"Missing enrichment for company: {company_name!r}")
        ctype = company["type"]
        base = {
            "event_id": record["event"],
            "event_name": event_by_id[record["event"]]["name"],
            "role": role,
            "company": company_name,
            "company_type": ctype,
            "segment": company.get("segment", "other"),
            "country": company.get("country", ""),
            "domain": company.get("domain", ""),
            "source_url": sources.get(record["src"], ""),
        }
        return company, ctype, base

    for p in raw["people"]:
        p = {**p, "role": "speaker"}
        company, ctype, base = route(p, p["company"], "speaker")
        person = {**base, "kind": "contact", "name": p["name"], "title": p.get("title", ""),
                  "id": slug(f"{p['name']}-{p['company']}-{p['event']}")}
        if ctype in icp["buyer_types"]:
            leads.append({**person, **score_person(p, company, icp)})
        elif ctype in icp["partner_types"]:
            partners.append({**person, "reason": "Integrator: potential channel partner"})
        else:
            excluded.append({**person, "reason": icp["excluded_types"].get(ctype, ctype)})

    for o in raw["organisations"]:
        company, ctype, base = route(o, o["company"], o["role"])
        acct = {**base, "kind": "account", "name": o["company"], "title": f"{o['role'].capitalize()} at {event_by_id[o['event']]['name']}",
                "id": slug(f"{o['company']}-{o['event']}")}
        if ctype in icp["buyer_types"]:
            leads.append({**acct, **score_person({"title": "", "role": o["role"]}, company, icp)})
        elif ctype in icp["partner_types"]:
            partners.append({**acct, "reason": "SAP / logistics integrator: channel partner, not a buyer"})
        else:
            excluded.append({**acct, "reason": icp["excluded_types"].get(ctype, ctype)})

    leads.sort(key=lambda x: (-x["score"], x["name"]))

    for e in events:
        mine = [l for l in leads if l["event_id"] == e["id"]]
        e["counts"] = {
            "leads": len(mine),
            "A": sum(1 for l in mine if l["tier"] == "A"),
            "B": sum(1 for l in mine if l["tier"] == "B"),
            "C": sum(1 for l in mine if l["tier"] == "C"),
            "partners": sum(1 for x in partners if x["event_id"] == e["id"]),
            "excluded": sum(1 for x in excluded if x["event_id"] == e["id"]),
        }

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "icp_weights": icp["weights"],
        "tiers": icp["tiers"],
        "events": sorted(events, key=lambda e: e["start"]),
        "leads": leads,
        "partners": partners,
        "excluded": excluded,
    }
    (ROOT / "data" / "cockpit.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    tiers = {t: sum(1 for l in leads if l["tier"] == t) for t in "ABC"}
    print(f"{len(leads)} leads (A {tiers['A']} / B {tiers['B']} / C {tiers['C']}), "
          f"{len(partners)} partners, {len(excluded)} excluded")
    for l in leads[:12]:
        print(f"  {l['score']:>3} {l['tier']}  {l['name']:<28} {l['company']:<28} {l['persona']}")


if __name__ == "__main__":
    main()
