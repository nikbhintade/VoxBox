/* VoxBox Hub Frontend */

const state = {
  tab: "dictation",
  settingsTab: "general",
  appState: null,
  dictations: [],
  insights: null,
  dictionary: [],
  snippets: [],
  transforms: [],
  notes: [],
  resources: null,
  activeNoteId: null,
  searchDictation: "",
  searchDict: "",
  searchSnippets: "",
  searchNotes: "",
  expandedRawIds: new Set(),
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
}

function fmtWords(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatDayGroup(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startToday - startDay) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase();
}

async function refreshState() {
  state.appState = await api("/api/state");
  const cfg = state.appState.config;
  applyTheme(cfg.ui.theme || "dark");

  const hk = state.appState.hotkey_label || "Right Ctrl";
  $("#topbar-hotkey-chip").innerHTML = `Hold <strong>${esc(hk)}</strong>`;

  const dot = $("#status-dot");
  dot.className = `status-dot ${state.appState.state || "ready"}`;
  const st = state.appState.state;
  $("#status-text").textContent =
    st === "recording" ? "Listening…" : st === "processing" ? "Polishing…" : st === "error" ? "Error" : "Ready";
  const llmLabel = cfg.llm.enabled
    ? `${state.appState.llm_provider_label || cfg.llm.provider} · ${state.appState.llm_active_model || cfg.llm.model}`
    : "Raw STT";
  $("#status-sub").textContent = `Hold ${hk} · ${llmLabel}`;
}

async function loadTabData(tab) {
  if (tab === "dictation") {
    const [d, ins] = await Promise.all([
      api(`/api/dictations?q=${encodeURIComponent(state.searchDictation)}`),
      api("/api/insights"),
    ]);
    state.dictations = d.items;
    state.insights = ins;
  } else if (tab === "insights") {
    state.insights = await api("/api/insights");
  } else if (tab === "dictionary") {
    state.dictionary = (await api("/api/dictionary")).items;
  } else if (tab === "snippets") {
    state.snippets = (await api("/api/snippets")).items;
  } else if (tab === "transforms") {
    state.transforms = (await api("/api/transforms")).items;
  } else if (tab === "scratchpad") {
    state.notes = (await api(`/api/scratchpad?q=${encodeURIComponent(state.searchNotes)}`)).items;
  }
}

async function switchTab(tab) {
  if (tab === "settings") {
    await openSettingsModal();
    return;
  }
  state.tab = tab;
  $$("#sidebar-nav .nav-item").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  await loadTabData(tab);
  renderCanvas();
}

function renderCanvas() {
  const root = $("#main-canvas");
  switch (state.tab) {
    case "dictation":
      root.innerHTML = renderDictationView();
      bindDictationEvents();
      break;
    case "notetaker":
      root.innerHTML = renderNotetakerView();
      break;
    case "insights":
      root.innerHTML = renderInsightsView();
      break;
    case "dictionary":
      root.innerHTML = renderDictionaryView();
      bindDictionaryEvents();
      break;
    case "snippets":
      root.innerHTML = renderSnippetsView();
      bindSnippetsEvents();
      break;
    case "style":
      root.innerHTML = renderStyleView();
      bindStyleEvents();
      break;
    case "transforms":
      root.innerHTML = renderTransformsView();
      bindTransformsEvents();
      break;
    case "scratchpad":
      root.innerHTML = renderScratchpadView();
      bindScratchpadEvents();
      break;
  }
}

/* ==================== DICTATION HOME ==================== */

function renderDictationView() {
  const cfg = state.appState.config;
  const ins = state.insights || { total_words: 0, wpm: 0, current_streak: 0, avg_stt_ms: 0, avg_llm_ms: 0 };
  const name = cfg.ui.user_name ? `, ${esc(cfg.ui.user_name)}` : "";

  const groups = new Map();
  for (const item of state.dictations) {
    const g = formatDayGroup(item.created_at);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(item);
  }

  let historyHtml = "";
  if (state.dictations.length === 0) {
    historyHtml = `
      <div class="history-card">
        <div class="empty-state">
          <h4>No dictations yet</h4>
          <p>Hold <strong>${esc(state.appState.hotkey_label)}</strong> anywhere on your desktop, speak, and release. Your history will appear here.</p>
        </div>
      </div>`;
  } else {
    for (const [label, items] of groups.entries()) {
      historyHtml += `<div class="date-heading">${esc(label)}</div><div class="history-card">`;
      for (const it of items) {
        const showRaw = state.expandedRawIds.has(it.id);
        historyHtml += `
          <div class="history-item">
            <div class="history-time">${esc(formatTime(it.created_at))}</div>
            <div class="history-body">
              <div class="history-text">${esc(it.cleaned_text)}</div>
              ${showRaw ? `<div class="history-raw"><strong>Raw Whisper:</strong> ${esc(it.raw_text)}</div>` : ""}
              <div class="history-footer">
                <div class="history-meta">
                  <span>${it.word_count} ${it.word_count === 1 ? "word" : "words"}</span>
                  <span>STT ${it.stt_ms}ms</span>
                  ${it.llm_ms ? `<span>Ollama ${it.llm_ms}ms</span>` : ""}
                  ${it.transform_name ? `<span>Transform: ${esc(it.transform_name)}</span>` : ""}
                </div>
                <div class="history-actions">
                  <button class="btn btn-secondary btn-sm act-copy" data-id="${it.id}">Copy</button>
                  <button class="btn btn-secondary btn-sm act-raw" data-id="${it.id}">${showRaw ? "Hide raw" : "Raw"}</button>
                  <button class="btn btn-secondary btn-sm act-del" data-id="${it.id}" title="Delete">✕</button>
                </div>
              </div>
            </div>
          </div>`;
      }
      historyHtml += `</div>`;
    }
  }

  return `
    <div class="page-container">
      <div class="page-header">
        <h1 class="page-title">Welcome back${name}</h1>
      </div>
      <div class="home-top-grid">
        <div class="hero-banner">
          <h2>Make VoxBox sound like <em>you</em></h2>
          <p>100% offline GPU transcription with local Ollama cleanup. Hold <strong>${esc(state.appState.hotkey_label)}</strong> anywhere to dictate into apps or terminals.</p>
          <div><button class="btn hero-cta" id="btn-hero-style">Customize style</button></div>
        </div>
        <aside class="stats-rail">
          <div class="stat-row"><span class="stat-num">${fmtWords(ins.total_words)}</span><span class="stat-label">total words</span></div>
          <div class="stat-row"><span class="stat-num">${ins.wpm}</span><span class="stat-label">wpm</span></div>
          <div class="stat-row"><span class="stat-num">${ins.current_streak}</span><span class="stat-label">${ins.current_streak === 1 ? "day" : "days"} streak</span></div>
          <div class="stat-divider"></div>
          <div style="font-size:12.5px;color:var(--text-secondary)">
            <div style="font-weight:600;color:var(--text-primary);margin-bottom:4px">Active Pipeline</div>
            <div>CUDA STT · ~${ins.avg_stt_ms || 150}ms</div>
            <div>${cfg.llm.enabled ? `${esc(state.appState.llm_provider_label)} (${esc(state.appState.llm_active_model)})` : "AI Cleanup Off"} · ~${ins.avg_llm_ms || 400}ms</div>
            <div style="margin-top:6px;color:var(--accent)">Style: ${esc(cfg.llm.active_style)}</div>
          </div>
        </aside>
      </div>
      <div class="search-row">
        <span class="search-row-label">Recent Dictations</span>
        <input class="input search-input" id="dictation-search" placeholder="Search transcripts…" value="${esc(state.searchDictation)}" />
      </div>
      ${historyHtml}
    </div>`;
}

function bindDictationEvents() {
  $("#btn-hero-style")?.addEventListener("click", () => switchTab("style"));
  let timer = null;
  $("#dictation-search")?.addEventListener("input", (e) => {
    state.searchDictation = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await loadTabData("dictation");
      renderCanvas();
      const inp = $("#dictation-search");
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }, 180);
  });
  $$(".act-copy").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const it = state.dictations.find((x) => x.id === Number(btn.dataset.id));
      if (it) { await api("/api/copy", { method: "POST", body: { text: it.cleaned_text } }); toast("Copied to clipboard"); }
    })
  );
  $$(".act-raw").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      if (state.expandedRawIds.has(id)) state.expandedRawIds.delete(id);
      else state.expandedRawIds.add(id);
      renderCanvas();
    })
  );
  $$(".act-del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/dictations/${btn.dataset.id}`, { method: "DELETE" });
      await loadTabData("dictation");
      renderCanvas();
    })
  );
}

