(() => {
  "use strict";

  const STORE_KEY = "elc-review-v3";
  const FACTOR_COLOR = {
    Segment: "var(--s-segment)",
    Function: "var(--s-function)",
    Seniority: "var(--s-seniority)",
    Region: "var(--s-region)",
    Evidence: "var(--s-signal)",
  };
  const SEGMENT_LABEL = {
    metal: "Metal", food: "Food & beverage", distribution: "Distribution",
    manufacturing: "Manufacturing", retail: "Retail", logistics: "Logistics", other: "Other",
  };
  const ROLE_LABEL = {
    "speaker:organiser": "Speaker, organiser source",
    "speaker:organiser-undated": "Speaker, undated organiser list",
    "speaker:third-party": "Speaker, third-party listing",
    "speaking company": "Speaking company",
    exhibitor: "Exhibitor",
    "exhibitor staff": "Exhibitor staff",
    sponsor: "Sponsor",
  };
  const TYPE_LABEL = {
    vendor: "Vendor", consultancy: "Consultancy", academia: "Academia / think tank",
    association: "Association", public: "Public sector", integrator: "Integrator", former: "Former role",
  };

  const state = {
    data: null,
    view: "leads",
    eventId: null,
    tiers: new Set(["A", "B", "C"]),
    status: "all",
    query: "",
    selectedId: null,
    evf: { country: "all", city: "all", when: "all" },
    review: loadReview(),
    links: loadLinks(),
    crm: { mode: "checking", keyRequired: false },
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function loadReview() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { return {}; }
  }
  function saveReview() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.review)); } catch { /* storage unavailable: keep in memory */ }
  }
  function loadLinks() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY + "-links") || "{}"); } catch { return {}; }
  }
  function saveLinks() {
    try { localStorage.setItem(STORE_KEY + "-links", JSON.stringify(state.links)); } catch { /* keep in memory */ }
  }
  const statusOf = (id) => state.review[id] || "pending";
  const syncedCell = (id) => state.links[id]
    ? `<a class="synced" href="${esc(state.links[id])}" target="_blank" rel="noopener">Open in HubSpot</a>`
    : `<span class="synced">In HubSpot</span>`;

  const parseDay = (d) => new Date(d + "T00:00:00");
  function fmtRange(a, b) {
    const s = parseDay(a), e = parseDay(b);
    const m = (d) => d.toLocaleString("en-GB", { month: "short" });
    const left = s.getMonth() === e.getMonth() ? `${s.getDate()}` : `${s.getDate()} ${m(s)}`;
    return `${left}–${e.getDate()} ${m(e)} ${e.getFullYear()}`;
  }
  const COUNTRY = { DE: "Germany", CH: "Switzerland", AT: "Austria", ES: "Spain", NL: "Netherlands", FR: "France", IT: "Italy", GB: "United Kingdom" };
  function dowRange(a, b) {
    const f = (d) => parseDay(d).toLocaleString("en-GB", { weekday: "short" });
    return a === b ? f(a) : `${f(a)}–${f(b)}`;
  }
  function daysUntil(d) {
    return Math.round((parseDay(d) - new Date(new Date().toDateString())) / 86400000);
  }

  // ---------- event filter ----------
  function eventMatches(e) {
    const f = state.evf;
    if (f.country !== "all" && e.country !== f.country) return false;
    if (f.city !== "all" && e.city !== f.city) return false;
    if (f.when === "30" || f.when === "90") { const d = daysUntil(e.start); if (d > Number(f.when)) return false; }
    if (f.when === "2026" && !e.start.startsWith("2026")) return false;
    if (f.when === "2027" && !e.start.startsWith("2027")) return false;
    return true;
  }
  const visibleEvents = () => state.data.events.filter(eventMatches);
  const filterActive = () => Object.values(state.evf).some((v) => v !== "all");
  function renderFilterOptions() {
    const evs = state.data.events;
    const countries = [...new Set(evs.map((e) => e.country))];
    const cities = [...new Set(evs.filter((e) => state.evf.country === "all" || e.country === state.evf.country).map((e) => e.city))].sort();
    $("fCountry").innerHTML = `<option value="all">All countries</option>` + countries.map((c) => `<option value="${c}">${COUNTRY[c] || c}</option>`).join("");
    $("fCity").innerHTML = `<option value="all">All cities</option>` + cities.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    $("fCountry").value = state.evf.country;
    if (!cities.includes(state.evf.city)) state.evf.city = "all";
    $("fCity").value = state.evf.city;
    $("fWhen").value = state.evf.when;
  }

  // ---------- events rail ----------
  function renderEvents() {
    const shown = visibleEvents();
    $("eventCount").textContent = filterActive() ? `${shown.length} of ${state.data.events.length}` : String(state.data.events.length);
    $("evFilterDot").hidden = !filterActive();
    $("barSub").textContent = `${state.data.events.length} upcoming events · ${state.data.leads.length} scored leads · every record linked to its source`;
    if (!shown.length) { $("eventList").innerHTML = `<li class="ev-empty">No events match these filters.</li>`; return; }
    $("eventList").innerHTML = shown.map((e) => {
      const c = e.counts, total = Math.max(c.leads, 1);
      const d = parseDay(e.start);
      const until = daysUntil(e.start);
      const when = until <= 0 ? "on now" : until < 45 ? `in ${until} days` : "";
      const what = [c.people ? `${c.people} ${c.people === 1 ? "person" : "people"}` : "", c.accounts ? `${c.accounts} ${c.accounts === 1 ? "company" : "companies"}` : ""].filter(Boolean).join(", ");
      const yieldLine = c.leads
        ? `<span class="yield-bar" aria-hidden="true">${["A", "B", "C"].map((t) => `<span class="y-${t}" style="width:${(c[t] / total) * 100}%"></span>`).join("")}</span>
           <span>${what}${c.A ? `, ${c.A} A` : ""}</span>`
        : `<span class="status-tag">${esc(e.rail_note || "No names yet for this edition")}</span>`;
      return `<li class="event-item">
        <button type="button" data-event="${e.id}" aria-current="${state.eventId === e.id}">
          <span class="event-date"><small class="dow">${dowRange(e.start, e.end)}</small><b>${d.getDate()}</b><small>${d.toLocaleString("en-GB", { month: "short" })} ${String(d.getFullYear()).slice(2)}</small></span>
          <span>
            <span class="event-name">${esc(e.name)}</span>
            <span class="event-meta">${fmtRange(e.start, e.end)}</span>
            <span class="event-meta">${esc(e.city)}, ${COUNTRY[e.country] || esc(e.country)}${when ? ` · ${when}` : ""}</span>
            <span class="event-yield">${yieldLine}</span>
          </span>
        </button></li>`;
    }).join("");
    $("watchList").innerHTML = state.data.watchlist.map((w) =>
      `<li><b>${esc(w.name)}</b>, ${esc(w.city)}, ${parseDay(w.start).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}<br><span>${esc(w.status)}</span></li>`).join("");
  }

  function renderBrief() {
    const box = $("eventBrief");
    const e = state.data.events.find((x) => x.id === state.eventId);
    if (!e) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `
      <h2>${esc(e.name)}</h2>
      <p class="when">${dowRange(e.start, e.end)}, ${fmtRange(e.start, e.end)} · ${esc(e.city)}, ${COUNTRY[e.country] || esc(e.country)} · ${esc(e.format)}. <a href="${esc(e.url)}" target="_blank" rel="noopener">Event page</a></p>
      <dl>
        <dt>Why this event</dt><dd>${esc(e.why)}</dd>
        <dt>Who attends</dt><dd>${esc(e.audience)}</dd>
        <dt>Evidence</dt><dd>${esc(e.evidence_summary)}</dd>
      </dl>`;
  }

  function renderRules() {
    $("rulesList").innerHTML = Object.entries(state.data.tier_rules).map(([t, txt]) =>
      `<dt><span class="tier tier-${t}">${t}</span></dt><dd>${esc(txt)}</dd>`).join("") +
      `<dt class="rules-note">Score</dt><dd>0 to 100, for ranking within a tier: segment ${state.data.weights.segment}, function ${state.data.weights.function}, seniority ${state.data.weights.seniority}, region ${state.data.weights.region}, evidence ${state.data.weights.evidence}.</dd>`;
  }

  // ---------- filtering ----------
  const inEvent = (r) => state.eventId ? r.event_id === state.eventId : (!filterActive() || visibleEvents().some((e) => e.id === r.event_id));
  function matchesQuery(r) {
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    return [r.name, r.company, r.title, r.persona].some((v) => (v || "").toLowerCase().includes(q));
  }
  const visibleLeads = () => state.data.leads.filter((l) =>
    inEvent(l) && state.tiers.has(l.tier) && matchesQuery(l) &&
    (state.status === "all" || statusOf(l.id) === state.status));

  function renderSummary() {
    const leads = state.data.leads.filter(inEvent);
    const by = (s) => leads.filter((l) => statusOf(l.id) === s).length;
    const t = (x) => leads.filter((l) => l.tier === x).length;
    const total = Math.max(leads.length, 1);
    const pct = (v) => `${(v / total) * 100}%`;
    const tiers = ["A", "B", "C"].map((x) => [x, t(x)]);
    const flow = [["pending", "To review"], ["approved", "Approved"], ["synced", "In HubSpot"], ["rejected", "Rejected"]].map(([k, label]) => [k, label, by(k)]);
    $("summary").innerHTML = `
      <section class="stat-card" aria-label="Lead quality">
        <div class="stat-head"><span class="stat-total">${leads.length}</span><span class="stat-label">leads${state.eventId ? " at this event" : ""}</span><span class="stat-hint">by tier</span></div>
        <div class="stack" aria-hidden="true">${tiers.map(([x, v]) => v ? `<span class="seg seg-${x}" style="width:${pct(v)}"></span>` : "").join("")}</div>
        <div class="stat-parts">${tiers.map(([x, v]) => `<span><i class="dot dot-${x}"></i><b>${v}</b> ${x}</span>`).join('<span class="op">+</span>')}</div>
      </section>
      <section class="stat-card" aria-label="Review progress">
        <div class="stat-head"><span class="stat-total">${by("synced")}<small>/${leads.length}</small></span><span class="stat-label">in HubSpot</span><span class="stat-hint">review flow</span></div>
        <div class="stack" aria-hidden="true">${flow.map(([k, , v]) => v ? `<span class="seg seg-${k}" style="width:${pct(v)}"></span>` : "").join("")}</div>
        <div class="stat-parts">${flow.map(([k, label, v]) => `<span><i class="dot dot-${k}"></i><b>${v}</b> ${label}</span>`).join('<span class="op">→</span>')}</div>
      </section>`;
    renderPushButton();

    const n = (arr) => arr.filter(inEvent).length;
    document.querySelectorAll(".tab").forEach((tab) => {
      const v = tab.dataset.view;
      const count = n(state.data[v]);
      tab.hidden = v === "partners" && state.data.partners.length === 0;
      tab.innerHTML = `${{ leads: "Leads", partners: "Partners", excluded: "Excluded" }[v]}<span class="n">${count}</span>`;
      tab.setAttribute("aria-selected", String(state.view === v));
    });
    document.querySelector(".filters").style.visibility = state.view === "leads" ? "visible" : "hidden";
  }

  function renderPushButton() {
    const approved = state.data.leads.filter((l) => statusOf(l.id) === "approved").length;
    const btn = $("pushBtn");
    const mode = state.crm.mode;
    if (mode === "live") {
      const ap = state.data.leads.filter((l) => statusOf(l.id) === "approved");
      const np = ap.filter((l) => l.kind === "person").length;
      btn.textContent = approved ? `Push ${approved} to HubSpot (${np} contacts, ${approved - np} companies)` : "Approve leads to push them";
      btn.disabled = approved === 0;
    } else if (mode === "dry-run") {
      btn.textContent = approved ? `Preview push of ${approved} (dry run)` : "Approve leads to preview a push";
      btn.disabled = approved === 0;
    } else if (mode === "checking") {
      btn.textContent = "Push approved to HubSpot";
      btn.disabled = true;
    } else {
      btn.textContent = "HubSpot not reachable here";
      btn.disabled = true;
    }
  }

  // ---------- table ----------
  const SEG_SHORT = { metal: "Metal & steel", food: "Food & bev", distribution: "Distribution", logistics: "Logistics", manufacturing: "Manufacturing", retail: "Retail", other: "Off-target segment" };
  const PERSONA_SHORT = {
    "Procure-to-Pay owner": "P2P owner", "Order-to-Cash owner": "O2C owner",
    "Supply chain / logistics leader": "Supply chain lead", "Transformation / digital lead": "Transformation",
    "Executive sponsor": "Exec sponsor", "Account (buyer not named)": "No buyer named", "Unclassified": "Role off-target",
  };
  const SEN_SHORT = { "C-level / VP": "VP+", "Head / Director": "Head / Dir", "Manager": "Manager", "Individual contributor": "IC" };
  const EV_SHORT = { "speaker:organiser": "Organiser source", "speaker:organiser-undated": "Undated list", "speaker:third-party": "3rd-party source", "speaking company": "Company only", exhibitor: "Company only", "exhibitor staff": "Exhibitor staff", sponsor: "Company only" };
  function reasonTags(l) {
    const weak = new Set();
    if (l.segment === "other" || l.segment === "retail") weak.add("seg");
    if (!["Procure-to-Pay owner", "Order-to-Cash owner", "Supply chain / logistics leader"].includes(l.persona)) weak.add("fn");
    if (l.kind === "person" && !["C-level / VP", "Head / Director"].includes(l.seniority)) weak.add("sen");
    if (l.evidence_strength !== "strong") weak.add("ev");
    const t = [["seg", SEG_SHORT[l.segment]], ["fn", PERSONA_SHORT[l.persona] || l.persona]];
    if (l.kind === "person") t.push(["sen", SEN_SHORT[l.seniority] || l.seniority]);
    t.push(["ev", EV_SHORT[l.evidence_level]]);
    return `<span class="tags">${t.map(([k, v]) => `<span class="tag${weak.has(k) ? " miss" : ""}">${esc(v)}</span>`).join("")}</span>`;
  }
  const scoreBar = (l) => `<span class="score-bar" title="${esc(l.breakdown.map((b) => `${b.factor} ${b.points}/${b.max}`).join(" · "))}">${l.breakdown.map((b) =>
    `<span style="width:${b.points}%;background:${FACTOR_COLOR[b.factor]}"></span>`).join("")}</span>`;

  function reviewCell(l) {
    const s = statusOf(l.id);
    if (s === "synced") return syncedCell(l.id);
    return `<span class="review">
      <button class="btn btn-approve" data-act="approved" data-id="${l.id}" aria-pressed="${s === "approved"}">${s === "approved" ? "Approved" : "Approve"}</button>
      <button class="btn btn-reject" data-act="rejected" data-id="${l.id}" aria-pressed="${s === "rejected"}">${s === "rejected" ? "Rejected" : "Reject"}</button>
    </span>`;
  }

  function renderTable() {
    const wrap = $("tableWrap");
    if (state.view !== "leads") return renderOther(wrap);

    const rows = visibleLeads();
    if (!rows.length) {
      const ev = state.data.events.find((e) => e.id === state.eventId);
      wrap.innerHTML = ev && !ev.counts.leads
        ? `<div class="empty"><b>${esc(ev.rail_note || "No names yet for this edition.")}</b><p>${esc(ev.evidence_summary)}</p></div>`
        : `<div class="empty"><b>No leads match these filters.</b><p>Turn a tier back on or clear the search.</p></div>`;
      return;
    }
    wrap.innerHTML = `<table>
      <thead><tr>
        <th class="col-score">Tier and score</th><th>Person or company</th><th>Company</th>
        ${state.eventId ? "" : `<th class="col-event">Event</th>`}<th class="col-persona" title="Amber tags are what keeps a lead out of a higher tier">Why this tier</th><th class="col-review">Review</th>
      </tr></thead>
      <tbody>${rows.map((l) => `
        <tr data-id="${l.id}" aria-selected="${state.selectedId === l.id}" tabindex="0">
          <td class="col-score"><span class="score"><span class="tier tier-${l.tier}" title="Tier ${l.tier}">${l.tier}</span><span class="score-num">${l.score}</span>${scoreBar(l)}</span></td>
          <td class="col-person person"><b>${esc(l.name)}</b>
            <div class="t">${esc(l.kind === "person" ? (l.title || "Title not published") : (l.title || "Company-level record"))}</div>
            <span class="ev ev-${l.evidence_strength === "medium" ? "company" : l.evidence_strength}">${ROLE_LABEL[l.evidence_level]}</span>
            <span class="hs-target">${l.kind === "person" ? "HubSpot: contact + company" : "HubSpot: company only"}</span></td>
          <td class="col-co co">${esc(l.company)}<div class="s">${SEGMENT_LABEL[l.segment]}${l.country ? `, ${esc(l.country)}` : ""}</div></td>
          ${state.eventId ? "" : `<td class="col-event"><span class="event-pill">${esc(l.event_name)}</span>${l.also_at ? l.also_at.map((x) => `<span class="event-pill also">+ ${esc(x)}</span>`).join("") : ""}</td>`}
          <td class="col-persona persona" title="${esc(l.tier_reason)}">${reasonTags(l)}</td>
          <td class="col-review">${reviewCell(l)}</td>
        </tr>`).join("")}</tbody></table>`;
  }

  function renderOther(wrap) {
    const rows = state.data[state.view].filter(inEvent);
    const intro = state.view === "partners"
      ? "SAP and logistics integrators. Not buyers, but they sit inside target accounts' ERP projects: a channel to work with, not a list to sell to."
      : "Kept out of the pipeline on purpose. Vendors, consultancies, academics and organisers fill most conference stages; pushing them to HubSpot would pollute the CRM.";
    if (!rows.length) { wrap.innerHTML = `<div class="empty"><p>${intro}</p><p>None for this event.</p></div>`; return; }
    wrap.innerHTML = `<div class="intro">${intro}</div>
      <table><thead><tr><th>Name</th><th>Company</th><th>Type</th><th>Reason</th><th class="col-event">Event</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="static">
        <td class="person"><b>${esc(r.name)}</b><div class="t">${esc(r.title)}</div></td>
        <td>${esc(r.company)}</td><td class="persona">${TYPE_LABEL[r.company_type] || esc(r.company_type)}</td>
        <td class="persona">${esc(r.reason)}</td><td class="persona col-event">${esc(r.event_name)}</td></tr>`).join("")}</tbody></table>`;
  }

  // ---------- drawer ----------
  function renderDrawer() {
    const d = $("drawer");
    const l = state.data.leads.find((x) => x.id === state.selectedId);
    document.querySelector(".layout").classList.toggle("has-drawer", Boolean(l));
    if (!l) { d.hidden = true; return; }
    d.hidden = false;
    const s = statusOf(l.id);
    const isPerson = l.kind === "person";
    d.innerHTML = `
      <button class="btn drawer-close" id="closeDrawer">Close</button>
      <h2>${esc(l.name)}</h2>
      <p class="sub">${isPerson ? esc(l.title || "Title not published") + "<br>" : ""}${esc(l.company)}</p>

      <h3>1. Is ${isPerson ? "this person" : "this company"} at the event?</h3>
      <dl class="facts">
        <dt>Event</dt><dd>${esc(l.event_name)}${l.also_at ? `<br>Also: ${esc(l.also_at.join(", "))}` : ""}</dd>
        <dt>Shown as</dt><dd><span class="ev ev-${l.evidence_strength === "medium" ? "company" : l.evidence_strength}">${ROLE_LABEL[l.evidence_level]}</span></dd>
        <dt>In HubSpot</dt><dd>${isPerson
          ? "Becomes a <b>contact</b>, linked to its <b>company</b>, with a note"
          : "Becomes a <b>company</b> only, with a note. No person is named in the source, so no contact is created"}</dd>
        <dt>Source</dt><dd><a href="${esc(l.source_url)}" target="_blank" rel="noopener">${esc(l.source_label)}</a><br><span class="muted">Checked ${esc(l.checked_on)}</span></dd>
      </dl>

      <h3>2. Is the ${isPerson ? "role" : "company"} right?</h3>
      <dl class="facts">
        ${isPerson ? `<dt>Title</dt><dd>${esc(l.title || "Not published")}</dd>` : ""}
        <dt>Company</dt><dd>${esc(l.company)}, ${SEGMENT_LABEL[l.segment]}${l.country ? `, ${esc(l.country)}` : ""}</dd>
        <dt>Domain</dt><dd>${esc(l.domain || "Unknown")}</dd>
        <dt>Check</dt><dd><a href="${esc(l.linkedin_check)}" target="_blank" rel="noopener">${isPerson ? "Find on LinkedIn" : "Company on LinkedIn"}</a><br><span class="muted">Search link only; not verified yet</span></dd>
      </dl>
      ${l.flags.length ? `<ul class="flags">${l.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}

      <h3>3. Why does it fit GeneralMind?</h3>
      <div class="big-score"><span class="tier tier-${l.tier}">${l.tier}</span><span class="n">${l.score}</span><span class="of">of 100</span></div>
      <p class="tier-reason">${esc(l.tier_reason)}</p>
      <ul class="factors">${l.breakdown.map((b) => `
        <li><span>${b.factor}</span>
          <span class="factor-track"><span style="width:${(b.points / b.max) * 100}%;background:${FACTOR_COLOR[b.factor]}"></span></span>
          <span class="factor-pts">${b.points}/${b.max}</span>
          <span class="why">${esc(b.why)}</span></li>`).join("")}
      </ul>
      ${l.reference ? `<h3>Suggested opener</h3><div class="opener"><b>${esc(l.reference.customer)}</b>${esc(l.reference.story)}</div>` : ""}
      <div class="drawer-actions">${s === "synced" ? syncedCell(l.id) : reviewCell(l)}</div>`;
  }

  function renderAll() {
    renderEvents(); renderBrief(); renderSummary(); renderTable(); renderDrawer();
  }

  // ---------- review + push ----------
  function setReview(id, act) {
    const undo = statusOf(id) === act;
    if (undo) delete state.review[id]; else state.review[id] = act;
    saveReview(); renderAll();
    const ready = state.data.leads.filter((l) => statusOf(l.id) === "approved").length;
    if (!undo && act === "approved") toast(`Approved. ${ready} ready to push to HubSpot.`, 2200);
    else if (!undo && act === "rejected") toast("Rejected. It will not be pushed.", 1800);
  }

  function toast(msg, ms = 6500) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  async function checkCrm() {
    const el = $("crmMode");
    try {
      const r = await fetch("/api/hubspot");
      if (!r.ok) throw new Error();
      state.crm = await r.json();
      el.dataset.mode = state.crm.mode;
      el.textContent = state.crm.mode === "live"
        ? `HubSpot connected${state.crm.keyRequired ? ", push key required" : ""}`
        : "HubSpot dry run: no token set";
    } catch {
      state.crm = { mode: "offline", keyRequired: false };
      el.dataset.mode = "offline";
      el.textContent = "HubSpot not reachable here";
    }
    renderPushButton();
  }

  function pushKey() {
    try { return sessionStorage.getItem("elc-push-key") || ""; } catch { return ""; }
  }

  async function push() {
    const ids = state.data.leads.filter((l) => statusOf(l.id) === "approved").map((l) => l.id);
    if (!ids.length) return;
    const btn = $("pushBtn");
    btn.disabled = true; btn.textContent = `Sending ${ids.length}…`;
    try {
      let key = pushKey();
      if (state.crm.keyRequired && !key) {
        key = window.prompt("Enter the push key to write to HubSpot") || "";
        try { sessionStorage.setItem("elc-push-key", key); } catch { /* ignore */ }
      }
      const results = [];
      for (let i = 0; i < ids.length; i += 25) {
        const r = await fetch("/api/hubspot", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-push-key": key },
          body: JSON.stringify({ ids: ids.slice(i, i + 25) }),
        });
        const body = await r.json();
        if (r.status === 401) { try { sessionStorage.removeItem("elc-push-key"); } catch { /* ignore */ } throw new Error("the push key was wrong. Try again."); }
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        if (body.mode === "dry-run") {
          const companies = new Set(body.results.map((x) => x.would_create.company.name)).size;
          const contacts = body.results.filter((x) => x.would_create.contact).length;
          toast(`Dry run, nothing written. A live push would create or update ${companies} companies and ${contacts} contacts, each with a note holding the score, tier reason and source.`);
          return;
        }
        results.push(...body.results);
      }
      const ok = results.filter((x) => x.status === "synced");
      ok.forEach((x) => {
        state.review[x.id] = "synced";
        state.links[x.id] = (x.contact && x.contact.url) || (x.company && x.company.url) || null;
      });
      saveLinks();
      saveReview();
      const failed = results.filter((x) => x.status === "error");
      const warned = ok.filter((x) => x.warning);
      toast(failed.length
        ? `Pushed ${ok.length} to HubSpot. ${failed.length} failed: ${failed[0].error}`
        : warned.length
          ? `Pushed ${ok.length} to HubSpot. ${warned[0].warning}`
          : (() => {
              const created = ok.filter((x) => (x.contact ? x.contact.created : x.company.created)).length;
              const kept = ok.filter((x) => x.note === "already there").length;
              const contacts = ok.filter((x) => x.contact).length;
              const companiesOnly = ok.length - contacts;
              return `Pushed ${ok.length} to HubSpot (${contacts} as contact + company, ${companiesOnly} as company only): ${created} new, ${ok.length - created} matched existing records` +
                (kept ? `, ${kept} notes already there (not duplicated).` : ", each with a note holding score, tier reason and source.");
            })());
    } catch (err) {
      toast(`Push failed: ${err.message}`);
    } finally {
      renderAll();
    }
  }

  // ---------- events ----------
  function bind() {
    $("eventList").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-event]");
      if (!b) return;
      state.eventId = state.eventId === b.dataset.event ? null : b.dataset.event;
      state.selectedId = null; renderAll();
    });
    $("evFilterBtn").addEventListener("click", () => {
      const open = $("evFilter").hidden;
      $("evFilter").hidden = !open;
      $("evFilterBtn").setAttribute("aria-expanded", String(open));
    });
    const onFilter = () => {
      state.evf = { country: $("fCountry").value, city: $("fCity").value, when: $("fWhen").value };
      if (state.eventId && !visibleEvents().some((e) => e.id === state.eventId)) state.eventId = null;
      state.selectedId = null; renderFilterOptions(); renderAll();
    };
    ["fCountry", "fCity", "fWhen"].forEach((id) => $(id).addEventListener("change", onFilter));
    $("fClear").addEventListener("click", () => { state.evf = { country: "all", city: "all", when: "all" }; state.eventId = null; renderFilterOptions(); renderAll(); });
    document.querySelector(".tabs").addEventListener("click", (ev) => {
      const t = ev.target.closest("[data-view]");
      if (!t) return;
      state.view = t.dataset.view; state.selectedId = null; renderAll();
    });
    $("tierChips").addEventListener("click", (ev) => {
      const c = ev.target.closest("[data-tier]");
      if (!c) return;
      const t = c.dataset.tier;
      if (state.tiers.has(t)) state.tiers.delete(t); else state.tiers.add(t);
      c.setAttribute("aria-pressed", String(state.tiers.has(t)));
      renderAll();
    });
    $("statusFilter").addEventListener("change", (ev) => { state.status = ev.target.value; renderAll(); });
    $("search").addEventListener("input", (ev) => { state.query = ev.target.value.trim(); renderTable(); });

    document.addEventListener("click", (ev) => {
      const act = ev.target.closest("[data-act]");
      if (act) { ev.stopPropagation(); setReview(act.dataset.id, act.dataset.act); return; }
      if (ev.target.id === "closeDrawer") { state.selectedId = null; renderAll(); return; }
      if (ev.target.closest("a")) return;
      const row = ev.target.closest("tr[data-id]");
      if (row) { state.selectedId = row.dataset.id; renderTable(); renderDrawer(); }
    });
    $("tableWrap").addEventListener("keydown", (ev) => {
      const row = ev.target.closest("tr[data-id]");
      if (row && ev.key === "Enter") { state.selectedId = row.dataset.id; renderTable(); renderDrawer(); }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && state.selectedId) { state.selectedId = null; renderAll(); }
    });
    $("pushBtn").addEventListener("click", push);
  }

  async function init() {
    try {
      const r = await fetch("data/cockpit.json", { cache: "no-store" });
      state.data = await r.json();
    } catch {
      $("tableWrap").innerHTML = `<div class="empty"><b>Could not load the lead data.</b><p>The <a href="evidence.html">evidence table</a> has the same records.</p></div>`;
      return;
    }
    bind(); renderRules(); renderFilterOptions(); renderAll(); checkCrm();
  }

  init();
})();
