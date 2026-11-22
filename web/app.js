/* VoxBox Hub — Apple Human Interface Frontend */

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
  llmCatalog: null,
  activeNoteId: null,
  editingDictationId: null,
  expandedRawIds: new Set(),
  searchDictation: "",
  searchDict: "",
  searchSnippets: "",
  searchNotes: "",
  recStartedAt: null,
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

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatDayGroup(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startToday - startDay) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatElapsed(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ==================== LIVE STATE & TOOLBAR ==================== */

function updateLiveControls() {
  if (!state.appState) return;
  const cfg = state.appState.config;
  const st = state.appState.state || "idle";
  const hk = state.appState.hotkey_label || "Right Ctrl";

  const dot = $("#status-dot");
  dot.className = `status-dot ${st}`;
  $("#status-text").textContent =
    st === "recording" ? "Recording" : st === "processing" ? "Transcribing" : st === "error" ? "Error" : "Ready";
  const llmText = cfg.llm.enabled
    ? `${state.appState.llm_provider_label} · ${state.appState.llm_active_model}`
    : "Raw Whisper";
  $("#status-sub").textContent = llmText;

  const recBtn = $("#btn-dictate-now");
  const recLabel = $("#record-label");
  const recKbd = $("#record-kbd");

  recBtn.classList.toggle("is-recording", st === "recording");
  recBtn.classList.toggle("is-processing", st === "processing");

  if (st === "recording") {
    if (!state.recStartedAt) state.recStartedAt = Date.now();
    const sec = (Date.now() - state.recStartedAt) / 1000;
    recLabel.textContent = "Stop";
    recKbd.textContent = formatElapsed(sec);
  } else if (st === "processing") {
    state.recStartedAt = null;
    recLabel.textContent = "Polishing…";
    recKbd.textContent = "GPU";
  } else {
    state.recStartedAt = null;
    recLabel.textContent = "Dictate";
    recKbd.textContent = hk;
  }
}

async function refreshState() {
  state.appState = await api("/api/state");
  applyTheme(state.appState.config.ui.theme || "dark");
  updateLiveControls();
}

async function loadTabData(tab) {
  if (tab === "dictation") {
    const [d, ins, tr] = await Promise.all([
      api(`/api/dictations?q=${encodeURIComponent(state.searchDictation)}`),
      api("/api/insights"),
      api("/api/transforms"),
    ]);
    state.dictations = d.items;
    state.insights = ins;
    state.transforms = tr.items;
  } else if (tab === "insights") {
    state.insights = await api("/api/insights");
  } else if (tab === "dictionary") {
    state.dictionary = (await api("/api/dictionary")).items;
  } else if (tab === "snippets") {
    state.snippets = (await api("/api/snippets")).items;
  } else if (tab === "transforms") {
    state.transforms = (await api("/api/transforms")).items;
  } else if (tab === "scratchpad") {
    const [notesRes, trRes] = await Promise.all([
      api(`/api/scratchpad?q=${encodeURIComponent(state.searchNotes)}`),
      api("/api/transforms"),
    ]);
    state.notes = notesRes.items;
    state.transforms = trRes.items;
    if (state.activeNoteId === null && state.notes.length > 0) {
      state.activeNoteId = state.notes[0].id;
    }
  }
}

async function switchTab(tab) {
  if (tab === "settings") {
    await openSettingsModal("general");
    return;
  }
  state.tab = tab;
  state.editingDictationId = null;
  $$("#sidebar-nav .nav-item").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  await loadTabData(tab);
  renderCurrentView();
}

function setToolbar(title, subtitle = "", extraHtml = "") {
  $("#toolbar-title").textContent = title;
  $("#toolbar-subtitle").textContent = subtitle;
  $("#toolbar-extra").innerHTML = extraHtml;
}

function renderCurrentView() {
  const root = $("#main-canvas");
  root.classList.toggle("flush", state.tab === "scratchpad");

  switch (state.tab) {
    case "dictation":
      renderDictationView(root);
      break;
    case "scratchpad":
      renderScratchpadView(root);
      break;
    case "notetaker":
      renderNotetakerView(root);
      break;
    case "dictionary":
      renderDictionaryView(root);
      break;
    case "snippets":
      renderSnippetsView(root);
      break;
    case "style":
      renderStyleView(root);
      break;
    case "transforms":
      renderTransformsView(root);
      break;
    case "insights":
      renderInsightsView(root);
      break;
  }
}

/* ==================== 1. DICTATION ==================== */

function renderDictationView(root) {
  const ins = state.insights || { total_words: 0, wpm: 0, current_streak: 0, avg_stt_ms: 0, avg_llm_ms: 0 };
  const st = state.appState.state || "idle";
  const countLbl = state.dictations.length
    ? `${state.dictations.length} ${state.dictations.length === 1 ? "entry" : "entries"}`
    : "";

  setToolbar(
    "Dictation",
    countLbl,
    `<div class="search-field">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
       <input class="input" id="dictation-search" placeholder="Search" value="${esc(state.searchDictation)}" />
     </div>`
  );

  let liveBanner = "";
  if (st === "recording") {
    liveBanner = `
      <div class="live-banner">
        <div class="live-banner-left">
          <span class="status-dot recording"></span>
          <span>Listening to microphone… Release <strong>${esc(state.appState.hotkey_label)}</strong> when finished, or press Esc to cancel.</span>
        </div>
        <button class="btn btn-sm btn-danger" id="btn-banner-stop">Stop</button>
      </div>`;
  } else if (st === "processing") {
    liveBanner = `
      <div class="live-banner processing">
        <div class="live-banner-left">
          <span class="status-dot processing"></span>
          <span>Transcribing on GPU and polishing text…</span>
        </div>
      </div>`;
  }

  const groups = new Map();
  for (const item of state.dictations) {
    const g = formatDayGroup(item.created_at);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(item);
  }

  let feedHtml = "";
  if (state.dictations.length === 0) {
    feedHtml = `
      <div class="inset-group">
        <div class="empty-state">
          <h4>${state.searchDictation ? "No matching transcripts" : "Ready to transcribe"}</h4>
          <p>${
            state.searchDictation
              ? "Try a different search term."
              : `Hold <strong>${esc(state.appState.hotkey_label)}</strong> anywhere on your desktop—or click <strong>Dictate</strong> above—to speak and paste cleaned text automatically.`
          }</p>
        </div>
      </div>`;
  } else {
    for (const [label, items] of groups.entries()) {
      feedHtml += `<div class="date-section-label">${esc(label)}</div><div class="inset-group">`;
      for (const it of items) {
        const showRaw = state.expandedRawIds.has(it.id);
        const editing = state.editingDictationId === it.id;
        feedHtml += `
          <article class="transcript-row ${editing ? "is-editing" : ""}">
            <div class="transcript-time">${esc(formatTime(it.created_at))}</div>
            <div class="transcript-body">
              ${
                editing
                  ? `<textarea class="transcript-editor" id="edit-ta-${it.id}">${esc(it.cleaned_text)}</textarea>`
                  : `<div class="transcript-text">${esc(it.cleaned_text)}</div>`
              }
              ${
                showRaw
                  ? `<div class="transcript-raw"><div class="transcript-raw-label">Raw Speech Recognition</div>${esc(it.raw_text)}</div>`
                  : ""
              }
              <div class="transcript-footer">
                <div class="transcript-meta">
                  <span>${it.word_count} ${it.word_count === 1 ? "word" : "words"}</span>
                  <span>·</span>
                  <span>STT ${it.stt_ms} ms</span>
                  ${it.llm_ms ? `<span>·</span><span>AI ${it.llm_ms} ms</span>` : ""}
                  ${it.transform_name ? `<span>·</span><span>${esc(it.transform_name)}</span>` : ""}
                </div>
                <div class="transcript-actions">
                  ${
                    editing
                      ? `<button class="btn btn-ghost btn-sm act-edit-cancel" data-id="${it.id}">Cancel</button>
                         <button class="btn btn-primary btn-sm act-edit-save" data-id="${it.id}">Save</button>`
                      : `<button class="action-chip act-copy" data-id="${it.id}">Copy</button>
                         <button class="action-chip act-edit" data-id="${it.id}">Edit</button>
                         <button class="action-chip act-raw" data-id="${it.id}">${showRaw ? "Hide Raw" : "Raw"}</button>
                         <button class="action-chip act-export" data-id="${it.id}">Export</button>
                         <button class="action-chip danger act-del" data-id="${it.id}">Delete</button>`
                  }
                </div>
              </div>
            </div>
          </article>`;
      }
      feedHtml += `</div>`;
    }
  }

  root.innerHTML = `
    <div class="page">
      ${liveBanner}
      <div class="whisper-metrics">
        <div class="whisper-metrics-group">
          <span class="whisper-metric"><strong>${fmtWords(ins.total_words)}</strong> words</span>
          <span class="whisper-metric"><strong>${ins.wpm}</strong> wpm</span>
          <span class="whisper-metric"><strong>${ins.current_streak}</strong> ${ins.current_streak === 1 ? "day" : "days"} streak</span>
        </div>
        <div class="whisper-metrics-group">
          <span class="whisper-metric">CUDA ${ins.avg_stt_ms || 0} ms</span>
          <span class="whisper-metric">${esc(state.appState.llm_provider_label)} ${ins.avg_llm_ms || 0} ms</span>
        </div>
      </div>
      ${feedHtml}
    </div>`;

  // Bind events
  let searchTimer = null;
  $("#dictation-search")?.addEventListener("input", (e) => {
    state.searchDictation = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      await loadTabData("dictation");
      renderCurrentView();
      const inp = $("#dictation-search");
      if (inp) {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }, 160);
  });

  $("#btn-banner-stop")?.addEventListener("click", async () => {
    await api("/api/dictate/toggle", { method: "POST" });
    await refreshState();
    renderCurrentView();
  });

  $$(".act-copy").forEach((b) =>
    b.addEventListener("click", async () => {
      const it = state.dictations.find((x) => x.id === Number(b.dataset.id));
      if (it) {
        await api("/api/copy", { method: "POST", body: { text: it.cleaned_text } });
        toast("Copied to clipboard");
      }
    })
  );

  $$(".act-edit").forEach((b) =>
    b.addEventListener("click", () => {
      state.editingDictationId = Number(b.dataset.id);
      renderCurrentView();
      const ta = $(`#edit-ta-${state.editingDictationId}`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    })
  );

  $$(".act-edit-cancel").forEach((b) =>
    b.addEventListener("click", () => {
      state.editingDictationId = null;
      renderCurrentView();
    })
  );

  $$(".act-edit-save").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = Number(b.dataset.id);
      const ta = $(`#edit-ta-${id}`);
      if (!ta) return;
      await api(`/api/dictations/${id}`, { method: "PATCH", body: { cleaned_text: ta.value } });
      state.editingDictationId = null;
      await loadTabData("dictation");
      renderCurrentView();
      toast("Transcript updated");
    })
  );

  $$(".act-raw").forEach((b) =>
    b.addEventListener("click", () => {
      const id = Number(b.dataset.id);
      if (state.expandedRawIds.has(id)) state.expandedRawIds.delete(id);
      else state.expandedRawIds.add(id);
      renderCurrentView();
    })
  );

  $$(".act-export").forEach((b) =>
    b.addEventListener("click", () => {
      const it = state.dictations.find((x) => x.id === Number(b.dataset.id));
      if (!it) return;
      const stamp = new Date(it.created_at * 1000).toISOString().slice(0, 16).replace(/[:T]/g, "-");
      downloadTextFile(`voxbox-transcript-${stamp}.txt`, it.cleaned_text + "\n");
      toast("Exported transcript");
    })
  );

  $$(".act-del").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/dictations/${b.dataset.id}`, { method: "DELETE" });
      await loadTabData("dictation");
      renderCurrentView();
      toast("Deleted");
    })
  );
}

/* ==================== 2. SCRATCHPAD (macOS NOTES SPLIT) ==================== */

function renderScratchpadView(root) {
  setToolbar(
    "Scratchpad",
    state.notes.length ? `${state.notes.length} ${state.notes.length === 1 ? "note" : "notes"}` : "",
    `<button class="btn btn-secondary btn-sm" id="btn-new-note">New Note</button>`
  );

  const activeNote = state.notes.find((n) => n.id === state.activeNoteId) || null;
  const listHtml = state.notes.length
    ? state.notes
        .map((n) => {
          const preview = (n.content || "").replace(/\s+/g, " ").trim() || "No additional text";
          return `
            <button class="note-list-item ${activeNote && n.id === activeNote.id ? "active" : ""}" data-nid="${n.id}">
              <div class="note-list-title">${n.pinned ? "★ " : ""}${esc(n.title)}</div>
              <div class="note-list-meta">
                <span>${esc(formatTime(n.updated_at))}</span>
                <span class="note-list-preview">${esc(preview)}</span>
              </div>
            </button>`;
        })
        .join("")
    : `<div class="empty-state" style="padding:36px 16px"><p>No notes yet</p></div>`;

  const wordCount = activeNote && activeNote.content.trim() ? activeNote.content.trim().split(/\s+/).length : 0;

  const editorHtml = activeNote
    ? `
      <div class="notes-editor-bar">
        <span class="notes-editor-status" id="note-save-status">${wordCount} ${wordCount === 1 ? "word" : "words"} · Saved locally</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn btn-ghost btn-sm" id="btn-note-pin">${activeNote.pinned ? "Unpin" : "Pin"}</button>
          <button class="btn btn-ghost btn-sm" id="btn-note-export">Export</button>
          <button class="btn btn-ghost btn-sm" id="btn-note-copy">Copy</button>
          <button class="btn btn-ghost btn-sm" id="btn-note-del" style="color:var(--danger)">Delete</button>
        </div>
      </div>
      <div class="notes-editor-body">
        <input class="note-title-input" id="note-title" value="${esc(activeNote.title)}" placeholder="Title" />
        <textarea class="note-content-input" id="note-content" placeholder="Type or hold ${esc(state.appState.hotkey_label)} to dictate directly into this note…">${esc(activeNote.content)}</textarea>
      </div>`
    : `
      <div class="empty-state" style="margin:auto">
        <h4>Scratchpad</h4>
        <p>Keep quick voice notes, drafts, or prompts locally. Create a note to begin.</p>
        <div style="margin-top:16px"><button class="btn btn-primary" id="btn-empty-new-note">Create Note</button></div>
      </div>`;

  root.innerHTML = `
    <div class="notes-split">
      <div class="notes-list-pane">
        <div class="notes-list-header">
          <div class="search-field" style="width:100%">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
            <input class="input" id="note-search" style="width:100%" placeholder="Search notes" value="${esc(state.searchNotes)}" />
          </div>
        </div>
        <div class="notes-list-scroll">${listHtml}</div>
      </div>
      <div class="notes-editor-pane">${editorHtml}</div>
    </div>`;

  const createNote = async () => {
    const res = await api("/api/scratchpad", { method: "POST", body: { title: "Untitled", content: "" } });
    state.notes.unshift(res.item);
    state.activeNoteId = res.item.id;
    renderCurrentView();
    $("#note-title")?.select();
  };

  $("#btn-new-note")?.addEventListener("click", createNote);
  $("#btn-empty-new-note")?.addEventListener("click", createNote);

  let stimer = null;
  $("#note-search")?.addEventListener("input", (e) => {
    state.searchNotes = e.target.value;
    clearTimeout(stimer);
    stimer = setTimeout(async () => {
      await loadTabData("scratchpad");
      renderCurrentView();
      const inp = $("#note-search");
      if (inp) {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }, 160);
  });

  $$(".note-list-item").forEach((el) =>
    el.addEventListener("click", () => {
      state.activeNoteId = Number(el.dataset.nid);
      renderCurrentView();
    })
  );

  if (activeNote) {
    const id = activeNote.id;
    let saveTimer = null;
    const scheduleSave = () => {
      const text = $("#note-content").value;
      const wc = text.trim() ? text.trim().split(/\s+/).length : 0;
      const statusEl = $("#note-save-status");
      if (statusEl) statusEl.textContent = `${wc} ${wc === 1 ? "word" : "words"} · Saving…`;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const res = await api(`/api/scratchpad/${id}`, {
          method: "PATCH",
          body: { title: $("#note-title").value, content: text },
        });
        const idx = state.notes.findIndex((n) => n.id === id);
        if (idx >= 0) state.notes[idx] = res.item;
        const itemBtn = document.querySelector(`.note-list-item[data-nid="${id}"] .note-list-title`);
        if (itemBtn) itemBtn.textContent = `${res.item.pinned ? "★ " : ""}${res.item.title}`;
        if (statusEl) statusEl.textContent = `${wc} ${wc === 1 ? "word" : "words"} · Saved`;
      }, 320);
    };
    $("#note-title")?.addEventListener("input", scheduleSave);
    $("#note-content")?.addEventListener("input", scheduleSave);

    $("#btn-note-pin")?.addEventListener("click", async () => {
      const res = await api(`/api/scratchpad/${id}`, { method: "PATCH", body: { pinned: !activeNote.pinned } });
      await loadTabData("scratchpad");
      state.activeNoteId = res.item.id;
      renderCurrentView();
    });
    $("#btn-note-copy")?.addEventListener("click", async () => {
      await api("/api/copy", { method: "POST", body: { text: $("#note-content").value } });
      toast("Note copied");
    });
    $("#btn-note-export")?.addEventListener("click", () => {
      const title = ($("#note-title").value || "note").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
      downloadTextFile(`${title}.md`, `# ${$("#note-title").value}\n\n${$("#note-content").value}\n`);
      toast("Exported Markdown");
    });
    $("#btn-note-del")?.addEventListener("click", async () => {
      await api(`/api/scratchpad/${id}`, { method: "DELETE" });
      state.activeNoteId = null;
      await loadTabData("scratchpad");
      renderCurrentView();
      toast("Note deleted");
    });
  }
}