/* ==================== NOTETAKER (PHASE 2 NOTE) ==================== */

function renderNotetakerView() {
  return `
    <div class="page-container">
      <div class="page-header">
        <h1 class="page-title">Notetaker <span class="brand-badge" style="vertical-align:middle;margin-left:6px">Phase 2</span></h1>
      </div>
      <div class="hero-banner">
        <h2>Local meeting notes, <em>coming next</em></h2>
        <p>Planned for Phase 2: simultaneous dual-stream PipeWire recording that captures both your microphone and system speaker/call audio locally — zero meeting bots, 100% private.</p>
      </div>
      <div class="cards-grid">
        <div class="card">
          <h4 style="margin:0 0 6px">Dual Audio Capture</h4>
          <p style="margin:0;color:var(--text-secondary);font-size:13px">Captures your mic + PipeWire output monitor sink so both sides of Zoom, Meet, or Discord calls are transcribed cleanly.</p>
        </div>
        <div class="card">
          <h4 style="margin:0 0 6px">Live Transcript &amp; Speakers</h4>
          <p style="margin:0;color:var(--text-secondary);font-size:13px">Real-time CUDA Whisper chunking separating "You" (mic) vs. "Other" (speaker) with timestamps.</p>
        </div>
        <div class="card">
          <h4 style="margin:0 0 6px">Local Ollama Summaries</h4>
          <p style="margin:0;color:var(--text-secondary);font-size:13px">Generates structured call overviews, key decisions, and action items with your local Ollama model.</p>
        </div>
      </div>
    </div>`;
}

/* ==================== INSIGHTS ==================== */

function renderInsightsView() {
  const ins = state.insights || {
    total_words: 0, wpm: 0, total_fixes: 0, words_corrected: 0, dict_fixes: 0,
    total_dictations: 0, avg_stt_ms: 0, avg_llm_ms: 0, current_streak: 0, longest_streak: 0, heatmap: [],
  };
  const pct = Math.min(1, ins.wpm / 160);
  const dashTotal = 188;
  const dashOffset = dashTotal * (1 - pct);
  const maxDay = Math.max(1, ...ins.heatmap.map((h) => h.words));

  const cells = ins.heatmap.map((h) => {
    let cls = "";
    if (h.words > 0) {
      const r = h.words / maxDay;
      cls = r > 0.75 ? "l4" : r > 0.45 ? "l3" : r > 0.2 ? "l2" : "l1";
    }
    return `<div class="heat-cell ${cls}" title="${h.date}: ${h.words} words"></div>`;
  }).join("");

  const avgWords = ins.total_dictations ? Math.round(ins.total_words / ins.total_dictations) : 0;
  const totalPipelineMs = ins.avg_stt_ms + ins.avg_llm_ms;
  const maxBarMs = Math.max(totalPipelineMs, 600);
  const sttPct = ins.avg_stt_ms ? Math.max(10, Math.round((ins.avg_stt_ms / maxBarMs) * 100)) : 0;
  const llmPct = ins.avg_llm_ms ? Math.max(10, Math.round((ins.avg_llm_ms / maxBarMs) * 100)) : 0;
  const totPct = totalPipelineMs ? Math.max(12, Math.round((totalPipelineMs / maxBarMs) * 100)) : 0;

  return `
    <div class="page-container">
      <div class="page-header"><h1 class="page-title">Insights</h1></div>
      <div class="insights-top">
        <div class="card">
          <div class="metric-big">${ins.wpm}</div>
          <div class="metric-caption">Words per minute</div>
          <div class="gauge-wrap">
            <svg width="160" height="88" viewBox="0 0 160 88">
              <path d="M20 78 A60 60 0 0 1 140 78" fill="none" stroke="var(--heat-0)" stroke-width="12" stroke-linecap="round"/>
              <path d="M20 78 A60 60 0 0 1 140 78" fill="none" stroke="var(--accent)" stroke-width="12" stroke-linecap="round"
                stroke-dasharray="${dashTotal}" stroke-dashoffset="${dashOffset.toFixed(1)}"/>
              <text x="80" y="72" text-anchor="middle" fill="var(--text-secondary)" font-size="12" font-weight="600">
                ${ins.wpm > 0 ? "CUDA Live" : "Start dictating"}
              </text>
            </svg>
          </div>
        </div>
        <div class="card">
          <div class="metric-big">${ins.total_fixes.toLocaleString()}</div>
          <div class="metric-caption">Fixes made by VoxBox</div>
          <div class="metric-list">
            <div>${ins.words_corrected.toLocaleString()} AI cleanup ${ins.words_corrected === 1 ? "edit" : "edits"}</div>
            <div>${ins.dict_fixes.toLocaleString()} dictionary &amp; snippet ${ins.dict_fixes === 1 ? "fix" : "fixes"}</div>
          </div>
        </div>
        <div class="card">
          <div class="metric-big">${ins.total_words.toLocaleString()}</div>
          <div class="metric-caption">Total words dictated</div>
          <div class="metric-list">
            <div>${ins.total_dictations.toLocaleString()} total ${ins.total_dictations === 1 ? "session" : "sessions"}</div>
            <div>~${avgWords} words per dictation</div>
          </div>
        </div>
      </div>

      <div class="insights-bottom">
        <div class="card">
          <div class="card-header-row">
            <h3>Local Latency</h3>
            <span class="card-header-sub">100% ON-DEVICE GPU</span>
          </div>
          <div class="bar-row">
            <div class="bar-label">CUDA Whisper</div>
            <div class="bar-track"><div class="bar-fill" style="width:${sttPct}%"></div></div>
            <div class="bar-value">${ins.avg_stt_ms} ms</div>
          </div>
          <div class="bar-row">
            <div class="bar-label">Ollama Cleanup</div>
            <div class="bar-track"><div class="bar-fill" style="width:${llmPct}%"></div></div>
            <div class="bar-value">${ins.avg_llm_ms} ms</div>
          </div>
          <div class="bar-row">
            <div class="bar-label">Total Pipeline</div>
            <div class="bar-track"><div class="bar-fill" style="width:${totPct}%"></div></div>
            <div class="bar-value">${totalPipelineMs} ms</div>
          </div>
        </div>

        <div class="card">
          <div class="card-header-row">
            <h3>${ins.current_streak} ${ins.current_streak === 1 ? "day" : "days"} streak</h3>
            <span class="card-header-sub">LONGEST · ${ins.longest_streak} ${ins.longest_streak === 1 ? "DAY" : "DAYS"}</span>
          </div>
          <div class="heatmap-grid">${cells}</div>
        </div>
      </div>
    </div>`;
}

/* ==================== DICTIONARY ==================== */

function renderDictionaryView() {
  const q = state.searchDict.toLowerCase();
  const filtered = state.dictionary.filter((d) =>
    d.word.toLowerCase().includes(q) || (d.replacement || "").toLowerCase().includes(q)
  );

  const rows = filtered.length
    ? `<div class="list-card">${filtered
        .map(
          (d) => `
        <div class="list-row">
          <div>
            <strong>${esc(d.word)}</strong>
            ${d.replacement ? `<span class="snippet-arrow">→</span><span>${esc(d.replacement)}</span>` : ""}
          </div>
          <button class="btn btn-secondary btn-sm del-dict" data-id="${d.id}">Delete</button>
        </div>`
        )
        .join("")}</div>`
    : `<div class="list-card"><div class="empty-state"><h4>Your dictionary is empty</h4><p>Add custom names, jargon, or spelling corrections — VoxBox passes them to both Whisper and Ollama.</p></div></div>`;

  return `
    <div class="page-container">
      <div class="page-header">
        <h1 class="page-title">Dictionary</h1>
        <div class="page-actions">
          <button class="btn btn-secondary" id="btn-import-dict">Import</button>
          <button class="btn btn-primary" id="btn-add-dict">Add new</button>
        </div>
      </div>
      <div class="hero-banner">
        <h2>VoxBox spells the way <em>you</em> do.</h2>
        <p>Add personal terms, product names, or jargon so they are spelled accurately in every dictation.</p>
        <button class="btn hero-cta" id="btn-hero-dict">Add new word</button>
      </div>
      <div class="search-row">
        <span style="font-size:13px;color:var(--text-secondary)">${filtered.length} term${filtered.length === 1 ? "" : "s"}</span>
        <input class="input search-input" id="dict-search" placeholder="Search dictionary…" value="${esc(state.searchDict)}" />
      </div>
      ${rows}
    </div>`;
}

