(() => {
  "use strict";

  const STORE_KEY = "elc-review-v1";
  const FACTOR_COLOR = {
    Segment: "var(--s-segment)",
    Function: "var(--s-function)",
    Seniority: "var(--s-seniority)",
    Region: "var(--s-region)",
    "Event signal": "var(--s-signal)",
  };
  const SEGMENT_LABEL = {
    metal: "Metal", food: "Food & beverage", distribution: "Distribution",
    manufacturing: "Manufacturing", retail: "Retail", logistics: "Logistics", other: "Other",
  };
  const LIST_STATUS = {
    published: "Speakers published",
    pending: "List not published yet",
    "vendor-heavy": "Mostly vendors on stage",
    "visitor-led": "Buyers attend as visitors",
  };
  const TYPE_LABEL = {
    vendor: "Vendor", consultancy: "Consultancy", academia: "Academia",
    association: "Association", public: "Public sector", integrator: "Integrator",
  };

  const state = {
    data: null,
    view: "leads",
    eventId: null,
    tiers: new Set(["A", "B", "C"]),
    status: "all",
    query: "",
    selectedId: null,
    review: loadReview(),
    crm: { mode: "unknown", keyRequired: false },
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function loadReview() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { return {}; }
  }
  function saveReview() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.review)); } catch { /* storage unavailable: keep in memory */ }
  }
  const statusOf = (id) => state.review[id] || "pending";

  function fmtRange(a, b) {
    const s = new Date(a + "T00:00:00"), e = new Date(b + "T00:00:00");
    const m = (d) => d.toLocaleString("en-GB", { month: "short" });
    const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
    const left = sameMonth ? `${s.getDate()}` : `${s.getDate()} ${m(s)}`;
    return `${left}–${e.getDate()} ${m(e)} ${e.getFullYear()}`;
  }
  function daysUntil(d) {
    const ms = new Date(d + "T00:00:00") - new Date(new Date().toDateString());
    return Math.round(ms / 86400000);
  }

  // ---------- events rail ----------
  function renderEvents() {
    const list = $("eventList");
    list.innerHTML = state.data.events.map((e) => {
      const c = e.counts, total = Math.max(c.leads, 1);
      const d = new Date(e.start + "T00:00:00");
      const until = daysUntil(e.start);
      const when = until <= 0 ? "now" : until < 45 ? `in ${until} days` : "";
      const bar = c.leads
        ? `<span class="yield-bar" aria-hidden="true">${["A", "B", "C"].map((t) => `<span class="y-${t}" style="width:${(c[t] / total) * 100}%"></span>`).join("")}</span>
           <span>${c.leads} leads${c.A ? `, ${c.A} A` : ""}</span>`
        : `<span class="status-tag" data-s="${e.list_status}">${LIST_STATUS[e.list_status]}</span>`;
      return `<li class="event-item">
        <button type="button" data-event="${e.id}" aria-current="${state.eventId === e.id}">
          <span class="event-date"><b>${d.getDate()}</b><small>${d.toLocaleString("en-GB", { month: "short" })} ${String(d.getFullYear()).slice(2)}</small></span>
          <span>
            <span class="event-name">${esc(e.name)}</span>
            <span class="event-meta">${esc(e.city)}${when ? `, ${when}` : ""}</span>
            <span class="event-yield">${bar}</span>
          </span>
        </button></li>`;
    }).join("");
    $("allEvents").setAttribute("aria-pressed", String(!state.eventId));
  }

  function renderBrief() {
    const box = $("eventBrief");
    const e = state.data.events.find((x) => x.id === state.eventId);
    if (!e) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `
      <h2>${esc(e.name)}</h2>
      <p class="when">${fmtRange(e.start, e.end)}, ${esc(e.city)}. ${esc(e.format)}. <a href="${esc(e.url)}" target="_blank" rel="noopener">Event site</a></p>
      <dl>
        <dt>Why this event</dt><dd>${esc(e.why)}</dd>
        <dt>Who attends</dt><dd>${esc(e.audience)}</dd>
        <dt>Lead source</dt><dd>${esc(LIST_STATUS[e.list_status])}. ${esc(e.list_note)}</dd>
      </dl>`;
  }

  // ---------- filtering ----------
  function inEvent(r) { return !state.eventId || r.event_id === state.eventId; }
  function matchesQuery(r) {
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    return [r.name, r.company, r.title, r.persona].some((v) => (v || "").toLowerCase().includes(q));
  }
  function visibleLeads() {
    return state.data.leads.filter((l) =>
      inEvent(l) && state.tiers.has(l.tier) && matchesQuery(l) &&
      (state.status === "all" || statusOf(l.id) === state.status));
  }

  function renderSummary() {
    const leads = state.data.leads.filter(inEvent);
    const by = (s) => leads.filter((l) => statusOf(l.id) === s).length;
    const a = leads.filter((l) => l.tier === "A").length;
    $("summary").innerHTML = `
      <span><b>${leads.length}</b>leads</span>
      <span><b>${a}</b>tier A</span>
      <span><b>${by("pending")}</b>to review</span>
      <span><b>${by("approved")}</b>approved</span>
      <span><b>${by("synced")}</b>in HubSpot</span>`;
    const approved = state.data.leads.filter((l) => statusOf(l.id) === "approved").length;
    const btn = $("pushBtn");
    btn.disabled = approved === 0;
    btn.textContent = approved ? `Push ${approved} approved to HubSpot` : "Push approved to HubSpot";

    const n = (arr) => arr.filter(inEvent).length;
    document.querySelectorAll(".tab").forEach((t) => {
      const v = t.dataset.view;
      const count = v === "leads" ? n(state.data.leads) : n(state.data[v]);
      t.innerHTML = `${{ leads: "Leads", partners: "Partners", excluded: "Filtered out" }[v]}<span class="n">${count}</span>`;
      t.setAttribute("aria-selected", String(state.view === v));
    });
    document.querySelector(".filters").style.visibility = state.view === "leads" ? "visible" : "hidden";
  }

  // ---------- table ----------
  function scoreBar(l) {
    return `<span class="score-bar" aria-hidden="true">${l.breakdown.map((b) =>
      `<span style="width:${b.points}%;background:${FACTOR_COLOR[b.factor]}"></span>`).join("")}</span>`;
  }
  function reviewCell(l) {
    const s = statusOf(l.id);
    if (s === "synced") return `<span class="synced">In HubSpot</span>`;
    return `<span class="review">
      <button class="btn btn-approve" data-act="approved" data-id="${l.id}" aria-pressed="${s === "approved"}">Approve</button>
      <button class="btn btn-reject" data-act="rejected" data-id="${l.id}" aria-pressed="${s === "rejected"}">Reject</button>
    </span>`;
  }

  function renderTable() {
    const wrap = $("tableWrap");
    if (state.view !== "leads") return renderOther(wrap);

    const rows = visibleLeads();
    if (!rows.length) {
      const ev = state.data.events.find((e) => e.id === state.eventId);
      wrap.innerHTML = ev && !ev.counts.leads
        ? `<div class="empty"><b>No people sourced for this event yet.</b><p>${esc(ev.list_note)}</p></div>`
        : `<div class="empty"><b>No leads match these filters.</b><p>Turn a tier back on or clear the search.</p></div>`;
      return;
    }
    wrap.innerHTML = `<table>
      <thead><tr>
        <th class="col-score">Score</th><th>Person</th><th>Company</th>
        ${state.eventId ? "" : "<th class=\"col-event\">Event</th>"}<th>Persona</th><th class="col-review">Review</th>
      </tr></thead>
      <tbody>${rows.map((l) => `
        <tr data-id="${l.id}" aria-selected="${state.selectedId === l.id}" tabindex="0">
          <td class="col-score"><span class="score"><span class="tier tier-${l.tier}" title="Tier ${l.tier}">${l.tier}</span><span class="score-num">${l.score}</span>${scoreBar(l)}</span></td>
          <td class="col-person person"><b>${esc(l.name)}</b><div class="t">${esc(l.title || "Title not published")}</div></td>
          <td class="col-co co">${esc(l.company)}<div class="s">${SEGMENT_LABEL[l.segment]}, ${esc(l.country)}</div></td>
          ${state.eventId ? "" : `<td class="col-event persona">${esc(l.event_name)}</td>`}
          <td class="col-persona persona">${esc(l.persona)}</td>
          <td class="col-review">${reviewCell(l)}</td>
        </tr>`).join("")}</tbody></table>`;
  }

  function renderOther(wrap) {
    const rows = state.data[state.view].filter(inEvent);
    const intro = state.view === "partners"
      ? "SAP and logistics integrators. Not buyers, but they sit inside target accounts' ERP projects: a channel to work with, not a list to sell to."
      : "Kept out of the pipeline on purpose. Vendors, consultancies, academics and organisers fill most conference stages; pushing them to HubSpot would pollute the CRM.";
    if (!rows.length) { wrap.innerHTML = `<div class="empty"><p>${intro}</p><p>None for this event.</p></div>`; return; }
    wrap.innerHTML = `<div class="empty" style="text-align:left;padding:14px 16px 4px"><p style="margin:0">${intro}</p></div>
      <table><thead><tr><th>Name</th><th>Company</th><th>Type</th><th>Reason</th><th>Event</th></tr></thead>
      <tbody>${rows.map((r) => `<tr style="cursor:default">
        <td class="person"><b>${esc(r.name)}</b><div class="t">${esc(r.title)}</div></td>
        <td>${esc(r.company)}</td><td class="persona">${TYPE_LABEL[r.company_type] || esc(r.company_type)}</td>
        <td class="persona">${esc(r.reason)}</td><td class="persona">${esc(r.event_name)}</td></tr>`).join("")}</tbody></table>`;
  }

  // ---------- drawer ----------
  function renderDrawer() {
    const d = $("drawer");
    const l = state.data.leads.find((x) => x.id === state.selectedId);
    document.querySelector(".layout").classList.toggle("has-drawer", Boolean(l));
    if (!l) { d.hidden = true; return; }
    d.hidden = false;
    const s = statusOf(l.id);
    d.innerHTML = `
      <button class="btn drawer-close" id="closeDrawer">Close</button>
      <h2>${esc(l.name)}</h2>
      <p class="sub">${esc(l.title || "Title not published")}<br>${esc(l.company)}</p>
      <div class="big-score"><span class="tier tier-${l.tier}">${l.tier}</span><span class="n">${l.score}</span><span class="of">of 100</span></div>
      <h3>Why this score</h3>
      <ul class="factors">${l.breakdown.map((b) => `
        <li><span>${b.factor}</span>
          <span class="factor-track"><span style="width:${(b.points / b.max) * 100}%;background:${FACTOR_COLOR[b.factor]}"></span></span>
          <span class="factor-pts">${b.points}/${b.max}</span>
          <span class="why">${esc(b.why)}</span></li>`).join("")}
      </ul>
      ${l.reference ? `<h3>Suggested opener</h3><div class="opener"><b>${esc(l.reference.customer)}</b>${esc(l.reference.story)}</div>` : ""}
      ${l.flags.length ? `<h3>Before outreach</h3><ul class="flags">${l.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      <h3>Source</h3>
      <dl class="facts">
        <dt>Event</dt><dd>${esc(l.event_name)}</dd>
        <dt>Role</dt><dd>${esc(l.role)}</dd>
        <dt>Segment</dt><dd>${SEGMENT_LABEL[l.segment]}</dd>
        <dt>Domain</dt><dd>${esc(l.domain || "Unknown")}</dd>
        <dt>Listing</dt><dd>${l.source_url ? `<a href="${esc(l.source_url)}" target="_blank" rel="noopener">Public speaker list</a>` : "Unknown"}</dd>
      </dl>
      <div class="drawer-actions">${s === "synced" ? `<span class="synced">In HubSpot</span>` : reviewCell(l)}</div>`;
  }

  function renderAll() {
    renderEvents(); renderBrief(); renderSummary(); renderTable(); renderDrawer();
  }

  // ---------- review + push ----------
  function setReview(id, act) {
    state.review[id] = statusOf(id) === act ? undefined : act;
    if (!state.review[id]) delete state.review[id];
    saveReview(); renderAll();
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 5200);
  }

  async function checkCrm() {
    const el = $("crmMode");
    try {
      const r = await fetch("/api/hubspot");
      if (!r.ok) throw new Error();
      state.crm = await r.json();
      el.dataset.mode = state.crm.mode;
      el.textContent = state.crm.mode === "live" ? "HubSpot connected" : "HubSpot dry run (no token)";
    } catch {
      el.dataset.mode = "offline";
      el.textContent = "HubSpot API unavailable here";
    }
  }

  function pushKey() {
    try { return sessionStorage.getItem("elc-push-key") || ""; } catch { return ""; }
  }

  async function push() {
    const ids = state.data.leads.filter((l) => statusOf(l.id) === "approved").map((l) => l.id);
    if (!ids.length) return;
    const btn = $("pushBtn");
    btn.disabled = true; btn.textContent = `Pushing ${ids.length}…`;
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
        if (r.status === 401) { try { sessionStorage.removeItem("elc-push-key"); } catch { /* ignore */ } throw new Error("Push key wrong. Try again."); }
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        results.push(...body.results);
        if (body.mode === "dry-run") {
          toast(`Dry run: ${ids.length} leads would be created in HubSpot. Add HUBSPOT_TOKEN in Vercel to push for real.`);
          console.table(body.results.map((x) => ({ id: x.id, ...x.would_create.company, contact: x.would_create.contact && x.would_create.contact.lastname })));
          return;
        }
      }
      const ok = results.filter((x) => x.status === "synced");
      ok.forEach((x) => (state.review[x.id] = "synced"));
      saveReview();
      const failed = results.length - ok.length;
      toast(failed ? `Pushed ${ok.length} to HubSpot. ${failed} failed: ${results.find((x) => x.error).error}` : `Pushed ${ok.length} leads to HubSpot.`);
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
    $("allEvents").addEventListener("click", () => { state.eventId = null; renderAll(); });
    document.querySelector(".tabs").addEventListener("click", (ev) => {
      const t = ev.target.closest("[data-view]");
      if (!t) return;
      state.view = t.dataset.view; state.selectedId = null; renderAll();
    });
    $("tierChips").addEventListener("click", (ev) => {
      const c = ev.target.closest("[data-tier]");
      if (!c) return;
      const t = c.dataset.tier;
      state.tiers.has(t) ? state.tiers.delete(t) : state.tiers.add(t);
      c.setAttribute("aria-pressed", String(state.tiers.has(t)));
      renderAll();
    });
    $("statusFilter").addEventListener("change", (ev) => { state.status = ev.target.value; renderAll(); });
    $("search").addEventListener("input", (ev) => { state.query = ev.target.value.trim(); renderTable(); });

    document.addEventListener("click", (ev) => {
      const act = ev.target.closest("[data-act]");
      if (act) { ev.stopPropagation(); setReview(act.dataset.id, act.dataset.act); return; }
      if (ev.target.id === "closeDrawer") { state.selectedId = null; renderAll(); return; }
      const row = ev.target.closest("tr[data-id]");
      if (row) { state.selectedId = row.dataset.id; renderTable(); renderDrawer(); }
    });
    $("tableWrap").addEventListener("keydown", (ev) => {
      const row = ev.target.closest("tr[data-id]");
      if (!row) return;
      if (ev.key === "Enter") { state.selectedId = row.dataset.id; renderTable(); renderDrawer(); }
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
      $("tableWrap").innerHTML = `<div class="empty"><b>Could not load data/cockpit.json.</b><p>Run python3 scripts/build.py and reload.</p></div>`;
      return;
    }
    bind(); renderAll(); checkCrm();
  }

  init();
})();