/* ==================== 3. NOTETAKER (PHASE 2) ==================== */

function renderNotetakerView(root) {
  setToolbar("Notetaker", "Phase 2 Roadmap");
  root.innerHTML = `
    <div class="notetaker-empty">
      <div class="notetaker-icon">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>
      </div>
      <h2>Meeting Notetaker</h2>
      <p>Planned for Phase 2. Record and transcribe calls completely offline without joining meetings as a bot.</p>
      <div class="inset-group notetaker-list">
        <div class="pref-row">
          <div>
            <div class="pref-title">Dual-Stream PipeWire Audio</div>
            <div class="pref-desc">Captures both your microphone and system speaker monitor simultaneously for Zoom, Meet, and Discord calls.</div>
          </div>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Speaker-Labeled Local Transcript</div>
            <div class="pref-desc">Separates "You" (mic) from "Other" (call audio) in real time on your GPU.</div>
          </div>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Private AI Summaries</div>
            <div class="pref-desc">Generates structured meeting overviews, decisions, and action items using your configured LLM.</div>
          </div>
        </div>
      </div>
    </div>`;
}

/* ==================== 4. DICTIONARY ==================== */

function renderDictionaryView(root) {
  const q = state.searchDict.toLowerCase();
  const filtered = state.dictionary.filter(
    (d) => d.word.toLowerCase().includes(q) || (d.replacement || "").toLowerCase().includes(q)
  );

  setToolbar(
    "Dictionary",
    `${filtered.length} ${filtered.length === 1 ? "term" : "terms"}`,
    `<div class="search-field">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
       <input class="input" id="dict-search" placeholder="Filter terms" value="${esc(state.searchDict)}" />
     </div>
     <button class="btn btn-secondary btn-sm" id="btn-import-dict">Import</button>`
  );

  const listHtml = filtered.length
    ? `<div class="inset-group">${filtered
        .map(
          (d) => `
          <div class="inset-row">
            <div>
              <strong>${esc(d.word)}</strong>
              ${d.replacement ? `<span class="row-arrow">→</span><span>${esc(d.replacement)}</span>` : ""}
            </div>
            <button class="action-chip danger del-dict" data-id="${d.id}">Remove</button>
          </div>`
        )
        .join("")}</div>`
    : `<div class="inset-group"><div class="empty-state"><h4>No custom terms yet</h4><p>Add names, acronyms, or domain terms above. VoxBox feeds them to both Whisper and AI Cleanup for exact spelling.</p></div></div>`;

  root.innerHTML = `
    <div class="page">
      <div class="quick-add-bar">
        <input class="input" id="qa-dict-word" placeholder="Term or heard phrase (e.g. Arbitrum)" />
        <input class="input" id="qa-dict-repl" placeholder="Optional replacement (leave blank to preserve)" />
        <button class="btn btn-primary" id="qa-dict-add">Add</button>
      </div>
      ${listHtml}
    </div>`;

  const submitAdd = async () => {
    const word = $("#qa-dict-word").value.trim();
    const replacement = $("#qa-dict-repl").value.trim();
    if (!word) return;
    await api("/api/dictionary", { method: "POST", body: { word, replacement } });
    await loadTabData("dictionary");
    renderCurrentView();
    toast("Added to dictionary");
  };

  $("#qa-dict-add")?.addEventListener("click", submitAdd);
  $("#qa-dict-word")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAdd(); });
  $("#qa-dict-repl")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAdd(); });

  $("#dict-search")?.addEventListener("input", (e) => {
    state.searchDict = e.target.value;
    renderCurrentView();
    const inp = $("#dict-search");
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  });

  $("#btn-import-dict")?.addEventListener("click", () =>
    openFormModal(
      "Import Dictionary",
      `<div class="field"><label>One entry per line (optional <code>heard -> spelling</code>)</label>
       <textarea class="textarea" id="f-bulk" placeholder="VoxBox\nArbitrum\nVis4Flow -> Wispr Flow"></textarea></div>
       <div class="dialog-actions"><button class="btn btn-secondary" id="f-cancel">Cancel</button><button class="btn btn-primary" id="f-save">Import</button></div>`,
      async () => {
        const res = await api("/api/dictionary/import", { method: "POST", body: { text: $("#f-bulk").value } });
        closeFormModal();
        await loadTabData("dictionary");
        renderCurrentView();
        toast(`Imported ${res.count} ${res.count === 1 ? "term" : "terms"}`);
      }
    )
  );

  $$(".del-dict").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/dictionary/${b.dataset.id}`, { method: "DELETE" });
      await loadTabData("dictionary");
      renderCurrentView();
    })
  );
}

/* ==================== 5. SNIPPETS ==================== */

function renderSnippetsView(root) {
  const q = state.searchSnippets.toLowerCase();
  const filtered = state.snippets.filter(
    (s) => s.trigger.toLowerCase().includes(q) || s.expansion.toLowerCase().includes(q)
  );

  setToolbar(
    "Snippets",
    `${filtered.length} ${filtered.length === 1 ? "snippet" : "snippets"}`,
    `<div class="search-field">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
       <input class="input" id="snip-search" placeholder="Filter snippets" value="${esc(state.searchSnippets)}" />
     </div>
     <button class="btn btn-secondary btn-sm" id="btn-import-snip">Import</button>`
  );

  const listHtml = filtered.length
    ? `<div class="inset-group">${filtered
        .map(
          (s) => `
          <div class="inset-row">
            <div style="min-width:0">
              <strong>${esc(s.trigger)}</strong>
              <span class="row-arrow">→</span>
              <span style="color:var(--text-secondary)">${esc(s.expansion)}</span>
            </div>
            <button class="action-chip danger del-snip" data-id="${s.id}">Remove</button>
          </div>`
        )
        .join("")}</div>`
    : `<div class="inset-group"><div class="empty-state"><h4>No voice snippets yet</h4><p>Map a short spoken trigger to an email address, link, or reusable prompt to insert it instantly.</p></div></div>`;

  root.innerHTML = `
    <div class="page">
      <div class="quick-add-bar">
        <input class="input" id="qa-snip-trig" placeholder="Spoken trigger (e.g. my email)" />
        <input class="input" id="qa-snip-exp" placeholder="Expanded text (e.g. name@domain.com)" />
        <button class="btn btn-primary" id="qa-snip-add">Add</button>
      </div>
      ${listHtml}
    </div>`;

  const submitAdd = async () => {
    const trigger = $("#qa-snip-trig").value.trim();
    const expansion = $("#qa-snip-exp").value.trim();
    if (!trigger || !expansion) return;
    await api("/api/snippets", { method: "POST", body: { trigger, expansion } });
    await loadTabData("snippets");
    renderCurrentView();
    toast("Snippet saved");
  };

  $("#qa-snip-add")?.addEventListener("click", submitAdd);
  $("#qa-snip-exp")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitAdd(); });

  $("#snip-search")?.addEventListener("input", (e) => {
    state.searchSnippets = e.target.value;
    renderCurrentView();
    const inp = $("#snip-search");
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  });

  $("#btn-import-snip")?.addEventListener("click", () =>
    openFormModal(
      "Import Snippets",
      `<div class="field"><label>One per line as <code>trigger -> expansion</code></label>
       <textarea class="textarea" id="f-bulk" placeholder="my cal link -> https://cal.com/you"></textarea></div>
       <div class="dialog-actions"><button class="btn btn-secondary" id="f-cancel">Cancel</button><button class="btn btn-primary" id="f-save">Import</button></div>`,
      async () => {
        const res = await api("/api/snippets/import", { method: "POST", body: { text: $("#f-bulk").value } });
        closeFormModal();
        await loadTabData("snippets");
        renderCurrentView();
        toast(`Imported ${res.count} ${res.count === 1 ? "snippet" : "snippets"}`);
      }
    )
  );

  $$(".del-snip").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/snippets/${b.dataset.id}`, { method: "DELETE" });
      await loadTabData("snippets");
      renderCurrentView();
    })
  );
}