function bindDictionaryEvents() {
  const openAdd = () =>
    openFormModal(
      "Add dictionary word",
      `
      <div class="field"><label>Word / Preferred Spelling</label><input class="input" id="f-word" placeholder="e.g. Wispr Flow, Arbitrum, onchain" autofocus /></div>
      <div class="field"><label>Optional forced replacement (leave blank to preserve exact spelling)</label><input class="input" id="f-repl" placeholder="e.g. if Whisper hears 'Vis4Flow', put 'Wispr Flow' here" /></div>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-secondary" id="f-cancel">Cancel</button><button class="btn btn-primary" id="f-save">Save</button></div>`,
      async () => {
        const word = $("#f-word").value.trim();
        const replacement = $("#f-repl").value.trim();
        if (!word) return;
        await api("/api/dictionary", { method: "POST", body: { word, replacement } });
        closeFormModal();
        await loadTabData("dictionary");
        renderCanvas();
        toast("Word added");
      }
    );

  $("#btn-add-dict")?.addEventListener("click", openAdd);
  $("#btn-hero-dict")?.addEventListener("click", openAdd);
  $("#btn-import-dict")?.addEventListener("click", () =>
    openFormModal(
      "Import dictionary words",
      `
      <div class="field"><label>One word per line (or <code>heard -> spelling</code>)</label><textarea class="textarea" id="f-bulk" placeholder="Wispr Flow\nArbitrum\nVis4Flow -> Wispr Flow"></textarea></div>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-secondary" id="f-cancel">Cancel</button><button class="btn btn-primary" id="f-save">Import</button></div>`,
      async () => {
        const res = await api("/api/dictionary/import", { method: "POST", body: { text: $("#f-bulk").value } });
        closeFormModal();
        await loadTabData("dictionary");
        renderCanvas();
        toast(`Imported ${res.count} words`);
      }
    )
  );
  $("#dict-search")?.addEventListener("input", (e) => {
    state.searchDict = e.target.value;
    renderCanvas();
    const inp = $("#dict-search");
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  });
  $$(".del-dict").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/dictionary/${b.dataset.id}`, { method: "DELETE" });
      await loadTabData("dictionary");
      renderCanvas();
    })
  );
}

/* ==================== SNIPPETS ==================== */

function renderSnippetsView() {
  const q = state.searchSnippets.toLowerCase();
  const filtered = state.snippets.filter((s) =>
    s.trigger.toLowerCase().includes(q) || s.expansion.toLowerCase().includes(q)
  );

  const rows = filtered.length
    ? `<div class="list-card">${filtered
        .map(
          (s) => `
        <div class="list-row">
          <div style="min-width:0">
            <strong>${esc(s.trigger)}</strong>
            <span class="snippet-arrow">→</span>
            <span style="color:var(--text-secondary)">${esc(s.expansion)}</span>
          </div>
          <button class="btn btn-secondary btn-sm del-snip" data-id="${s.id}">Delete</button>
        </div>`
        )
        .join("")}</div>`
    : `<div class="list-card"><div class="empty-state"><h4>No snippets yet</h4><p>Save emails, links, or reusable prompts — say the trigger phrase to insert the full expansion instantly.</p></div></div>`;

  return `
    <div class="page-container">
      <div class="page-header">
        <h1 class="page-title">Snippets</h1>
        <div class="page-actions">
          <button class="btn btn-secondary" id="btn-import-snip">Import</button>
          <button class="btn btn-primary" id="btn-add-snip">Add new</button>
        </div>
      </div>
      <div class="hero-banner">
        <h2>The stuff <em>you</em> shouldn't have to re-type.</h2>
        <p>Save text you type often — an email, calendar link, or prompt — then speak the trigger phrase to drop it in instantly.</p>
        <button class="btn hero-cta" id="btn-hero-snip">Add new snippet</button>
      </div>
      <div class="search-row">
        <span style="font-size:13px;color:var(--text-secondary)">${filtered.length} snippet${filtered.length === 1 ? "" : "s"}</span>
        <input class="input search-input" id="snip-search" placeholder="Search snippets…" value="${esc(state.searchSnippets)}" />
      </div>
      ${rows}
    </div>`;
}

function bindSnippetsEvents() {
  const openAdd = () =>
    openFormModal(
      "Add snippet",
      `
      <div class="field"><label>Spoken trigger phrase</label><input class="input" id="f-trig" placeholder="e.g. work email" autofocus /></div>
      <div class="field"><label>Expanded text</label><textarea class="textarea" id="f-exp" placeholder="e.g. name@company.com"></textarea></div>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-secondary" id="f-cancel">Cancel</button><button class="btn btn-primary" id="f-save">Save</button></div>`,
      async () => {
        const trigger = $("#f-trig").value.trim();
        const expansion = $("#f-exp").value.trim();
        if (!trigger || !expansion) return;
        await api("/api/snippets", { method: "POST", body: { trigger, expansion } });
        closeFormModal();
        await loadTabData("snippets");
        renderCanvas();
        toast("Snippet saved");
      }
    );

  $("#btn-add-snip")?.addEventListener("click", openAdd);
  $("#btn-hero-snip")?.addEventListener("click", openAdd);
  $("#btn-import-snip")?.addEventListener("click", () =>
    openFormModal(
      "Import snippets",
      `
      <div class="field"><label>One per line as <code>trigger -> expansion</code></label><textarea class="textarea" id="f-bulk" placeholder="my cal link -> https://cal.com/you"></textarea></div>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-secondary" id="f-cancel">Cancel</button><button class="btn btn-primary" id="f-save">Import</button></div>`,
      async () => {
        const res = await api("/api/snippets/import", { method: "POST", body: { text: $("#f-bulk").value } });
        closeFormModal();
        await loadTabData("snippets");
        renderCanvas();
        toast(`Imported ${res.count} snippets`);
      }
    )
  );
  $("#snip-search")?.addEventListener("input", (e) => {
    state.searchSnippets = e.target.value;
    renderCanvas();
    const inp = $("#snip-search");
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  });
  $$(".del-snip").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/snippets/${b.dataset.id}`, { method: "DELETE" });
      await loadTabData("snippets");
      renderCanvas();
    })
  );
}

/* ==================== STYLE ==================== */

function renderStyleView() {
  const cfg = state.appState.config;
  const styles = state.appState.styles || {};
  const labels = {
    default: "Default",
    casual: "Personal messages",
    work: "Work messages",
    email: "Email",
    code: "Code & Prompts",
  };
  const active = cfg.llm.active_style || "default";

  return `
    <div class="page-container">
      <div class="page-header"><h1 class="page-title">Style</h1></div>
      <div class="tab-bar">
        ${Object.entries(labels)
          .map(([k, lbl]) => `<button class="tab-btn style-tab ${k === active ? "active" : ""}" data-style="${k}">${esc(lbl)}</button>`)
          .join("")}
      </div>
      <div class="card" style="margin-bottom:16px">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.06em;color:var(--accent);text-transform:uppercase;margin-bottom:6px">Active Writing Style</div>
        <h3 class="serif-title" style="margin:0 0 8px;font-size:22px">${esc(labels[active] || active)}</h3>
        <p style="margin:0;color:var(--text-secondary)">${esc(styles[active] || "")}</p>
      </div>
      <div class="card">
        <div class="field">
          <label>Custom cleanup instructions (always appended to Ollama's prompt)</label>
          <textarea class="textarea" id="style-custom" placeholder="e.g. Prefer concise sentences, never use em-dashes, format numbered steps cleanly…">${esc(cfg.llm.custom_instructions || "")}</textarea>
        </div>
        <div style="display:flex;justify-content:flex-end">
          <button class="btn btn-primary" id="btn-save-style">Save instructions</button>
        </div>
      </div>
    </div>`;
}

function bindStyleEvents() {
  $$(".style-tab").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api("/api/settings", { method: "POST", body: { llm: { active_style: btn.dataset.style } } });
      await refreshState();
      renderCanvas();
      toast(`Style set to ${btn.textContent}`);
    })
  );
  $("#btn-save-style")?.addEventListener("click", async () => {
    await api("/api/settings", { method: "POST", body: { llm: { custom_instructions: $("#style-custom").value } } });
    await refreshState();
    toast("Custom style instructions saved");
  });
}

/* ==================== TRANSFORMS ==================== */

function renderTransformsView() {
  const cfg = state.appState.config;
  const autoId = cfg.llm.auto_transform_id;
  const opts = state.transforms
    .map((t) => `<option value="${t.id}" ${autoId === t.id ? "selected" : ""}>${esc(t.name)}</option>`)
    .join("");

  const cards = state.transforms
    .map(
      (t) => `
    <div class="transform-card" data-tid="${t.id}">
      <div>
        <h4>${esc(t.name)}</h4>
        <p>${esc(t.description || "Custom local Ollama transform")}</p>
      </div>
      <div style="display:flex;gap:6px;justify-content:space-between;align-items:center">
        <button class="btn btn-secondary btn-sm tr-try" data-id="${t.id}">Try it</button>
        <div style="display:flex;gap:6px">
          <button class="btn btn-secondary btn-sm tr-edit" data-id="${t.id}">Edit</button>
          ${t.is_default ? "" : `<button class="btn btn-secondary btn-sm tr-del" data-id="${t.id}">✕</button>`}
        </div>
      </div>
    </div>`
    )
    .join("");

  return `
    <div class="page-container">
      <div class="page-header">
        <h1 class="page-title">Transforms</h1>
        <div class="page-actions">
          <button class="btn btn-secondary" id="btn-reset-tr">Reset defaults</button>
          <button class="btn btn-primary" id="btn-new-tr">Create New</button>
        </div>
      </div>
      <div class="hero-banner">
        <h2>Transform works anywhere you write</h2>
        <p>Automatically apply a local Ollama rewrite preset after dictation, or test any transform on text below.</p>
      </div>
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px">
        <div>
          <div style="font-weight:600">Auto Apply After Dictation</div>
          <div style="font-size:12.5px;color:var(--text-secondary)">Run the selected transform automatically on every dictation.</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <select class="select" id="tr-auto-select" style="width:180px" ${autoId ? "" : "disabled"}>${opts}</select>
          <label class="switch">
            <input type="checkbox" id="tr-auto-toggle" ${autoId ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>
      </div>
      <h3 class="serif-title" style="font-size:21px;margin:0 0 8px">My Transforms</h3>
      <div class="cards-grid">
        ${cards}
        <div class="transform-card" id="card-create-tr" style="border-style:dashed;align-items:center;justify-content:center;text-align:center">
          <div style="font-size:22px;color:var(--text-muted)">+</div>
          <div>
            <h4>Create your own</h4>
            <p>Write a custom Ollama prompt</p>
          </div>
        </div>
      </div>
    </div>`;
}

function bindTransformsEvents() {
  const saveAuto = async (enabled) => {
    const sel = $("#tr-auto-select");
    const chosen = enabled && sel?.value ? Number(sel.value) : null;
    await api("/api/settings", { method: "POST", body: { llm: { auto_transform_id: chosen } } });
    await refreshState();
    renderCanvas();
  };

  $("#tr-auto-toggle")?.addEventListener("change", (e) => saveAuto(e.target.checked));
  $("#tr-auto-select")?.addEventListener("change", () => saveAuto(true));

  const openEditor = (existing = null) =>
    openFormModal(
      existing ? `Edit ${existing.name}` : "Create Transform",
      `
      <div class="field"><label>Name</label><input class="input" id="f-tname" value="${esc(existing?.name || "")}" placeholder="e.g. Executive Summary" /></div>
      <div class="field"><label>Short description</label><input class="input" id="f-tdesc" value="${esc(existing?.description || "")}" placeholder="What does this transform do?" /></div>
      <div class="field"><label>System prompt</label><textarea class="textarea" id="f-tprompt" style="min-height:130px">${esc(existing?.prompt || "")}</textarea></div>
      <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-secondary" id="f-cancel">Cancel</button><button class="btn btn-primary" id="f-save">Save</button></div>`,
      async () => {
        await api("/api/transforms", {
          method: "POST",
          body: { id: existing?.id ?? null, name: $("#f-tname").value, description: $("#f-tdesc").value, prompt: $("#f-tprompt").value },
        });
        closeFormModal();
        await loadTabData("transforms");
        renderCanvas();
        toast("Transform saved");
      }
    );

  $("#btn-new-tr")?.addEventListener("click", () => openEditor(null));
  $("#card-create-tr")?.addEventListener("click", () => openEditor(null));
  $("#btn-reset-tr")?.addEventListener("click", async () => {
    await api("/api/transforms/reset", { method: "POST" });
    await loadTabData("transforms");
    renderCanvas();
    toast("Default transforms restored");
  });
  $$(".tr-edit").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = state.transforms.find((x) => x.id === Number(b.dataset.id));
      if (t) openEditor(t);
    })
  );
  $$(".tr-del").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/transforms/${b.dataset.id}`, { method: "DELETE" });
      await loadTabData("transforms");
      renderCanvas();
    })
  );
  $$(".tr-try").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = state.transforms.find((x) => x.id === Number(b.dataset.id));
      if (!t) return;
      openFormModal(
        `Try "${t.name}"`,
        `
        <div class="field"><label>Input text (dictate or paste here)</label><textarea class="textarea" id="f-in" placeholder="Hold ${esc(state.appState.hotkey_label)} to dictate directly here…"></textarea></div>
        <div class="field"><label>Result</label><textarea class="textarea" id="f-out" readonly placeholder="Transformed output will appear here…"></textarea></div>
        <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-secondary" id="f-cancel">Close</button><button class="btn btn-primary" id="f-save">Run Transform</button></div>`,
        async () => {
          const btn = $("#f-save");
          btn.disabled = true;
          btn.textContent = "Running…";
          try {
            const res = await api("/api/transforms/run", { method: "POST", body: { transform_id: t.id, text: $("#f-in").value } });
            $("#f-out").value = res.result;
            toast(`Done in ${res.latency_ms}ms`);
          } finally {
            btn.disabled = false;
            btn.textContent = "Run Transform";
          }
        }
      );
    })
  );
}

