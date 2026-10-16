#!/usr/bin/env python3
"""
Build step: raw event data + enrichment + ICP config -> data/cockpit.json + evidence.html

    data/raw/events.json     the 10 events and a watchlist
    data/raw/people.json     every person / company exactly as a public source states it
    data/raw/companies.json  enrichment seed (type, segment, country, domain)
    config/icp.json          weights, keywords, evidence levels, tier rules, reference stories

Each record answers three questions, in order:
    1. Is this person / company really at the event?   -> evidence level + source link
    2. Is the role / company right?                    -> title as published + LinkedIn check link
    3. Why does it fit GeneralMind's ICP?              -> score breakdown + written tier reason

Each record lands in one bucket: leads, partners (integrators) or excluded (vendors, consultants,
academics, associations, public sector).
"""
import html
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus

ROOT = Path(__file__).resolve().parent.parent


def load(rel):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def slug(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def best_function(title, rules):
    t = f" {title.lower()} "
    hits = [r for r in rules if any(k in t for k in r["keywords"])]
    return max(hits, key=lambda r: r["points"]) if hits else None


def seniority_of(title, rules):
    t = f" {title.lower()} "
    for rule in rules:
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


def evidence_key(rec, source):
    if rec["role"] == "speaker":
        return "speaker:organiser" if source["publisher"] == "organiser" else "speaker:third-party"
    return rec["role"]


def tier_for(rec, company, persona, seniority, evidence, ev_key, region, icp):
    seg = company.get("segment", "other")
    short = icp["segments"][seg]["short"]
    core = seg in icp["core_segments"]
    strong_seg = seg in icp["strong_segments"]
    senior = seniority in icp["senior_levels"]
    top = seniority == "C-level / VP"
    relevant = persona in icp["relevant_personas"]
    partial = persona in icp["partial_personas"]
    strong_ev = evidence["strength"] == "strong"

    if rec["kind"] == "account":
        if strong_seg:
            return "B", f"Target segment ({short}) and the company is confirmed at the event, but no buyer is named yet."
        return "C", f"Company is confirmed at the event, but it is outside the target segments."

    if relevant and senior and strong_ev and core:
        return "A", f"Core segment ({short}), {persona.lower()} at {seniority} level, {evidence['label'].lower()}."
    if relevant and top and seg == "manufacturing" and ev_key == "speaker:organiser" and region == "DACH":
        return "A", f"Manufacturing at the top of the buying chain: {persona.lower()} at VP or C-level, DACH-based, named by the organiser."

    if strong_seg and (relevant or partial):
        gaps = []
        if not strong_ev:
            gaps.append("evidence is company-level only")
        if partial:
            gaps.append(f"the role is adjacent ({persona.lower()})")
        elif not senior:
            gaps.append(f"the role is relevant but {seniority.lower()}")
        elif seg == "manufacturing":
            bits = []
            if not top: bits.append("below VP level")
            if region != "DACH": bits.append("outside DACH")
            if ev_key != "speaker:organiser": bits.append("named only on a third-party listing")
            gaps.append("manufacturing below the A bar (" + ", ".join(bits) + ")")
        return "B", f"Good fit ({short}, {persona.lower()}), but " + " and ".join(gaps) + "."

    if seg == "retail" and relevant:
        return "B", f"Relevant {persona.lower()}, but retail is an adjacent segment."
    if seg == "retail":
        return "C", "Retail is an adjacent segment and the title shows no buying-relevant function."
    if not strong_seg:
        return "C", "Company is outside the target segments."
    return "C", "No Procure-to-Pay, Order-to-Cash or supply chain function in the published title."


def score(rec, company, evidence, icp):
    w = icp["weights"]
    seg = icp["segments"].get(company.get("segment", "other"), icp["segments"]["other"])
    func = best_function(rec.get("title", ""), icp["functions"]) if rec["kind"] == "person" else None
    sen = seniority_of(rec.get("title", ""), icp["seniority"]) if rec["kind"] == "person" else None
    region, region_pts = region_of(company.get("country", ""), icp["regions"])
    persona = func["persona"] if func else ("Account (buyer not named)" if rec["kind"] == "account" else "Unclassified")
    seniority = sen["level"] if sen else "Not applicable"

    parts = [
        {"factor": "Segment", "points": round(w["segment"] * seg["points"]), "max": w["segment"], "why": seg["label"]},
        {"factor": "Function", "points": round(w["function"] * (func["points"] if func else 0)), "max": w["function"],
         "why": func["persona"] if func else ("No person named yet" if rec["kind"] == "account" else "No P2P / O2C / supply chain function in title")},
        {"factor": "Seniority", "points": round(w["seniority"] * (sen["points"] if sen else 0)), "max": w["seniority"], "why": seniority},
        {"factor": "Region", "points": round(w["region"] * region_pts), "max": w["region"], "why": region},
        {"factor": "Evidence", "points": round(w["evidence"] * evidence["points"]), "max": w["evidence"], "why": evidence["label"]},
    ]
    tier, reason = tier_for(rec, company, persona, seniority, evidence, rec["_ev_key"], region, icp)
    return {
        "score": sum(p["points"] for p in parts),
        "tier": tier,
        "tier_reason": reason,
        "persona": persona,
        "seniority": seniority,
        "region": region,
        "breakdown": parts,
        "reference": pick_reference(persona, company.get("segment", "other"), icp["references"]),
    }


def flags_for(rec, company, source):
    f = []
    if rec["kind"] == "person" and not rec.get("title"):
        f.append("Title not published: confirm role before outreach")
    if rec["kind"] == "person":
        f.append("Confirm current title and employer on LinkedIn")
    if source["publisher"] == "third-party":
        f.append("Source is a third-party listing: confirm on the organiser's agenda")
    if not company.get("domain"):
        f.append("No company domain: HubSpot dedupe falls back to company name")
    if company.get("note"):
        f.append(company["note"])
    return f


def linkedin_search(rec):
    if rec["kind"] != "person":
        return f"https://www.linkedin.com/search/results/companies/?keywords={quote_plus(rec['company'])}"
    return f"https://www.linkedin.com/search/results/people/?keywords={quote_plus(rec['name'] + ' ' + rec['company'])}"


def write_evidence_html(out, path):
    """A plain table with every record, readable without JavaScript."""
    e = html.escape
    events = {ev["id"]: ev for ev in out["events"]}
    rows = []
    for bucket, items in (("Lead", out["leads"]), ("Partner", out["partners"]), ("Filtered out", out["excluded"])):
        for r in items:
            rows.append((events[r["event_id"]]["start"], r["event_name"], bucket, r))
    rows.sort(key=lambda x: (x[0], x[2] != "Lead", -(x[3].get("score") or 0)))

    body = []
    for _, ev_name, bucket, r in rows:
        tier = f"{r['tier']} ({r['score']})" if bucket == "Lead" else "–"
        why = r["tier_reason"] if bucket == "Lead" else r["reason"]
        body.append(
            "<tr>"
            f"<td>{e(ev_name)}</td>"
            f"<td><b>{e(r['name'])}</b><br><span class=t>{e(r['title'] or '')}</span></td>"
            f"<td>{e(r['company'])}</td>"
            f"<td>{e(r['evidence_label'])}<br><a href='{e(r['source_url'])}'>{e(r['source_label'])}</a></td>"
            f"<td>{e(bucket)}</td><td>{e(tier)}</td><td>{e(why)}</td>"
            "</tr>")

    ev_rows = "".join(
        f"<tr><td>{e(ev['name'])}</td><td>{ev['start']} to {ev['end']}</td><td>{e(ev['city'])}</td>"
        f"<td>{ev['counts']['leads']}</td><td>{e(ev['evidence_summary'])}</td></tr>" for ev in out["events"])

    rules = "".join(f"<li><b>{t}</b>: {e(txt)}</li>" for t, txt in out["tier_rules"].items())

    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence Table</title>
<style>
:root {{ --ink:#1b2430; --ink3:#7a838f; --line:#d9dcd4; --paper:#f2f3ef; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --ink:#e6e9ec; --ink3:#9aa3ad; --line:#3a4350; --paper:#161b22; }} }}
:root[data-theme="dark"] {{ --ink:#e6e9ec; --ink3:#9aa3ad; --line:#3a4350; --paper:#161b22; }}
body {{ margin:0; padding:24px 16px; background:var(--paper); color:var(--ink); font:14px/1.5 system-ui, sans-serif; }}
main {{ max-width:1200px; margin:0 auto; }}
h1 {{ font-size:24px; margin:0 0 4px; }} h2 {{ font-size:18px; margin:28px 0 8px; }}
p, li {{ max-width:80ch; }}
.wrap {{ overflow-x:auto; }}
table {{ border-collapse:collapse; width:100%; min-width:900px; }}
th, td {{ text-align:left; vertical-align:top; padding:7px 8px; border-bottom:1px solid var(--line); }}
th {{ color:var(--ink3); font-weight:500; }}
.t {{ color:var(--ink3); }}
.back {{ display:inline-block; margin:0 0 18px; padding:7px 12px; border:1px solid var(--line); border-radius:6px; text-decoration:none; font-weight:500; }}
.back:hover {{ border-color:var(--ink3); }}
a {{ color:inherit; }}
</style></head><body><main>
<a class="back" href="/">&larr; Back to the cockpit</a>
<h1>Evidence table</h1>
<p>Every record in the cockpit, with the public source that puts it at the event. Roles are exactly what the source states. Nobody is labelled an attendee: no public source lists attendees. Sources checked on {out['checked_on']}.</p>
<h2>Tier rules</h2><ul>{rules}</ul>
<h2>Events</h2><div class="wrap"><table><thead><tr><th>Event</th><th>Dates</th><th>City</th><th>Leads</th><th>Evidence</th></tr></thead><tbody>{ev_rows}</tbody></table></div>
<h2>Records ({len(rows)})</h2>
<div class="wrap"><table><thead><tr><th>Event</th><th>Name and title</th><th>Company</th><th>Evidence</th><th>Bucket</th><th>Tier</th><th>Why</th></tr></thead>
<tbody>{''.join(body)}</tbody></table></div>
<p><a class="back" href="/">&larr; Back to the cockpit</a></p>
</main></body></html>"""
    path.write_text(page, encoding="utf-8")


def main():
    ev_data = load("data/raw/events.json")
    raw = load("data/raw/people.json")
    companies = load("data/raw/companies.json")["companies"]
    icp = load("config/icp.json")
    events = ev_data["events"]
    event_by_id = {e["id"]: e for e in events}

    leads, partners, excluded = [], [], []
    seen = {}
    records = sorted(raw["records"], key=lambda r: event_by_id[r["event"]]["start"])
    for rec in records:
        if rec["kind"] == "person":
            key = slug(rec["name"] + "-" + rec["company"])
            if key in seen:
                seen[key].setdefault("also_at", []).append(event_by_id[rec["event"]]["name"])
                continue
        company = companies.get(rec["company"])
        if company is None:
            raise SystemExit(f"Missing enrichment for company: {rec['company']!r}")
        source = raw["sources"][rec["src"]]
        ev_key = evidence_key(rec, source)
        rec = {**rec, "_ev_key": ev_key}
        evidence = icp["evidence_levels"][ev_key]
        base = {
            "id": slug(f"{rec['name']}-{rec['company']}-{rec['event']}"),
            "kind": rec["kind"],
            "name": rec["name"],
            "title": rec.get("title", ""),
            "company": rec["company"],
            "company_type": company["type"],
            "segment": company.get("segment", "other"),
            "country": company.get("country", ""),
            "domain": company.get("domain", ""),
            "event_id": rec["event"],
            "event_name": event_by_id[rec["event"]]["name"],
            "role": rec["role"],
            "evidence_level": ev_key,
            "evidence_label": evidence["label"],
            "evidence_strength": evidence["strength"],
            "source_url": source["url"],
            "source_label": source["label"],
            "source_publisher": source["publisher"],
            "checked_on": raw["checked_on"],
            "linkedin_check": linkedin_search(rec),
            "flags": flags_for(rec, company, source),
        }
        ctype = company["type"]
        if ctype in icp["buyer_types"]:
            item = {**base, **score(rec, company, evidence, icp)}
            leads.append(item)
        elif ctype in icp["partner_types"]:
            item = {**base, "reason": "Integrator: potential channel partner"}
            partners.append(item)
        else:
            item = {**base, "reason": icp["excluded_types"].get(ctype, ctype)}
            excluded.append(item)
        if rec["kind"] == "person":
            seen[slug(rec["name"] + "-" + rec["company"])] = item

    order = {"A": 0, "B": 1, "C": 2}
    leads.sort(key=lambda x: (order[x["tier"]], -x["score"], x["name"]))

    for e in events:
        mine = [l for l in leads if l["event_id"] == e["id"]]
        e["counts"] = {
            "leads": len(mine),
            "people": sum(1 for l in mine if l["kind"] == "person"),
            "accounts": sum(1 for l in mine if l["kind"] == "account"),
            **{t: sum(1 for l in mine if l["tier"] == t) for t in "ABC"},
            "partners": sum(1 for x in partners if x["event_id"] == e["id"]),
            "excluded": sum(1 for x in excluded if x["event_id"] == e["id"]),
        }

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "checked_on": raw["checked_on"],
        "weights": icp["weights"],
        "tier_rules": icp["tier_rules"],
        "events": sorted(events, key=lambda e: e["start"]),
        "watchlist": ev_data["watchlist"],
        "leads": leads,
        "partners": partners,
        "excluded": excluded,
    }
    (ROOT / "data" / "cockpit.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    write_evidence_html(out, ROOT / "evidence.html")

    tiers = {t: sum(1 for l in leads if l["tier"] == t) for t in "ABC"}
    print(f"{len(leads)} leads (A {tiers['A']} / B {tiers['B']} / C {tiers['C']}), "
          f"{len(partners)} partners, {len(excluded)} excluded")
    for e in out["events"]:
        c = e["counts"]
        print(f"  {e['start']}  {e['name'][:42]:<42} leads {c['leads']:>2} (A{c['A']} B{c['B']} C{c['C']}) excl {c['excluded']}")


if __name__ == "__main__":
    main()