/* ==================== 6. STYLE ==================== */

function renderStyleView(root) {
  const cfg = state.appState.config;
  const styles = state.appState.styles || {};
  const labels = {
    default: "Default",
    casual: "Personal",
    work: "Work",
    email: "Email",
    code: "Code & Prompts",
  };
  const active = cfg.llm.active_style || "default";

  setToolbar("Style", "Tone and formatting guidance");

  root.innerHTML = `
    <div class="page">
      <div class="pref-section-label">Writing Preset</div>
      <div style="margin-bottom:16px">
        <div class="segmented" role="tablist">
          ${Object.entries(labels)
            .map(([k, lbl]) => `<button class="seg-btn style-seg ${k === active ? "active" : ""}" data-style="${k}" role="tab">${esc(lbl)}</button>`)
            .join("")}
        </div>
      </div>

      <div class="inset-group" style="margin-bottom:24px">
        <div class="pref-row">
          <div>
            <div class="pref-title">${esc(labels[active] || active)}</div>
            <div class="pref-desc">${esc(styles[active] || "")}</div>
          </div>
          <span class="pill-tag accent">Active</span>
        </div>
      </div>

      <div class="pref-section-label">Custom Instructions</div>
      <div class="surface-card">
        <div class="field" style="margin-bottom:12px">
          <label for="style-custom">Additional guidance appended to your AI cleanup prompt</label>
          <textarea class="textarea" id="style-custom" style="min-height:120px" placeholder="e.g. Keep sentences concise, avoid em-dashes, preserve technical identifiers verbatim…">${esc(cfg.llm.custom_instructions || "")}</textarea>
        </div>
        <div style="display:flex;justify-content:flex-end">
          <button class="btn btn-primary" id="btn-save-style">Save Instructions</button>
        </div>
      </div>
    </div>`;

  $$(".style-seg").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("/api/settings", { method: "POST", body: { llm: { active_style: b.dataset.style } } });
      await refreshState();
      renderCurrentView();
      toast(`Style set to ${b.textContent}`);
    })
  );

  $("#btn-save-style")?.addEventListener("click", async () => {
    await api("/api/settings", { method: "POST", body: { llm: { custom_instructions: $("#style-custom").value } } });
    await refreshState();
    toast("Style instructions saved");
  });
}