/* ==================== SCRATCHPAD ==================== */

function renderScratchpadView() {
  if (state.activeNoteId !== null) {
    const note = state.notes.find((n) => n.id === state.activeNoteId);
    if (note) {
      return `
        <div class="page-container">
          <div class="page-header">
            <button class="btn btn-secondary" id="btn-note-back">← All notes</button>
            <div class="page-actions">
              <button class="btn btn-secondary" id="btn-note-pin">${note.pinned ? "Unpin" : "Pin"}</button>
              <button class="btn btn-danger" id="btn-note-del">Delete</button>
              <button class="btn btn-primary" id="btn-note-copy">Copy</button>
            </div>
          </div>
          <div class="note-editor">
            <input class="note-title-input" id="note-title" value="${esc(note.title)}" placeholder="Note title" />
            <textarea class="note-content-input" id="note-content" placeholder="Start typing or hold ${esc(state.appState.hotkey_label)} to dictate directly into this note…">${esc(note.content)}</textarea>
          </div>
        </div>`;
    }
    state.activeNoteId = null;
  }

  const listHtml = state.notes.length
    ? state.notes
        .map(
          (n) => `
      <div class="note-card" data-nid="${n.id}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <strong>${n.pinned ? "📌 " : ""}${esc(n.title)}</strong>
          <span style="font-size:12px;color:var(--text-muted)">${esc(formatDayGroup(n.updated_at))} · ${esc(formatTime(n.updated_at))}</span>
        </div>
        <div style="font-size:13.2px;color:var(--text-secondary);white-space:pre-line;max-height:72px;overflow:hidden">${esc(n.content || "Empty note")}</div>
      </div>`
        )
        .join("")
    : `<div class="list-card"><div class="empty-state"><h4>No scratchpad notes yet</h4><p>Drop a to-do list, polish a message before sending, or brain-dump an idea using voice.</p></div></div>`;

  return `
    <div class="page-container">
      <div class="page-header">
        <h1 class="page-title">Scratchpad</h1>
        <button class="btn btn-primary" id="btn-new-note">Start new note</button>
      </div>
      <div class="hero-banner">
        <h2>For quick thoughts you want to come back to</h2>
        <p>Brain-dump an idea, polish a message before sending, or keep a running voice to-do list — stored 100% locally.</p>
        <button class="btn hero-cta" id="btn-hero-note">Start new note</button>
      </div>
      <div class="search-row">
        <span style="font-weight:600;font-size:13.5px;color:var(--text-secondary)">Recents</span>
        <input class="input search-input" id="note-search" placeholder="Search notes…" value="${esc(state.searchNotes)}" />
      </div>
      ${listHtml}
    </div>`;
}

function bindScratchpadEvents() {
  if (state.activeNoteId !== null) {
    const id = state.activeNoteId;
    let saveTimer = null;
    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const res = await api(`/api/scratchpad/${id}`, {
          method: "PATCH",
          body: { title: $("#note-title").value, content: $("#note-content").value },
        });
        const idx = state.notes.findIndex((n) => n.id === id);
        if (idx >= 0) state.notes[idx] = res.item;
      }, 300);
    };
    $("#note-title")?.addEventListener("input", scheduleSave);
    $("#note-content")?.addEventListener("input", scheduleSave);
    $("#btn-note-back")?.addEventListener("click", async () => {
      clearTimeout(saveTimer);
      await api(`/api/scratchpad/${id}`, {
        method: "PATCH",
        body: { title: $("#note-title").value, content: $("#note-content").value },
      });
      state.activeNoteId = null;
      await loadTabData("scratchpad");
      renderCanvas();
    });
    $("#btn-note-copy")?.addEventListener("click", async () => {
      await api("/api/copy", { method: "POST", body: { text: $("#note-content").value } });
      toast("Note copied to clipboard");
    });
    $("#btn-note-pin")?.addEventListener("click", async () => {
      const note = state.notes.find((n) => n.id === id);
      const res = await api(`/api/scratchpad/${id}`, { method: "PATCH", body: { pinned: !note.pinned } });
      const idx = state.notes.findIndex((n) => n.id === id);
      if (idx >= 0) state.notes[idx] = res.item;
      renderCanvas();
    });
    $("#btn-note-del")?.addEventListener("click", async () => {
      await api(`/api/scratchpad/${id}`, { method: "DELETE" });
      state.activeNoteId = null;
      await loadTabData("scratchpad");
      renderCanvas();
      toast("Note deleted");
    });
    return;
  }

  const createNote = async () => {
    const res = await api("/api/scratchpad", { method: "POST", body: { title: "Untitled note", content: "" } });
    state.notes.unshift(res.item);
    state.activeNoteId = res.item.id;
    renderCanvas();
  };
  $("#btn-new-note")?.addEventListener("click", createNote);
  $("#btn-hero-note")?.addEventListener("click", createNote);
  $$(".note-card").forEach((el) =>
    el.addEventListener("click", () => {
      state.activeNoteId = Number(el.dataset.nid);
      renderCanvas();
    })
  );
  let t = null;
  $("#note-search")?.addEventListener("input", (e) => {
    state.searchNotes = e.target.value;
    clearTimeout(t);
    t = setTimeout(async () => {
      await loadTabData("scratchpad");
      renderCanvas();
    }, 180);
  });
}

/* ==================== SETTINGS MODAL ==================== */

let modelsPollTimer = null;

function stopModelsPolling() {
  if (modelsPollTimer) {
    clearInterval(modelsPollTimer);
    modelsPollTimer = null;
  }
}

async function openSettingsModal(stab = "general") {
  state.settingsTab = stab;
  const [res, llmCat] = await Promise.all([api("/api/system/resources"), api("/api/llm/catalog")]);
  state.resources = res;
  state.llmCatalog = llmCat;
  await refreshState();
  $("#settings-modal").classList.remove("hidden");
  renderSettingsContent();
}

function closeSettingsModal() {
  stopModelsPolling();
  $("#settings-modal").classList.add("hidden");
}