/* ==================== 7. TRANSFORMS ==================== */

function renderTransformsView(root) {
  const cfg = state.appState.config;
  const autoId = cfg.llm.auto_transform_id;

  setToolbar(
    "Transforms",
    `${state.transforms.length} presets`,
    `<button class="btn btn-ghost btn-sm" id="btn-reset-tr">Reset Defaults</button>
     <button class="btn btn-primary btn-sm" id="btn-new-tr">New Transform</button>`
  );

  const opts = state.transforms
    .map((t) => `<option value="${t.id}" ${autoId === t.id ? "selected" : ""}>${esc(t.name)}</option>`)
    .join("");

  const cards = state.transforms
    .map(
      (t) => `
      <div class="tile-card">
        <div>
          <h4>${esc(t.name)}</h4>
          <p>${esc(t.description || "Custom rewrite prompt")}</p>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
          <button class="btn btn-secondary btn-sm tr-try" data-id="${t.id}">Test</button>
          <div style="display:flex;gap:4px">
            <button class="btn btn-ghost btn-sm tr-edit" data-id="${t.id}">Edit</button>
            ${t.is_default ? "" : `<button class="action-chip danger tr-del" data-id="${t.id}">Delete</button>`}
          </div>
        </div>
      </div>`
    )
    .join("");

  root.innerHTML = `
    <div class="page">
      <div class="inset-group" style="margin-bottom:24px">
        <div class="pref-row">
          <div>
            <div class="pref-title">Auto-Apply After Dictation</div>
            <div class="pref-desc">Automatically run the selected transform on every dictated transcript.</div>
          </div>
          <div class="pref-control">
            <select class="select" id="tr-auto-select" style="width:180px" ${autoId ? "" : "disabled"}>${opts}</select>
            <label class="switch"><input type="checkbox" id="tr-auto-toggle" ${autoId ? "checked" : ""}/><span class="slider"></span></label>
          </div>
        </div>
      </div>

      <div class="pref-section-label">Presets</div>
      <div class="tiles-grid">
        ${cards}
        <button class="tile-card dashed" id="card-create-tr">
          <div style="font-size:20px;color:var(--text-tertiary)">+</div>
          <div>
            <h4>New Transform</h4>
            <p>Create a reusable rewrite prompt</p>
          </div>
        </button>
      </div>
    </div>`;

  const saveAuto = async (enabled) => {
    const sel = $("#tr-auto-select");
    const chosen = enabled && sel?.value ? Number(sel.value) : null;
    await api("/api/settings", { method: "POST", body: { llm: { auto_transform_id: chosen } } });
    await refreshState();
    renderCurrentView();
  };

  $("#tr-auto-toggle")?.addEventListener("change", (e) => saveAuto(e.target.checked));
  $("#tr-auto-select")?.addEventListener("change", () => saveAuto(true));

  const openEditor = (existing = null) =>
    openFormModal(
      existing ? `Edit ${existing.name}` : "New Transform",
      `<div class="field"><label>Name</label><input class="input" id="f-tname" value="${esc(existing?.name || "")}" placeholder="e.g. Executive Summary" /></div>
       <div class="field"><label>Description</label><input class="input" id="f-tdesc" value="${esc(existing?.description || "")}" placeholder="Short summary of what this transform does" /></div>
       <div class="field"><label>Prompt</label><textarea class="textarea" id="f-tprompt" style="min-height:130px">${esc(existing?.prompt || "")}</textarea></div>
       <div class="dialog-actions"><button class="btn btn-secondary" id="f-cancel">Cancel</button><button class="btn btn-primary" id="f-save">Save</button></div>`,
      async () => {
        await api("/api/transforms", {
          method: "POST",
          body: { id: existing?.id ?? null, name: $("#f-tname").value, description: $("#f-tdesc").value, prompt: $("#f-tprompt").value },
        });
        closeFormModal();
        await loadTabData("transforms");
        renderCurrentView();
        toast("Transform saved");
      }
    );

  $("#btn-new-tr")?.addEventListener("click", () => openEditor(null));
  $("#card-create-tr")?.addEventListener("click", () => openEditor(null));
  $("#btn-reset-tr")?.addEventListener("click", async () => {
    await api("/api/transforms/reset", { method: "POST" });
    await loadTabData("transforms");
    renderCurrentView();
    toast("Default transforms restored");
  });
  $$(".tr-edit").forEach((b) =>
    b.addEventListener("click", () => {
      const t = state.transforms.find((x) => x.id === Number(b.dataset.id));
      if (t) openEditor(t);
    })
  );
  $$(".tr-del").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/transforms/${b.dataset.id}`, { method: "DELETE" });
      await loadTabData("transforms");
      renderCurrentView();
    })
  );
  $$(".tr-try").forEach((b) =>
    b.addEventListener("click", () => {
      const t = state.transforms.find((x) => x.id === Number(b.dataset.id));
      if (!t) return;
      openFormModal(
        `Test "${t.name}"`,
        `<div class="field"><label>Input (dictate with ${esc(state.appState.hotkey_label)} or paste text)</label><textarea class="textarea" id="f-in" placeholder="Enter text to transform…"></textarea></div>
         <div class="field"><label>Output</label><textarea class="textarea" id="f-out" readonly placeholder="Transformed result will appear here…"></textarea></div>
         <div class="dialog-actions"><button class="btn btn-secondary" id="f-cancel">Close</button><button class="btn btn-primary" id="f-save">Run Transform</button></div>`,
        async () => {
          const btn = $("#f-save");
          btn.disabled = true;
          btn.textContent = "Running…";
          try {
            const res = await api("/api/transforms/run", { method: "POST", body: { transform_id: t.id, text: $("#f-in").value } });
            $("#f-out").value = res.result;
            toast(`Completed in ${res.latency_ms} ms`);
          } finally {
            btn.disabled = false;
            btn.textContent = "Run Transform";
          }
        }
      );
    })
  );
}

/* ==================== 8. INSIGHTS ==================== */

function renderInsightsView(root) {
  const ins = state.insights || {
    total_words: 0, wpm: 0, total_fixes: 0, words_corrected: 0, dict_fixes: 0,
    total_dictations: 0, avg_stt_ms: 0, avg_llm_ms: 0, current_streak: 0, longest_streak: 0, heatmap: [],
  };
  setToolbar("Insights", "Local usage & performance");

  const pct = Math.min(1, ins.wpm / 160);
  const dashTotal = 188;
  const dashOffset = dashTotal * (1 - pct);
  const maxDay = Math.max(1, ...ins.heatmap.map((h) => h.words));
  const cells = ins.heatmap
    .map((h) => {
      let cls = "";
      if (h.words > 0) {
        const r = h.words / maxDay;
        cls = r > 0.75 ? "l4" : r > 0.45 ? "l3" : r > 0.2 ? "l2" : "l1";
      }
      return `<div class="heat-cell ${cls}" title="${h.date}: ${h.words} words"></div>`;
    })
    .join("");

  const avgWords = ins.total_dictations ? Math.round(ins.total_words / ins.total_dictations) : 0;
  const totalMs = ins.avg_stt_ms + ins.avg_llm_ms;
  const maxBar = Math.max(totalMs, 600);
  const sttPct = ins.avg_stt_ms ? Math.max(8, Math.round((ins.avg_stt_ms / maxBar) * 100)) : 0;
  const llmPct = ins.avg_llm_ms ? Math.max(8, Math.round((ins.avg_llm_ms / maxBar) * 100)) : 0;
  const totPct = totalMs ? Math.max(10, Math.round((totalMs / maxBar) * 100)) : 0;

  root.innerHTML = `
    <div class="page">
      <div class="kpi-grid">
        <div class="surface-card">
          <div class="kpi-label">Speaking Pace</div>
          <div class="kpi-value">${ins.wpm} <span style="font-size:14px;font-weight:500;color:var(--text-tertiary)">wpm</span></div>
          <div class="gauge-wrap">
            <svg width="152" height="84" viewBox="0 0 160 88">
              <path d="M20 78 A60 60 0 0 1 140 78" fill="none" stroke="var(--heat-0)" stroke-width="10" stroke-linecap="round"/>
              <path d="M20 78 A60 60 0 0 1 140 78" fill="none" stroke="var(--accent)" stroke-width="10" stroke-linecap="round"
                stroke-dasharray="${dashTotal}" stroke-dashoffset="${dashOffset.toFixed(1)}"/>
              <text x="80" y="72" text-anchor="middle" fill="var(--text-tertiary)" font-size="11.5" font-weight="500">
                ${ins.wpm > 0 ? "Active" : "No sessions"}
              </text>
            </svg>
          </div>
        </div>

        <div class="surface-card">
          <div class="kpi-label">Refinements</div>
          <div class="kpi-value">${ins.total_fixes.toLocaleString()}</div>
          <div class="kpi-sub">
            <div>${ins.words_corrected.toLocaleString()} AI cleanup ${ins.words_corrected === 1 ? "edit" : "edits"}</div>
            <div>${ins.dict_fixes.toLocaleString()} dictionary &amp; snippet ${ins.dict_fixes === 1 ? "fix" : "fixes"}</div>
          </div>
        </div>

        <div class="surface-card">
          <div class="kpi-label">Words Dictated</div>
          <div class="kpi-value">${ins.total_words.toLocaleString()}</div>
          <div class="kpi-sub">
            <div>${ins.total_dictations.toLocaleString()} ${ins.total_dictations === 1 ? "session" : "sessions"}</div>
            <div>~${avgWords} words per dictation</div>
          </div>
        </div>
      </div>

      <div class="insights-lower">
        <div class="surface-card">
          <div class="card-head">
            <h3>Pipeline Speed</h3>
            <span class="card-head-meta">${esc(state.appState.llm_provider_label)}</span>
          </div>
          <div class="latency-row">
            <div class="latency-label">CUDA Whisper</div>
            <div class="latency-track"><div class="latency-fill" style="width:${sttPct}%"></div></div>
            <div class="latency-val">${ins.avg_stt_ms} ms</div>
          </div>
          <div class="latency-row">
            <div class="latency-label">AI Cleanup</div>
            <div class="latency-track"><div class="latency-fill" style="width:${llmPct}%"></div></div>
            <div class="latency-val">${ins.avg_llm_ms} ms</div>
          </div>
          <div class="latency-row">
            <div class="latency-label">Total</div>
            <div class="latency-track"><div class="latency-fill" style="width:${totPct}%"></div></div>
            <div class="latency-val">${totalMs} ms</div>
          </div>
        </div>

        <div class="surface-card">
          <div class="card-head">
            <h3>${ins.current_streak} ${ins.current_streak === 1 ? "day" : "days"} streak</h3>
            <span class="card-head-meta">Longest · ${ins.longest_streak} ${ins.longest_streak === 1 ? "day" : "days"}</span>
          </div>
          <div class="heatmap-grid">${cells}</div>
          <div class="heatmap-legend">
            <span>Less</span>
            <span class="legend-swatch" style="background:var(--heat-0)"></span>
            <span class="legend-swatch" style="background:var(--heat-1)"></span>
            <span class="legend-swatch" style="background:var(--heat-2)"></span>
            <span class="legend-swatch" style="background:var(--heat-3)"></span>
            <span class="legend-swatch" style="background:var(--heat-4)"></span>
            <span>More</span>
          </div>
        </div>
      </div>
    </div>`;
}

/* ==================== SETTINGS SHEET ==================== */

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
      : `<option value="">No models installed</option>`;
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
      <div class="pref-section-label">Input</div>
      <div class="pref-group">
        <div class="pref-row">
          <div>
            <div class="pref-title">Hold-to-Talk Shortcut</div>
            <div class="pref-desc">Hold <strong>${esc(state.appState.hotkey_label)}</strong> anywhere to dictate. Press Esc to cancel.</div>
          </div>
          <div class="pref-control">
            <button class="btn btn-secondary btn-sm" id="set-hotkey">Change…</button>
          </div>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Microphone</div>
            <div class="pref-desc">PipeWire audio input source.</div>
          </div>
          <div class="pref-control">
            <select class="select" id="set-mic">${micOpts}</select>
          </div>
        </div>
      </div>

      <div class="pref-section-label">Transcription &amp; Intelligence</div>
      <div class="pref-group">
        <div class="pref-row">
          <div>
            <div class="pref-title">Speech Model</div>
            <div class="pref-desc">Local Whisper model running on CUDA.</div>
          </div>
          <div class="pref-control with-action">
            <select class="select" id="set-whisper">${whisperOpts}</select>
            <button class="btn btn-secondary btn-sm" id="btn-goto-models">Manage…</button>
          </div>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Language</div>
            <div class="pref-desc">Spoken dictation language.</div>
          </div>
          <div class="pref-control">
            <select class="select" id="set-lang">${langOpts}</select>
          </div>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">AI Cleanup</div>
            <div class="pref-desc">${esc(state.appState.llm_provider_label)} · <code>${esc(state.appState.llm_active_model)}</code></div>
          </div>
          <div class="pref-control">
            <button class="btn btn-secondary btn-sm" id="btn-goto-llm">Configure…</button>
            <label class="switch"><input type="checkbox" id="set-llm-en" ${cfg.llm.enabled ? "checked" : ""}/><span class="slider"></span></label>
          </div>
        </div>
      </div>

      <div class="pref-section-label">Appearance</div>
      <div class="pref-group">
        <div class="pref-row">
          <div>
            <div class="pref-title">Theme</div>
            <div class="pref-desc">Switch between Dark and Light appearance.</div>
          </div>
          <div class="pref-control">
            <div class="segmented">
              <button class="seg-btn theme-seg ${cfg.ui.theme !== "light" ? "active" : ""}" data-theme-val="dark">Dark</button>
              <button class="seg-btn theme-seg ${cfg.ui.theme === "light" ? "active" : ""}" data-theme-val="light">Light</button>
            </div>
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
          btn.textContent = "Change…";
        }
      } catch {
        btn.disabled = false;
        btn.textContent = "Change…";
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
    $("#btn-goto-models").addEventListener("click", () => { state.settingsTab = "models"; renderSettingsContent(); });
    $("#btn-goto-llm").addEventListener("click", () => { state.settingsTab = "llm"; renderSettingsContent(); });
    $("#set-lang").addEventListener("change", (e) => saveSetting({ stt: { language: e.target.value } }));
    $("#set-llm-en").addEventListener("change", (e) => saveSetting({ llm: { enabled: e.target.checked } }));
    $$(".theme-seg").forEach((b) =>
      b.addEventListener("click", async () => {
        await saveSetting({ ui: { theme: b.dataset.themeVal } });
        renderSettingsContent();
      })
    );
  } else if (state.settingsTab === "models") {
    const models = res.whisper_models || [];
    const anyDownloading = models.some((m) => m.downloading);

    el.innerHTML = `
      <div class="pref-desc" style="margin-bottom:14px">
        Download and switch between local Whisper GGML models. Turbo and Large models excel on GPUs; Base and Tiny run smoothly on CPU.
      </div>
      <div class="model-list">
        ${models
          .map((m) => {
            let act = "";
            if (m.downloading) {
              act = `<button class="btn btn-secondary btn-sm mdl-cancel" data-id="${esc(m.id)}">Cancel</button>`;
            } else if (m.active) {
              act = `<span class="pill-tag success">Active</span>`;
            } else if (m.installed) {
              act = `<button class="btn btn-primary btn-sm mdl-use" data-id="${esc(m.id)}">Use</button>
                     <button class="action-chip danger mdl-del" data-id="${esc(m.id)}">Delete</button>`;
            } else {
              act = `<button class="btn btn-secondary btn-sm mdl-dl" data-id="${esc(m.id)}">Download</button>`;
            }

            const prog = m.downloading
              ? `<div class="progress-row">
                   <div class="progress-track"><div class="progress-fill" style="width:${m.progress}%"></div></div>
                   <span class="progress-text">${m.progress}% · ${m.downloaded_mb} / ${m.total_mb} MB</span>
                 </div>`
              : m.error
              ? `<div style="font-size:12px;color:var(--danger)">Download error: ${esc(m.error)}</div>`
              : "";

            return `
              <div class="model-row ${m.active ? "active" : ""}">
                <div class="model-row-top">
                  <div>
                    <div class="model-title-line">
                      <span class="model-name">${esc(m.name)}</span>
                      <span class="pill-tag ${m.recommended ? "accent" : ""}">${esc(m.badge)}</span>
                    </div>
                    <div class="model-meta">${esc(m.size_label)} · ${esc(m.languages)} — ${esc(m.description)}</div>
                  </div>
                  <div class="model-actions">${act}</div>
                </div>
                ${prog}
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
        } catch (err) { toast(err.message); }
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
        } catch (err) { toast(err.message); }
      })
    );
    $$(".mdl-del").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api(`/api/models/${encodeURIComponent(b.dataset.id)}`, { method: "DELETE" });
          state.resources = await api("/api/system/resources");
          renderSettingsContent();
          toast("Model deleted");
        } catch (err) { toast(err.message); }
      })
    );

    if (anyDownloading) {
      modelsPollTimer = setInterval(async () => {
        try {
          const data = await api("/api/models");
          if (state.resources) state.resources.whisper_models = data.items;
          if (state.settingsTab === "models" && !$("#settings-modal").classList.contains("hidden")) {
            renderSettingsContent();
          } else stopModelsPolling();
        } catch { stopModelsPolling(); }
      }, 600);
    }
  } else if (state.settingsTab === "llm") {
    const cat = state.llmCatalog || { ollama: { reachable: false, items: [] }, cloud: {} };
    const provider = cfg.llm.provider || "ollama";
    const providers = [
      ["ollama", "Ollama"],
      ["gemini", "Gemini"],
      ["claude", "Claude"],
      ["openai", "OpenAI"],
      ["openai_compatible", "OpenAI-Compat"],
    ];

    let body = "";
    let anyPulling = false;

    if (provider === "ollama") {
      const items = cat.ollama?.items || [];
      anyPulling = items.some((m) => m.pulling);
      body = `
        <div class="pref-group">
          <div class="pref-row">
            <div>
              <div class="pref-title">Ollama Server</div>
              <div class="pref-desc">${cat.ollama?.reachable ? "Connected locally" : "Not reachable at this URL"}</div>
            </div>
            <div class="pref-control"><input class="input" id="llm-ollama-url" value="${esc(cfg.llm.base_url)}" /></div>
          </div>
          <div class="pref-row">
            <div>
              <div class="pref-title">Low-Latency Mode (Disable Thinking)</div>
              <div class="pref-desc">Recommended for Qwen3 models (~400 ms instead of several seconds).</div>
            </div>
            <label class="switch"><input type="checkbox" id="llm-nothink" ${!cfg.llm.think ? "checked" : ""}/><span class="slider"></span></label>
          </div>
          <div class="pref-row">
            <div>
              <div class="pref-title">Pull Custom Tag</div>
              <div class="pref-desc">Any model tag from Ollama (e.g. <code>mistral:7b</code>).</div>
            </div>
            <div class="pref-control">
              <input class="input" id="llm-custom-pull" style="width:150px" placeholder="qwen3:4b" />
              <button class="btn btn-secondary btn-sm" id="btn-custom-pull">Pull</button>
            </div>
          </div>
        </div>

        <div class="pref-section-label">Local Models by VRAM</div>
        <div class="model-list">
          ${items
            .map((m) => {
              let act = "";
              if (m.pulling) act = `<button class="btn btn-secondary btn-sm ol-cancel" data-m="${esc(m.name)}">Cancel</button>`;
              else if (m.active) act = `<span class="pill-tag success">Active</span>`;
              else if (m.installed)
                act = `<button class="btn btn-primary btn-sm ol-use" data-m="${esc(m.name)}">Use</button>
                       <button class="action-chip danger ol-del" data-m="${esc(m.name)}">Delete</button>`;
              else act = `<button class="btn btn-secondary btn-sm ol-pull" data-m="${esc(m.name)}">Pull</button>`;

              const prog = m.pulling
                ? `<div class="progress-row">
                     <div class="progress-track"><div class="progress-fill" style="width:${m.progress}%"></div></div>
                     <span class="progress-text">${m.progress}% · ${esc(m.status || "pulling")}</span>
                   </div>`
                : m.error
                ? `<div style="font-size:12px;color:var(--danger)">Pull error: ${esc(m.error)}</div>`
                : "";
              return `
                <div class="model-row ${m.active ? "active" : ""}">
                  <div class="model-row-top">
                    <div>
                      <div class="model-title-line">
                        <span class="model-name">${esc(m.name)}</span>
                        <span class="pill-tag accent">${esc(m.vram)}</span>
                        <span class="pill-tag">${esc(m.badge)}</span>
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
      const curKey = cfg.llm[`${provider}_api_key`] || "";
      const curModel = cfg.llm[`${provider}_model`] || "";
      const suggested = cat.cloud?.[provider]?.models || [];
      const inList = suggested.some((m) => m.id === curModel);
      const opts = [
        ...suggested.map((m) => `<option value="${esc(m.id)}" ${curModel === m.id ? "selected" : ""}>${esc(m.label)}</option>`),
        `<option value="__custom__" ${!inList ? "selected" : ""}>Custom model ID…</option>`,
      ].join("");

      body = `
        <div class="pref-group">
          <div class="pref-row stacked">
            <div>
              <div class="pref-title">${esc(cat.cloud?.[provider]?.label || provider)} API Key</div>
              <div class="pref-desc">Stored locally in <code>~/.config/voxbox/config.toml</code> with owner-only permissions (0600).</div>
            </div>
            <div style="display:flex;gap:8px">
              <input type="password" class="input" id="llm-cloud-key" value="${esc(curKey)}" placeholder="Paste API key…" />
              <button class="btn btn-secondary btn-sm" id="btn-toggle-key">Show</button>
            </div>
          </div>
          <div class="pref-row">
            <div>
              <div class="pref-title">Model</div>
              <div class="pref-desc">Select a fast recommended model or enter a custom ID.</div>
            </div>
            <div class="pref-control"><select class="select" id="llm-cloud-select" style="width:240px">${opts}</select></div>
          </div>
          <div class="pref-row ${inList ? "hidden" : ""}" id="llm-custom-model-row">
            <div><div class="pref-title">Custom Model ID</div></div>
            <div class="pref-control"><input class="input" id="llm-cloud-custom" style="width:240px" value="${esc(curModel)}" placeholder="Model ID" /></div>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
          <button class="btn btn-primary" id="btn-save-cloud">Save Settings</button>
        </div>`;
    } else {
      const presets = cat.cloud?.openai_compatible?.presets || [];
      body = `
        <div class="preset-row">
          ${presets.map((p, idx) => `<button class="preset-chip compat-preset" data-idx="${idx}">${esc(p.name)}</button>`).join("")}
        </div>
        <div class="pref-group">
          <div class="pref-row stacked">
            <div>
              <div class="pref-title">Base URL</div>
              <div class="pref-desc">Any OpenAI-compatible <code>/v1</code> endpoint.</div>
            </div>
            <input class="input" id="llm-compat-url" value="${esc(cfg.llm.compat_base_url)}" placeholder="https://api.groq.com/openai/v1" />
          </div>
          <div class="pref-row stacked">
            <div>
              <div class="pref-title">API Key</div>
              <div class="pref-desc">Optional for local servers like LM Studio or vLLM.</div>
            </div>
            <div style="display:flex;gap:8px">
              <input type="password" class="input" id="llm-compat-key" value="${esc(cfg.llm.compat_api_key)}" placeholder="Paste API key…" />
              <button class="btn btn-secondary btn-sm" id="btn-toggle-key">Show</button>
            </div>
          </div>
          <div class="pref-row stacked">
            <div><div class="pref-title">Model ID</div></div>
            <input class="input" id="llm-compat-model" value="${esc(cfg.llm.compat_model)}" placeholder="llama-3.3-70b-versatile" />
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
          <button class="btn btn-primary" id="btn-save-compat">Save Settings</button>
        </div>`;
    }

    el.innerHTML = `
      <div class="pref-group">
        <div class="pref-row">
          <div>
            <div class="pref-title">Enable AI Cleanup</div>
            <div class="pref-desc">Remove fillers, resolve self-corrections, and polish punctuation after Whisper transcribes.</div>
          </div>
          <label class="switch"><input type="checkbox" id="llm-master-en" ${cfg.llm.enabled ? "checked" : ""}/><span class="slider"></span></label>
        </div>
      </div>

      <div style="margin-bottom:16px">
        <div class="segmented" style="flex-wrap:wrap">
          ${providers.map(([k, lbl]) => `<button class="seg-btn prov-seg ${provider === k ? "active" : ""}" data-prov="${k}">${esc(lbl)}</button>`).join("")}
        </div>
      </div>

      ${body}

      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px">
        <span class="pref-desc" style="margin:0">Test your active provider and measure cleanup latency.</span>
        <button class="btn btn-secondary btn-sm" id="btn-test-llm">Test Cleanup</button>
      </div>
      <div class="test-result hidden" id="llm-test-out"></div>`;

    $("#llm-master-en").addEventListener("change", (e) => saveSetting({ llm: { enabled: e.target.checked } }));
    $$(".prov-seg").forEach((b) =>
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
          } catch (err) { toast(err.message); }
        })
      );
      if (anyPulling) {
        modelsPollTimer = setInterval(async () => {
          try {
            state.llmCatalog = await api("/api/llm/catalog");
            if (state.settingsTab === "llm" && !$("#settings-modal").classList.contains("hidden")) renderSettingsContent();
            else stopModelsPolling();
          } catch { stopModelsPolling(); }
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
        await saveSetting({ llm: { provider, [`${provider}_api_key`]: $("#llm-cloud-key").value.trim(), [`${provider}_model`]: chosenModel } });
      });
    } else {
      const presets = cat.cloud?.openai_compatible?.presets || [];
      $$(".compat-preset").forEach((b) =>
        b.addEventListener("click", () => {
          const p = presets[Number(b.dataset.idx)];
          if (!p) return;
          $("#llm-compat-url").value = p.base_url;
          $("#llm-compat-model").value = p.model;
          toast(`Loaded ${p.name} preset`);
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
        box.innerHTML = `<strong style="color:var(--text-primary)">${esc(r.provider)} · ${esc(r.model)} · ${r.latency_ms} ms</strong><div style="margin-top:4px;color:var(--text-primary)">${esc(r.result)}</div>`;
      } catch (err) {
        box.className = "test-result err";
        box.textContent = err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = "Test Cleanup";
      }
    });
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
      <div class="pref-section-label">Desktop Integration</div>
      <div class="pref-group">
        <div class="pref-row">
          <div>
            <div class="pref-title">Launch at Login</div>
            <div class="pref-desc">Starts <code>voxbox.service</code> automatically with your session.</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-autostart" ${res.autostart ? "checked" : ""}/><span class="slider"></span></label>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Show Floating Bar at All Times</div>
            <div class="pref-desc">Keep the minimal bar anchored at bottom-center when idle.</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-bar" ${cfg.ui.show_flow_bar ? "checked" : ""}/><span class="slider"></span></label>
        </div>
      </div>

      <div class="pref-section-label">Audio &amp; Insertion</div>
      <div class="pref-group">
        <div class="pref-row">
          <div>
            <div class="pref-title">Dictation Sounds</div>
            <div class="pref-desc">Subtle chimes when recording starts, stops, or cancels.</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-sounds" ${cfg.audio.sound_effects ? "checked" : ""}/><span class="slider"></span></label>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Mute System Audio While Dictating</div>
            <div class="pref-desc">Temporarily mutes output via PipeWire while recording.</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-mute" ${cfg.audio.mute_while_dictating ? "checked" : ""}/><span class="slider"></span></label>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Paste Method</div>
            <div class="pref-desc">How VoxBox inserts text into the focused window.</div>
          </div>
          <div class="pref-control"><select class="select" id="set-paste">${pasteOpts}</select></div>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Append Trailing Space</div>
            <div class="pref-desc">Adds a space after pasted text for continuous dictation.</div>
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
      <div class="pref-group">
        <div class="pref-row">
          <div>
            <div class="pref-title">Meeting Notetaker</div>
            <div class="pref-desc">Planned for Phase 2: dual-stream mic + PipeWire speaker capture, speaker-separated local transcripts, and AI call summaries.</div>
          </div>
          <span class="pill-tag accent">Planned</span>
        </div>
      </div>`;
  } else {
    const paths = state.appState.paths;
    el.innerHTML = `
      <div class="pref-group">
        <div class="pref-row">
          <div>
            <div class="pref-title">Local-First Architecture</div>
            <div class="pref-desc">Speech recognition always runs locally on your machine. Cloud APIs are only called if you explicitly configure one in AI Cleanup.</div>
          </div>
          <span class="pill-tag success">Private</span>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Configuration</div>
            <div class="pref-desc"><code>${esc(paths.config)}</code></div>
          </div>
          <button class="btn btn-secondary btn-sm" id="btn-open-cfg-dir">Open Folder</button>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Database &amp; Logs</div>
            <div class="pref-desc"><code>${esc(paths.data)}</code></div>
          </div>
          <button class="btn btn-secondary btn-sm" id="btn-open-data-dir">Open Folder</button>
        </div>
        <div class="pref-row">
          <div>
            <div class="pref-title">Clear Dictation History</div>
            <div class="pref-desc">Permanently removes saved dictation entries while keeping your Dictionary, Snippets, and Scratchpad.</div>
          </div>
          <button class="btn btn-danger btn-sm" id="btn-clear-hist">Clear History</button>
        </div>
      </div>`;

    $("#btn-open-cfg-dir").addEventListener("click", () => api("/api/system/open-folder", { method: "POST", body: { kind: "config" } }));
    $("#btn-open-data-dir").addEventListener("click", () => api("/api/system/open-folder", { method: "POST", body: { kind: "data" } }));
    $("#btn-clear-hist").addEventListener("click", async () => {
      await api("/api/dictations/clear", { method: "POST" });
      await loadTabData(state.tab);
      renderCurrentView();
      toast("History cleared");
    });
  }
}

async function saveSetting(patch) {
  await api("/api/settings", { method: "POST", body: patch });
  await refreshState();
  renderCurrentView();
  toast("Saved");
}

/* ==================== SHEET DIALOG ==================== */

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

/* ==================== BOOTSTRAP & KEYBOARD SHORTCUTS ==================== */

async function init() {
  $$("#sidebar-nav .nav-item").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
  $("#btn-open-settings").addEventListener("click", () => openSettingsModal("general"));
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
    if (!$("#settings-modal").classList.contains("hidden")) renderSettingsContent();
  });

  $("#btn-dictate-now").addEventListener("click", async () => {
    await api("/api/dictate/toggle", { method: "POST" });
    await refreshState();
    if (state.tab === "dictation") renderCurrentView();
  });

  // Keyboard shortcuts (Esc to close sheets/cancel edit, Ctrl+, for Settings, Ctrl+K for Search)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#form-modal").classList.contains("hidden")) closeFormModal();
      else if (!$("#settings-modal").classList.contains("hidden")) closeSettingsModal();
      else if (state.editingDictationId !== null) {
        state.editingDictationId = null;
        renderCurrentView();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
      e.preventDefault();
      openSettingsModal("general");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      const search = $("#dictation-search") || $("#dict-search") || $("#snip-search") || $("#note-search");
      if (search) {
        e.preventDefault();
        search.focus();
      }
    }
  });

  await refreshState();
  const params = new URLSearchParams(window.location.search);
  const initialTab = params.get("tab") || "dictation";
  const initialStab = params.get("stab") || "general";
  if (initialTab === "settings") {
    await switchTab("dictation");
    await openSettingsModal(initialStab);
  } else {
    await switchTab(initialTab);
  }

  // Live polling for recording timer & completed dictations
  setInterval(async () => {
    try {
      const prevState = state.appState?.state;
      await refreshState();
      if (state.tab === "dictation" && prevState !== state.appState.state) {
        await loadTabData("dictation");
        renderCurrentView();
      } else if (prevState === "processing" && state.appState.state === "idle" && state.tab === "insights") {
        await loadTabData("insights");
        renderCurrentView();
      }
    } catch {}
  }, 900);
}

init().catch((err) => {
  console.error(err);
  $("#main-canvas").innerHTML = `<div class="empty-state"><h4>Could not connect to VoxBox</h4><p>${esc(err.message)}</p></div>`;
});