function renderSettingsContent() {
  stopModelsPolling();
  $$(".settings-nav-item").forEach((el) => el.classList.toggle("active", el.dataset.stab === state.settingsTab));
  const titles = {
    general: "General",
    models: "Speech Models",
    llm: "AI Cleanup",
    system: "System",
    notetaker: "Notetaker",
    privacy: "Data & Privacy",
  };
  $("#settings-title").textContent = titles[state.settingsTab] || "Settings";

  const cfg = state.appState.config;
  const res = state.resources || { microphones: [], whisper_models: [], ollama_models: [], autostart: false };
  const el = $("#settings-content");

  if (state.settingsTab === "general") {
    const micOpts = res.microphones
      .map((m) => `<option value="${esc(m.id)}" ${cfg.audio.device === m.id ? "selected" : ""}>${esc(m.name)}</option>`)
      .join("");
    const installedWhisper = (res.whisper_models || []).filter((m) => m.installed);
    const whisperOpts = installedWhisper.length
      ? installedWhisper
          .map((m) => `<option value="${esc(m.id)}" ${m.active ? "selected" : ""}>${esc(m.name)} (${esc(m.size_label)})</option>`)
          .join("")
      : `<option value="">No models downloaded</option>`;
    const langOpts = [
      ["en", "English"],
      ["auto", "Auto-detect"],
      ["hi", "Hindi"],
      ["es", "Spanish"],
      ["fr", "French"],
      ["de", "German"],
    ]
      .map(([v, l]) => `<option value="${v}" ${cfg.stt.language === v ? "selected" : ""}>${l}</option>`)
      .join("");

    el.innerHTML = `
      <div class="setting-group">
        <div class="setting-row">
          <div>
            <div class="setting-title">Hold-to-Talk Shortcut</div>
            <div class="setting-desc">Hold <strong>${esc(state.appState.hotkey_label)}</strong> anywhere to dictate (Esc cancels).</div>
          </div>
          <div class="setting-control">
            <button class="btn btn-secondary" id="set-hotkey">Change</button>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Microphone</div>
            <div class="setting-desc">PipeWire audio source used for recording.</div>
          </div>
          <div class="setting-control">
            <select class="select" id="set-mic">${micOpts}</select>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Speech Model (Whisper)</div>
            <div class="setting-desc">Local GGML model running on whisper-server.</div>
          </div>
          <div class="setting-control" style="gap:8px;min-width:260px">
            <select class="select" id="set-whisper">${whisperOpts}</select>
            <button class="btn btn-secondary btn-sm" id="btn-goto-models" style="white-space:nowrap">More…</button>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Speech Language</div>
            <div class="setting-desc">Whisper transcription language.</div>
          </div>
          <div class="setting-control">
            <select class="select" id="set-lang">${langOpts}</select>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">AI Cleanup</div>
            <div class="setting-desc">Active: <strong>${esc(state.appState.llm_provider_label)}</strong> · <code>${esc(state.appState.llm_active_model)}</code></div>
          </div>
          <div class="setting-control" style="gap:10px;align-items:center">
            <button class="btn btn-secondary btn-sm" id="btn-goto-llm">Configure…</button>
            <label class="switch"><input type="checkbox" id="set-llm-en" ${cfg.llm.enabled ? "checked" : ""}/><span class="slider"></span></label>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Theme</div>
            <div class="setting-desc">Dark mode default with optional warm light theme.</div>
          </div>
          <div class="setting-control">
            <select class="select" id="set-theme">
              <option value="dark" ${cfg.ui.theme !== "light" ? "selected" : ""}>Dark</option>
              <option value="light" ${cfg.ui.theme === "light" ? "selected" : ""}>Light</option>
            </select>
          </div>
        </div>
      </div>`;

    $("#set-hotkey").addEventListener("click", async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = "Press any key…";
      try {
        const r = await api("/api/hotkey/capture", { method: "POST" });
        if (r.key) {
          await refreshState();
          renderSettingsContent();
          toast(`Hotkey set to ${r.label}`);
        } else {
          toast("Hotkey capture cancelled");
          btn.disabled = false;
          btn.textContent = "Change";
        }
      } catch {
        btn.disabled = false;
        btn.textContent = "Change";
      }
    });
    $("#set-mic").addEventListener("change", (e) => saveSetting({ audio: { device: e.target.value } }));
    $("#set-whisper").addEventListener("change", async (e) => {
      if (!e.target.value) return;
      await api("/api/models/select", { method: "POST", body: { id: e.target.value } });
      state.resources = await api("/api/system/resources");
      await refreshState();
      toast("Switching Whisper model…");
    });
    $("#btn-goto-models").addEventListener("click", () => {
      state.settingsTab = "models";
      renderSettingsContent();
    });
    $("#btn-goto-llm").addEventListener("click", () => {
      state.settingsTab = "llm";
      renderSettingsContent();
    });
    $("#set-lang").addEventListener("change", (e) => saveSetting({ stt: { language: e.target.value } }));
    $("#set-llm-en").addEventListener("change", (e) => saveSetting({ llm: { enabled: e.target.checked } }));
    $("#set-theme").addEventListener("change", (e) => saveSetting({ ui: { theme: e.target.value } }));
  } else if (state.settingsTab === "llm") {
    const cat = state.llmCatalog || { ollama: { reachable: false, items: [] }, cloud: {} };
    const provider = cfg.llm.provider || "ollama";
    const providers = [
      ["ollama", "Ollama (Local)"],
      ["gemini", "Gemini"],
      ["claude", "Claude"],
      ["openai", "OpenAI"],
      ["openai_compatible", "OpenAI-Compatible"],
    ];

    let providerBody = "";
    let anyPulling = false;

    if (provider === "ollama") {
      const items = cat.ollama?.items || [];
      anyPulling = items.some((m) => m.pulling);
      providerBody = `
        <div class="setting-group">
          <div class="setting-row">
            <div>
              <div class="setting-title">Ollama Server URL</div>
              <div class="setting-desc">${cat.ollama?.reachable ? "Connected to local Ollama" : "Ollama not reachable at this URL"}</div>
            </div>
            <div class="setting-control" style="min-width:220px">
              <input class="input" id="llm-ollama-url" value="${esc(cfg.llm.base_url)}" />
            </div>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-title">Disable Thinking Tokens (Faster)</div>
              <div class="setting-desc">Recommended for Qwen3 models (~400ms instead of 5–10s).</div>
            </div>
            <label class="switch"><input type="checkbox" id="llm-nothink" ${!cfg.llm.think ? "checked" : ""}/><span class="slider"></span></label>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-title">Pull Custom Ollama Tag</div>
              <div class="setting-desc">Download any model from ollama.com (e.g. <code>mistral:7b</code>).</div>
            </div>
            <div class="setting-control inline-row" style="min-width:250px">
              <input class="input" id="llm-custom-pull" placeholder="e.g. qwen3:4b" />
              <button class="btn btn-secondary btn-sm" id="btn-custom-pull" style="white-space:nowrap">Pull</button>
            </div>
          </div>
        </div>

        <div style="font-size:12px;font-weight:700;letter-spacing:0.06em;color:var(--text-muted);text-transform:uppercase;margin:14px 0 8px">
          Local Ollama Models (by VRAM)
        </div>
        <div class="model-list">
          ${items
            .map((m) => {
              let act = "";
              if (m.pulling) {
                act = `<button class="btn btn-secondary btn-sm ol-cancel" data-m="${esc(m.name)}">Cancel</button>`;
              } else if (m.active) {
                act = `<span class="model-badge active-pill">Active</span>`;
              } else if (m.installed) {
                act = `
                  <button class="btn btn-primary btn-sm ol-use" data-m="${esc(m.name)}">Use</button>
                  <button class="btn btn-secondary btn-sm ol-del" data-m="${esc(m.name)}" title="Delete">✕</button>`;
              } else {
                act = `<button class="btn btn-secondary btn-sm ol-pull" data-m="${esc(m.name)}">Pull</button>`;
              }
              const prog = m.pulling
                ? `<div class="model-progress-wrap">
                     <div class="model-progress-track"><div class="model-progress-fill" style="width:${m.progress}%"></div></div>
                     <span class="model-progress-label">${m.progress}% · ${esc(m.status || "pulling")}</span>
                   </div>`
                : m.error
                ? `<div style="font-size:12px;color:var(--danger)">Pull error: ${esc(m.error)}</div>`
                : "";
              return `
                <div class="model-card ${m.active ? "active" : ""}">
                  <div class="model-card-top">
                    <div>
                      <div class="model-title-row">
                        <span class="model-name">${esc(m.name)}</span>
                        <span class="model-badge rec">${esc(m.vram)}</span>
                        <span class="model-badge">${esc(m.badge)}</span>
                      </div>
                      <div class="model-meta">${esc(m.size_label)} — ${esc(m.description)}</div>
                    </div>
                    <div class="model-actions">${act}</div>
                  </div>
                  ${prog}
                </div>`;
            })
            .join("")}
        </div>`;
    } else if (provider === "gemini" || provider === "claude" || provider === "openai") {
      const keyField = `${provider}_api_key`;
      const modelField = `${provider}_model`;
      const curKey = cfg.llm[keyField] || "";
      const curModel = cfg.llm[modelField] || "";
      const suggested = cat.cloud?.[provider]?.models || [];
      const inList = suggested.some((m) => m.id === curModel);
      const opts = [
        ...suggested.map((m) => `<option value="${esc(m.id)}" ${curModel === m.id ? "selected" : ""}>${esc(m.label)}</option>`),
        `<option value="__custom__" ${!inList ? "selected" : ""}>Custom model ID…</option>`,
      ].join("");

      const keyHints = {
        gemini: "Get a key at aistudio.google.com — stored locally in ~/.config/voxbox/config.toml (chmod 600).",
        claude: "Get a key at console.anthropic.com — stored locally in ~/.config/voxbox/config.toml (chmod 600).",
        openai: "Get a key at platform.openai.com — stored locally in ~/.config/voxbox/config.toml (chmod 600).",
      };

      providerBody = `
        <div class="setting-group">
          <div class="setting-row">
            <div style="flex:1">
              <div class="setting-title">${esc(cat.cloud?.[provider]?.label || provider)} API Key</div>
              <div class="setting-desc">${keyHints[provider]}</div>
              <div class="inline-row" style="margin-top:8px">
                <input type="password" class="input" id="llm-cloud-key" value="${esc(curKey)}" placeholder="Paste API key…" />
                <button class="btn btn-secondary btn-sm" id="btn-toggle-key">Show</button>
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-title">Model</div>
              <div class="setting-desc">Pick a fast recommended model or enter any custom model ID.</div>
            </div>
            <div class="setting-control" style="min-width:250px">
              <select class="select" id="llm-cloud-select">${opts}</select>
            </div>
          </div>
          <div class="setting-row ${inList ? "hidden" : ""}" id="llm-custom-model-row">
            <div>
              <div class="setting-title">Custom Model ID</div>
              <div class="setting-desc">Exact API model identifier.</div>
            </div>
            <div class="setting-control" style="min-width:250px">
              <input class="input" id="llm-cloud-custom" value="${esc(curModel)}" placeholder="Model ID" />
            </div>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">
          <button class="btn btn-primary" id="btn-save-cloud">Save ${esc(cat.cloud?.[provider]?.label || provider)} settings</button>
        </div>`;
    } else {
      const presets = cat.cloud?.openai_compatible?.presets || [];
      providerBody = `
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">Quick presets (click to fill Base URL &amp; suggested model):</div>
        <div class="preset-row">
          ${presets.map((p, idx) => `<button class="preset-chip compat-preset" data-idx="${idx}">${esc(p.name)}</button>`).join("")}
        </div>
        <div class="setting-group">
          <div class="setting-row">
            <div style="flex:1">
              <div class="setting-title">Base URL</div>
              <div class="setting-desc">Any OpenAI-compatible <code>/v1</code> endpoint (Groq, OpenRouter, DeepSeek, vLLM, LM Studio…).</div>
              <input class="input" id="llm-compat-url" style="margin-top:8px" value="${esc(cfg.llm.compat_base_url)}" placeholder="https://api.groq.com/openai/v1" />
            </div>
          </div>
          <div class="setting-row">
            <div style="flex:1">
              <div class="setting-title">API Key</div>
              <div class="setting-desc">Leave blank for unauthenticated local servers (e.g. LM Studio / vLLM).</div>
              <div class="inline-row" style="margin-top:8px">
                <input type="password" class="input" id="llm-compat-key" value="${esc(cfg.llm.compat_api_key)}" placeholder="Paste API key…" />
                <button class="btn btn-secondary btn-sm" id="btn-toggle-key">Show</button>
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div style="flex:1">
              <div class="setting-title">Model ID</div>
              <div class="setting-desc">Exact model string expected by this endpoint.</div>
              <input class="input" id="llm-compat-model" style="margin-top:8px" value="${esc(cfg.llm.compat_model)}" placeholder="e.g. llama-3.3-70b-versatile" />
            </div>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">
          <button class="btn btn-primary" id="btn-save-compat">Save provider settings</button>
        </div>`;
    }

    el.innerHTML = `
      <div class="setting-group">
        <div class="setting-row">
          <div>
            <div class="setting-title">Enable AI Cleanup</div>
            <div class="setting-desc">Remove filler words, fix self-corrections &amp; punctuation after Whisper transcribes.</div>
          </div>
          <label class="switch"><input type="checkbox" id="llm-master-en" ${cfg.llm.enabled ? "checked" : ""}/><span class="slider"></span></label>
        </div>
      </div>

      <div class="provider-pills">
        ${providers.map(([k, lbl]) => `<button class="provider-pill ${provider === k ? "active" : ""}" data-prov="${k}">${esc(lbl)}</button>`).join("")}
      </div>

      ${providerBody}

      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px">
        <span style="font-size:12.5px;color:var(--text-secondary)">Verify your active provider &amp; measure latency:</span>
        <button class="btn btn-secondary" id="btn-test-llm">Test Cleanup</button>
      </div>
      <div class="test-result hidden" id="llm-test-out"></div>`;

    $("#llm-master-en").addEventListener("change", (e) => saveSetting({ llm: { enabled: e.target.checked } }));
    $$(".provider-pill").forEach((b) =>
      b.addEventListener("click", async () => {
        await api("/api/settings", { method: "POST", body: { llm: { provider: b.dataset.prov } } });
        state.llmCatalog = await api("/api/llm/catalog");
        await refreshState();
        renderSettingsContent();
      })
    );

    $("#btn-toggle-key")?.addEventListener("click", (e) => {
      const inp = $("#llm-cloud-key") || $("#llm-compat-key");
      if (!inp) return;
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      e.target.textContent = show ? "Hide" : "Show";
    });

    if (provider === "ollama") {
      $("#llm-ollama-url")?.addEventListener("change", async (e) => {
        await saveSetting({ llm: { base_url: e.target.value.trim() } });
        state.llmCatalog = await api("/api/llm/catalog");
        renderSettingsContent();
      });
      $("#llm-nothink")?.addEventListener("change", (e) => saveSetting({ llm: { think: !e.target.checked } }));
      $("#btn-custom-pull")?.addEventListener("click", async () => {
        const tag = $("#llm-custom-pull").value.trim();
        if (!tag) return;
        await api("/api/llm/ollama/pull", { method: "POST", body: { model: tag } });
        state.llmCatalog = await api("/api/llm/catalog");
        renderSettingsContent();
        toast(`Pulling ${tag}…`);
      });
      $$(".ol-use").forEach((b) =>
        b.addEventListener("click", async () => {
          await api("/api/settings", { method: "POST", body: { llm: { provider: "ollama", model: b.dataset.m } } });
          state.llmCatalog = await api("/api/llm/catalog");
          await refreshState();
          renderSettingsContent();
          toast(`Switched to ${b.dataset.m}`);
        })
      );
      $$(".ol-pull").forEach((b) =>
        b.addEventListener("click", async () => {
          await api("/api/llm/ollama/pull", { method: "POST", body: { model: b.dataset.m } });
          state.llmCatalog = await api("/api/llm/catalog");
          renderSettingsContent();
          toast(`Pulling ${b.dataset.m}…`);
        })
      );
      $$(".ol-cancel").forEach((b) =>
        b.addEventListener("click", async () => {
          await api("/api/llm/ollama/cancel", { method: "POST", body: { model: b.dataset.m } });
          state.llmCatalog = await api("/api/llm/catalog");
          renderSettingsContent();
          toast("Pull cancelled");
        })
      );
      $$(".ol-del").forEach((b) =>
        b.addEventListener("click", async () => {
          try {
            await api(`/api/llm/ollama/${encodeURIComponent(b.dataset.m)}`, { method: "DELETE" });
            state.llmCatalog = await api("/api/llm/catalog");
            renderSettingsContent();
            toast(`Deleted ${b.dataset.m}`);
          } catch (err) {
            toast(err.message);
          }
        })
      );

      if (anyPulling) {
        modelsPollTimer = setInterval(async () => {
          try {
            state.llmCatalog = await api("/api/llm/catalog");
            if (state.settingsTab === "llm" && !$("#settings-modal").classList.contains("hidden")) {
              renderSettingsContent();
            } else {
              stopModelsPolling();
            }
          } catch {
            stopModelsPolling();
          }
        }, 700);
      }
    } else if (provider === "gemini" || provider === "claude" || provider === "openai") {
      $("#llm-cloud-select")?.addEventListener("change", (e) => {
        const isCustom = e.target.value === "__custom__";
        $("#llm-custom-model-row").classList.toggle("hidden", !isCustom);
        if (!isCustom) $("#llm-cloud-custom").value = e.target.value;
      });
      $("#btn-save-cloud")?.addEventListener("click", async () => {
        const selVal = $("#llm-cloud-select").value;
        const chosenModel = selVal === "__custom__" ? $("#llm-cloud-custom").value.trim() : selVal;
        const keyVal = $("#llm-cloud-key").value.trim();
        await saveSetting({ llm: { provider, [`${provider}_api_key`]: keyVal, [`${provider}_model`]: chosenModel } });
      });
    } else {
      const presets = cat.cloud?.openai_compatible?.presets || [];
      $$(".compat-preset").forEach((b) =>
        b.addEventListener("click", () => {
          const p = presets[Number(b.dataset.idx)];
          if (!p) return;
          $("#llm-compat-url").value = p.base_url;
          $("#llm-compat-model").value = p.model;
          toast(`Loaded ${p.name} preset — paste your API key and Save`);
        })
      );
      $("#btn-save-compat")?.addEventListener("click", async () => {
        await saveSetting({
          llm: {
            provider: "openai_compatible",
            compat_base_url: $("#llm-compat-url").value.trim(),
            compat_api_key: $("#llm-compat-key").value.trim(),
            compat_model: $("#llm-compat-model").value.trim(),
          },
        });
      });
    }

    $("#btn-test-llm").addEventListener("click", async (e) => {
      const btn = e.target;
      const box = $("#llm-test-out");
      btn.disabled = true;
      btn.textContent = "Testing…";
      box.className = "test-result";
      box.textContent = "Running sample cleanup…";
      box.classList.remove("hidden");
      try {
        const r = await api("/api/llm/test", { method: "POST" });
        box.className = "test-result ok";
        box.innerHTML = `<strong>✓ ${esc(r.provider)} · ${esc(r.model)} (${r.latency_ms} ms)</strong><div style="margin-top:4px;color:var(--text-primary)">${esc(r.result)}</div>`;
      } catch (err) {
        box.className = "test-result err";
        box.textContent = `✗ ${err.message}`;
      } finally {
        btn.disabled = false;
        btn.textContent = "Test Cleanup";
      }
    });
  } else if (state.settingsTab === "models") {
    const models = res.whisper_models || [];
    const anyDownloading = models.some((m) => m.downloading);

    el.innerHTML = `
      <p style="margin:0 0 14px;font-size:13px;color:var(--text-secondary)">
        Download and switch between local Whisper GGML models. Smaller models run fast on CPU; Turbo and Large v3 shine on GPU.
      </p>
      <div class="model-list">
        ${models
          .map((m) => {
            let actionHtml = "";
            if (m.downloading) {
              actionHtml = `<button class="btn btn-secondary btn-sm mdl-cancel" data-id="${esc(m.id)}">Cancel</button>`;
            } else if (m.active) {
              actionHtml = `<span class="model-badge active-pill">Active</span>`;
            } else if (m.installed) {
              actionHtml = `
                <button class="btn btn-primary btn-sm mdl-use" data-id="${esc(m.id)}">Use</button>
                <button class="btn btn-secondary btn-sm mdl-del" data-id="${esc(m.id)}" title="Delete model">✕</button>`;
            } else {
              actionHtml = `<button class="btn btn-secondary btn-sm mdl-dl" data-id="${esc(m.id)}">Download</button>`;
            }

            const progressHtml = m.downloading
              ? `<div class="model-progress-wrap">
                   <div class="model-progress-track"><div class="model-progress-fill" style="width:${m.progress}%"></div></div>
                   <span class="model-progress-label">${m.progress}% · ${m.downloaded_mb} / ${m.total_mb} MB</span>
                 </div>`
              : m.error
              ? `<div style="font-size:12px;color:var(--danger)">Download error: ${esc(m.error)}</div>`
              : "";

            return `
              <div class="model-card ${m.active ? "active" : ""}">
                <div class="model-card-top">
                  <div>
                    <div class="model-title-row">
                      <span class="model-name">${esc(m.name)}</span>
                      <span class="model-badge ${m.recommended ? "rec" : ""}">${esc(m.badge)}</span>
                    </div>
                    <div class="model-meta">${esc(m.size_label)} · ${esc(m.languages)} — ${esc(m.description)}</div>
                  </div>
                  <div class="model-actions">${actionHtml}</div>
                </div>
                ${progressHtml}
              </div>`;
          })
          .join("")}
      </div>`;

    $$(".mdl-dl").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api("/api/models/download", { method: "POST", body: { id: b.dataset.id } });
          state.resources = await api("/api/system/resources");
          renderSettingsContent();
          toast("Download started");
        } catch (err) {
          toast(err.message);
        }
      })
    );
    $$(".mdl-cancel").forEach((b) =>
      b.addEventListener("click", async () => {
        await api("/api/models/cancel", { method: "POST", body: { id: b.dataset.id } });
        state.resources = await api("/api/system/resources");
        renderSettingsContent();
        toast("Download cancelled");
      })
    );
    $$(".mdl-use").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api("/api/models/select", { method: "POST", body: { id: b.dataset.id } });
          state.resources = await api("/api/system/resources");
          await refreshState();
          renderSettingsContent();
          toast("Switching Whisper model…");
        } catch (err) {
          toast(err.message);
        }
      })
    );
    $$(".mdl-del").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api(`/api/models/${encodeURIComponent(b.dataset.id)}`, { method: "DELETE" });
          state.resources = await api("/api/system/resources");
          renderSettingsContent();
          toast("Model deleted");
        } catch (err) {
          toast(err.message);
        }
      })
    );

    if (anyDownloading) {
      modelsPollTimer = setInterval(async () => {
        try {
          const data = await api("/api/models");
          if (state.resources) state.resources.whisper_models = data.items;
          if (state.settingsTab === "models" && !$("#settings-modal").classList.contains("hidden")) {
            renderSettingsContent();
          } else {
            stopModelsPolling();
          }
        } catch {
          stopModelsPolling();
        }
      }, 600);
    }
  } else if (state.settingsTab === "system") {
    const pasteOpts = [
      ["shift_insert", "Shift + Insert (GUI & Terminals)"],
      ["ctrl_v", "Ctrl + V (GUI apps)"],
      ["ctrl_shift_v", "Ctrl + Shift + V (Terminals)"],
      ["type", "ydotool direct typing"],
      ["clipboard_only", "Clipboard only"],
    ]
      .map(([v, l]) => `<option value="${v}" ${cfg.paste.mode === v ? "selected" : ""}>${l}</option>`)
      .join("");

    el.innerHTML = `
      <div class="setting-group">
        <div class="setting-row">
          <div>
            <div class="setting-title">Launch VoxBox at login</div>
            <div class="setting-desc">Controls <code>voxbox.service</code> in systemd user session.</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-autostart" ${res.autostart ? "checked" : ""}/><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Show Floating Bar at all times</div>
            <div class="setting-desc">Keep the thin translucent bar anchored at bottom-center when idle.</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-bar" ${cfg.ui.show_flow_bar ? "checked" : ""}/><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Dictation sounds</div>
            <div class="setting-desc">Play subtle start, stop, and cancel audio chimes.</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-sounds" ${cfg.audio.sound_effects ? "checked" : ""}/><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Mute system audio while dictating</div>
            <div class="setting-desc">Temporarily mutes speakers via PipeWire while you hold the hotkey.</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-mute" ${cfg.audio.mute_while_dictating ? "checked" : ""}/><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Paste method</div>
            <div class="setting-desc">How VoxBox injects cleaned text into your focused window.</div>
          </div>
          <div class="setting-control"><select class="select" id="set-paste">${pasteOpts}</select></div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Append trailing space</div>
            <div class="setting-desc">Useful for continuous sentence-by-sentence dictation.</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-space" ${cfg.paste.trailing_space ? "checked" : ""}/><span class="slider"></span></label>
        </div>
      </div>`;

    $("#set-autostart").addEventListener("change", async (e) => {
      await api("/api/system/autostart", { method: "POST", body: { enabled: e.target.checked } });
      toast(e.target.checked ? "Autostart enabled" : "Autostart disabled");
    });
    $("#set-bar").addEventListener("change", (e) => saveSetting({ ui: { show_flow_bar: e.target.checked } }));
    $("#set-sounds").addEventListener("change", (e) => saveSetting({ audio: { sound_effects: e.target.checked } }));
    $("#set-mute").addEventListener("change", (e) => saveSetting({ audio: { mute_while_dictating: e.target.checked } }));
    $("#set-paste").addEventListener("change", (e) => saveSetting({ paste: { mode: e.target.value } }));
    $("#set-space").addEventListener("change", (e) => saveSetting({ paste: { trailing_space: e.target.checked } }));
  } else if (state.settingsTab === "notetaker") {
    el.innerHTML = `
      <div class="setting-group">
        <div class="setting-row">
          <div>
            <div class="setting-title">Meeting Notetaker (Phase 2)</div>
            <div class="setting-desc">Will capture both your microphone and PipeWire system audio monitor for calls, transcribe locally on CUDA, and summarize via Ollama.</div>
          </div>
          <span class="brand-badge">Planned</span>
        </div>
      </div>`;
  } else {
    const paths = state.appState.paths;
    el.innerHTML = `
      <div class="setting-group">
        <div class="setting-row">
          <div>
            <div class="setting-title">100% Local &amp; Offline</div>
            <div class="setting-desc">Audio never leaves your machine. Everything runs on your GPU via local whisper-server and Ollama.</div>
          </div>
          <span class="brand-badge">Offline</span>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Config Folder</div>
            <div class="setting-desc"><code>${esc(paths.config)}</code></div>
          </div>
          <button class="btn btn-secondary btn-sm" id="btn-open-cfg-dir">Open</button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Data &amp; Logs Folder</div>
            <div class="setting-desc"><code>${esc(paths.data)}</code></div>
          </div>
          <button class="btn btn-secondary btn-sm" id="btn-open-data-dir">Open</button>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-title">Clear Dictation History</div>
            <div class="setting-desc">Deletes all saved dictation history from SQLite (keeps Dictionary, Snippets &amp; Scratchpad).</div>
          </div>
          <button class="btn btn-danger btn-sm" id="btn-clear-hist">Clear History</button>
        </div>
      </div>`;

    $("#btn-open-cfg-dir").addEventListener("click", () => api("/api/system/open-folder", { method: "POST", body: { kind: "config" } }));
    $("#btn-open-data-dir").addEventListener("click", () => api("/api/system/open-folder", { method: "POST", body: { kind: "data" } }));
    $("#btn-clear-hist").addEventListener("click", async () => {
      await api("/api/dictations/clear", { method: "POST" });
      await loadTabData(state.tab);
      renderCanvas();
      toast("History cleared");
    });
  }
}

async function saveSetting(patch) {
  await api("/api/settings", { method: "POST", body: patch });
  await refreshState();
  renderCanvas();
  toast("Saved");
}

/* ==================== FORM MODAL ==================== */

function openFormModal(title, bodyHtml, onSave) {
  $("#form-modal-title").textContent = title;
  $("#form-modal-body").innerHTML = bodyHtml;
  $("#form-modal").classList.remove("hidden");
  $("#f-cancel")?.addEventListener("click", closeFormModal);
  $("#f-save")?.addEventListener("click", () => onSave().catch((e) => toast(e.message)));
}

function closeFormModal() {
  $("#form-modal").classList.add("hidden");
}

/* ==================== BOOTSTRAP ==================== */

async function init() {
  $$("#sidebar-nav .nav-item").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
  $("#btn-open-settings").addEventListener("click", () => openSettingsModal("general"));
  $("#btn-topbar-settings").addEventListener("click", () => openSettingsModal("general"));
  $("#btn-close-settings").addEventListener("click", closeSettingsModal);
  $("#btn-close-form").addEventListener("click", closeFormModal);
  $("#settings-modal").addEventListener("click", (e) => { if (e.target === $("#settings-modal")) closeSettingsModal(); });
  $("#form-modal").addEventListener("click", (e) => { if (e.target === $("#form-modal")) closeFormModal(); });
  $$(".settings-nav-item").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.settingsTab = btn.dataset.stab;
      renderSettingsContent();
    })
  );

  $("#btn-theme-toggle").addEventListener("click", async () => {
    const next = state.appState?.config?.ui?.theme === "light" ? "dark" : "light";
    await saveSetting({ ui: { theme: next } });
  });

  $("#btn-dictate-now").addEventListener("click", async () => {
    await api("/api/dictate/toggle", { method: "POST" });
    await refreshState();
  });

  await refreshState();
  const params = new URLSearchParams(window.location.search);
  const initialTab = params.get("tab") || "dictation";
  await switchTab(initialTab);

  // Light periodic refresh so new dictations & live engine status appear automatically.
  setInterval(async () => {
    try {
      const prevState = state.appState?.state;
      await refreshState();
      if (prevState === "processing" && state.appState.state === "idle" && (state.tab === "dictation" || state.tab === "insights")) {
        await loadTabData(state.tab);
        renderCanvas();
      }
    } catch {}
  }, 1500);
}

init().catch((err) => {
  console.error(err);
  $("#main-canvas").innerHTML = `<div class="empty-state"><h4>Could not connect to VoxBox daemon</h4><p>${esc(err.message)}</p></div>`;
});
