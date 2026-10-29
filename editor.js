"use strict";

import {
    MACRO_CATEGORIES,
    analyzeMacros,
    availabilityLabel,
    getMacroDefinition,
    getMacroField,
} from "./utils/macros.js";
import { download, extractFilename } from "./utils/download.js";

/* ------------------------------------------------------------------ *
 * Preset signature — same contract as the viewer (index.js).
 * ------------------------------------------------------------------ */

const PRESET_SIGNATURE_KEYS = [
    "impersonation_prompt",
    "new_chat_prompt",
    "new_group_chat_prompt",
    "new_example_chat_prompt",
    "continue_nudge_prompt",
    "wi_format",
    "scenario_format",
    "personality_format",
    "group_nudge_prompt",
    "prompts",
    "prompt_order",
];

// Display order for utility fields. `wi_format` last on purpose: it is the
// one macro-looking field ST does not expand.
const UTILITY_KEYS = [
    "impersonation_prompt",
    "new_chat_prompt",
    "new_group_chat_prompt",
    "new_example_chat_prompt",
    "continue_nudge_prompt",
    "group_nudge_prompt",
    "scenario_format",
    "personality_format",
    "assistant_prefill",
    "assistant_impersonation",
    "custom_include_body",
    "custom_exclude_body",
    "custom_include_headers",
    "wi_format",
];

const OPTIONAL_UTILITY_KEYS = new Set([
    "assistant_prefill",
    "assistant_impersonation",
    "custom_include_body",
    "custom_exclude_body",
    "custom_include_headers",
]);

/* ------------------------------------------------------------------ *
 * State — everything lives here, the DOM is re-rendered from it.
 * ------------------------------------------------------------------ */

// Deep clone of the loaded file; unknown keys (samplers, toggles, ...)
// round-trip verbatim through here.
let originalJson = null;
// Index of the active prompt_order entry we are editing.
let activeOrderIndex = -1;
let activeCharacterId = null;

// identifier -> full ST prompt object (all original keys preserved).
let prompts = new Map();
// [{ identifier, enabled }] — mutable copy of the active order entry.
let order = [];
// utility key -> string content.
let utility = {};
// { type: 'prompt'|'utility', key } — what the edit pane shows.
let selection = null;

let currentFile = null;
let dirty = false;

/* ------------------------------------------------------------------ *
 * DOM handles
 * ------------------------------------------------------------------ */

const fileInput = document.getElementById("editor-file-input");
const filenameInput = document.getElementById("filename-input");
const saveButton = document.getElementById("save-button");
const newButton = document.getElementById("new-button");
const reloadButton = document.getElementById("reload-button");
const addPromptButton = document.getElementById("add-prompt-button");
const searchInput = document.getElementById("editor-search");
const statsBar = document.getElementById("editor-stats");
const errorsBar = document.getElementById("editor-errors");
const emptyState = document.getElementById("editor-empty");
const layout = document.getElementById("editor-layout");
const orderList = document.getElementById("order-list");
const orphanList = document.getElementById("orphan-list");
const utilityList = document.getElementById("utility-list");
const orderCount = document.getElementById("order-count");
const orphanCount = document.getElementById("orphan-count");
const main = document.getElementById("editor-main");
const dirtyDot = document.getElementById("dirty-dot");
const builtinBanner = document.getElementById("builtin-banner");

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function isJsonAPreset(json) {
    if (!json || typeof json !== "object") return false;
    const keys = Object.keys(json);
    return PRESET_SIGNATURE_KEYS.every(k => keys.includes(k));
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function markDirty() {
    dirty = true;
    dirtyDot.hidden = false;
    saveButton.disabled = false;
    document.title = "• ST Preset Editor";
}

function markClean() {
    dirty = false;
    dirtyDot.hidden = true;
    document.title = "ST Preset Editor";
}

function orphanIds() {
    const inOrder = new Set(order.map(o => o.identifier));
    return [...prompts.keys()].filter(id => !inOrder.has(id));
}

function defaultPromptObject(identifier) {
    return {
        identifier,
        name: "New prompt",
        role: "system",
        content: "",
        system_prompt: false,
        marker: false,
        enabled: true,
        injection_position: 0,
        injection_depth: 4,
        forbid_overrides: false,
    };
}

/* ------------------------------------------------------------------ *
 * Built-in prompt knowledge (ST text-completion presets).
 *
 * `stSupplied` — the prompt's content is supplied by ST at runtime, so ST
 *                doesn't even show a textbox for it. This editor shows a
 *                locked panel instead (stored text, if any, is preserved
 *                verbatim on save but never evaluated by ST). All prompts,
 *                built-in or not, are renameable.
 * `toggleable` — whether ST lets the user enable/disable it;
 *                null = unknown, treated as allowed in this editor.
 * Marker prompts are replaced with runtime data by ST; their `marker`
 * flag, identifier and existence are locked here just like in ST.
 * DEFAULT_ORDER is the canonical arrangement — edit freely.
 * ------------------------------------------------------------------ */

const BUILTIN_PROMPTS = Object.freeze({
    worldInfoBefore: { name: "World Info (before)", stSupplied: true, toggleable: null },
    personaDescription: { name: "Persona Description", stSupplied: true, toggleable: true },
    charDescription: { name: "Char Description", stSupplied: true, toggleable: true },
    charPersonality: { name: "Char Personality", stSupplied: true, toggleable: true },
    scenario: { name: "Scenario", stSupplied: true, toggleable: true },
    worldInfoAfter: { name: "World Info (after)", stSupplied: true, toggleable: null },
    dialogueExamples: { name: "Chat Examples", stSupplied: true, toggleable: true },
    chatHistory: { name: "Chat history", stSupplied: true, toggleable: false },
    main: { name: "Main Prompt", stSupplied: false, toggleable: null },
    enhanceDefinitions: { name: "Enhance Definitions", stSupplied: false, toggleable: true },
    nsfw: { name: "Auxiliary Prompt", stSupplied: false, toggleable: true },
    jailbreak: { name: "Post-History Instructions", stSupplied: false, toggleable: true },
});

// Canonical prompt arrangement, mirroring ST's default text-completion order.
const DEFAULT_ORDER = Object.freeze([
    "main",
    "personaDescription",
    "worldInfoBefore",
    "charDescription",
    "charPersonality",
    "scenario",
    "worldInfoAfter",
    "dialogueExamples",
    "enhanceDefinitions",
    "nsfw",
    "chatHistory",
    "jailbreak",
]);

// Identifiers ST treats as built-in marker prompts.
const MARKER_PROMPTS = new Set([
    "worldInfoBefore",
    "personaDescription",
    "charDescription",
    "charPersonality",
    "scenario",
    "worldInfoAfter",
    "dialogueExamples",
    "chatHistory",
]);

function isBuiltin(id) {
    return Object.hasOwn(BUILTIN_PROMPTS, id);
}

function isToggleable(id) {
    return BUILTIN_PROMPTS[id]?.toggleable !== false;
}

// Where ST-supplied content actually comes from (shown in the locked panel).
const ST_SUPPLIED_SOURCES = Object.freeze({
    worldInfoBefore: "World Info entries placed before the character block — edit your lorebooks",
    personaDescription: "the active user persona — edit the persona directly",
    charDescription: "the character card description — edit the character card",
    charPersonality: "the character card personality — edit the character card",
    scenario: "the scenario — edit the character card",
    worldInfoAfter: "World Info entries placed after the scenario — edit your lorebooks",
    dialogueExamples: "the character card example dialogue — edit the character card",
    chatHistory: "the chat history",
});

function isContentSupplied(id) {
    return BUILTIN_PROMPTS[id]?.stSupplied === true;
}

// ST assigns UUIDs to every new prompt, and the identifier cannot be changed
// there afterwards. This editor still allows editing (except for built-ins),
// but new prompts start life as UUIDs just like in ST.
function makeIdentifier() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        let id = crypto.randomUUID();
        while (prompts.has(id)) id = crypto.randomUUID();
        return id;
    }
    let id;
    do {
        id = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
    } while (prompts.has(id));
    return id;
}

function builtinPromptObject(identifier) {
    const meta = BUILTIN_PROMPTS[identifier] ?? { name: identifier };
    return {
        ...defaultPromptObject(identifier),
        name: meta.name ?? identifier,
        // Best-effort mirror of ST defaults for a fresh preset.
        system_prompt: identifier === "main",
        marker: MARKER_PROMPTS.has(identifier),
        enabled: true,
    };
}

// Insert into the active order where DEFAULT_ORDER says it belongs:
// before the first entry that ranks after it, else appended.
function insertOrderEntryAtDefaultPosition(identifier, enabled) {
    const entry = { identifier, enabled: !!enabled };
    const rank = DEFAULT_ORDER.indexOf(identifier);
    if (rank === -1) { order.push(entry); return; }
    const idx = order.findIndex(o => {
        const r = DEFAULT_ORDER.indexOf(o.identifier);
        return r !== -1 && r > rank;
    });
    if (idx === -1) order.push(entry);
    else order.splice(idx, 0, entry);
}

/* ------------------------------------------------------------------ *
 * Macro display — same detection as the viewer, lightweight rendering.
 * analyzeMacros() is reused 1:1; only the DOM builders below are local
 * (the viewer's versions are not exported from index.js).
 * ------------------------------------------------------------------ */

function macroTitle(macro, expanded) {
    const lines = [];
    if (macro.malformed) lines.push(macro.malformed.message);
    else if (macro.isComment) lines.push("Comment. Removed from the output.");
    else if (macro.isVariable) lines.push(`Variable shorthand (${macro.variable?.scope ?? "local"}).`);
    else if (macro.isClosing) lines.push(`Closing tag for {{${macro.name}}}.`);
    else lines.push(macro.name ? `{{${macro.name}}}` : "Malformed macro.");
    const cat = MACRO_CATEGORIES[macro.category];
    if (cat) lines.push(cat.label);
    const def = getMacroDefinition(macro.name);
    if (def && !macro.malformed) {
        lines.push(availabilityLabel(def));
        if (def.description) lines.push(def.description);
    }
    if (macro.newEngineOnly) lines.push("New macro engine only (default since ST 1.17.0).");
    if (!expanded) lines.push("This field is not macro-expanded by ST; the text stays literal.");
    return lines.join("\n");
}

function macroSpan(macro, expanded) {
    const span = el("span", `macro-hl cat-${macro.category}`);
    if (macro.isComment) span.classList.add("macro-hl-comment");
    if (macro.isClosing) span.classList.add("macro-hl-closing");
    if (macro.isVariable) span.classList.add("macro-hl-variable");
    if (macro.scope?.role === "open") span.classList.add("macro-hl-scope");
    if (macro.malformed) span.classList.add("macro-hl-invalid");
    if (macro.known && macro.availability === "unknown") span.classList.add("macro-hl-unknown");
    if (macro.known && macro.availability === "ext") span.classList.add("macro-hl-extension");
    if (macro.dynamic) span.classList.add("macro-hl-dynamic");
    if (!expanded) span.classList.add("macro-hl-literal");
    span.textContent = macro.raw;
    span.title = macroTitle(macro, expanded);
    return span;
}

function renderHighlight(pre, text, analysis, expanded) {
    pre.innerHTML = "";
    if (!analysis || !Array.isArray(analysis.segments) || analysis.segments.length === 0) {
        pre.textContent = text;
        return;
    }
    for (const seg of analysis.segments) {
        if (seg.type === "text") pre.appendChild(document.createTextNode(seg.text));
        else pre.appendChild(macroSpan(seg.macro, expanded));
    }
}

function renderIssues(container, analysis) {
    container.innerHTML = "";
    if (!analysis || analysis.issues.length === 0) return null;
    const list = el("ul", "macro-issues");
    for (const issue of analysis.issues) {
        const li = el("li", `macro-issue issue-${issue.severity}`);
        li.title = issue.message;
        const sev = el("span", "issue-severity", issue.severity);
        li.appendChild(sev);
        if (issue.line) li.appendChild(el("span", "issue-location", `L${issue.line}:${issue.column}`));
        li.appendChild(el("span", "issue-message", issue.message));
        list.appendChild(li);
    }
    container.appendChild(list);
    return list;
}

function renderChips(container, analysis) {
    container.innerHTML = "";
    if (!analysis || analysis.stats.total === 0) return;
    const chips = el("div", "macro-chips");
    const items = Object.values(analysis.stats.byName)
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    for (const item of items) {
        const chip = el("span", `macro-chip cat-${item.category}`);
        const def = getMacroDefinition(item.name);
        let flag = "";
        if (item.newEngineOnly) flag = "new";
        else if (item.extension) flag = "ext";
        else if (item.dynamic) flag = "dyn";
        else if (!item.known) flag = "?";
        const title = [`{{${item.name}}}`];
        if (def?.description) title.push(def.description);
        if (flag) title.push(flag);
        chip.title = title.join("\n");
        chip.appendChild(el("span", "macro-dot"));
        chip.appendChild(el("code", "macro-chip-name", item.name));
        chip.appendChild(el("span", "macro-chip-count", `×${item.count}`));
        if (flag) chip.appendChild(el("span", "macro-chip-flag", flag));
        chips.appendChild(chip);
    }
    container.appendChild(chips);
}

function macroSummaryText(analysis, expanded) {
    if (!analysis) return "no text";
    const s = analysis.stats;
    if (s.total === 0) return expanded ? "no macros" : "not expanded by ST";
    let out = `${s.total} macro${s.total === 1 ? "" : "s"}`;
    if (s.errors) out += ` · ${s.errors} error${s.errors === 1 ? "" : "s"}`;
    else if (s.warnings) out += ` · ${s.warnings} warning${s.warnings === 1 ? "" : "s"}`;
    if (!expanded) out += " · not expanded by ST";
    return out;
}

/* ------------------------------------------------------------------ *
 * Load / new / save
 * ------------------------------------------------------------------ */

function loadJsonObject(json, label) {
    if (!isJsonAPreset(json)) {
        alert("That file is not a valid ST preset JSON.");
        return;
    }
    originalJson = structuredClone(json);

    // Pick the same active entry the viewer (and ST) uses.
    const entries = Array.isArray(json.prompt_order) ? json.prompt_order : [];
    activeOrderIndex =
        entries.findIndex(e => String(e?.character_id) === "100001");
    if (activeOrderIndex === -1)
        activeOrderIndex = entries.findIndex(e => String(e?.character_id) === "100000");
    if (activeOrderIndex === -1) activeOrderIndex = entries.length - 1;
    activeCharacterId = entries[activeOrderIndex]?.character_id ?? 100001;

    prompts = new Map();
    for (const p of json.prompts ?? []) {
        if (p && typeof p.identifier === "string") prompts.set(p.identifier, structuredClone(p));
    }

    order = (entries[activeOrderIndex]?.order ?? []).map(o => ({
        identifier: o.identifier,
        enabled: !!o.enabled,
    }));

    utility = {};
    for (const key of UTILITY_KEYS) {
        if (key in json) {
            utility[key] = typeof json[key] === "string" ? json[key] : (json[key] ?? "");
        } else if (!OPTIONAL_UTILITY_KEYS.has(key)) {
            utility[key] = "";
        }
    }

    selection = order.length > 0
        ? { type: "prompt", key: order[0].identifier }
        : (prompts.size > 0 ? { type: "prompt", key: [...prompts.keys()][0] } : { type: "utility", key: UTILITY_KEYS[0] });

    filenameInput.value = label || filenameInput.value || "preset.json";
    markClean();
    saveButton.disabled = false;
    addPromptButton.disabled = false;
    reloadButton.disabled = !currentFile;
    renderAll();
}

function handleFile(file) {
    if (!file) return;
    currentFile = file;
    try {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
    } catch { /* currentFile is the source of truth */ }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
        let json;
        try {
            json = JSON.parse(reader.result);
        } catch {
            alert("Could not parse that file as JSON.");
            return;
        }
        loadJsonObject(json, file.name);
    });
    reader.readAsText(file);
}

function blankPreset() {
    const json = {
        impersonation_prompt: "",
        new_chat_prompt: "",
        new_group_chat_prompt: "",
        new_example_chat_prompt: "",
        continue_nudge_prompt: "",
        group_nudge_prompt: "",
        scenario_format: "{{scenario}}",
        personality_format: "{{personality}}",
        wi_format: "{0}",
        prompts: DEFAULT_ORDER.map(builtinPromptObject),
        prompt_order: [{
            character_id: 100001,
            order: DEFAULT_ORDER.map(identifier => ({ identifier, enabled: true })),
        }],
    };
    currentFile = null;
    reloadButton.disabled = true;
    try { fileInput.value = ""; } catch { /* ignore */ }
    loadJsonObject(json, "preset.json");
    markDirty();
}

function validateForSave() {
    const problems = [];
    const seen = new Set();
    for (const id of prompts.keys()) {
        if (!id || !id.trim()) problems.push("A prompt has an empty identifier.");
        else if (/\s/.test(id)) problems.push(`Identifier "${id}" contains whitespace; ST identifiers use letters, digits and _.`);
        if (seen.has(id)) problems.push(`Duplicate identifier "${id}".`);
        seen.add(id);
    }
    for (const o of order) {
        if (!prompts.has(o.identifier)) problems.push(`Order entry "${o.identifier}" has no matching prompt and will be dropped on save.`);
    }
    for (const id of orphanIds()) {
        void id; // orphans are fine — they save into `prompts` but stay out of the order.
    }
    return problems;
}

function buildOutputJson() {
    const out = structuredClone(originalJson) ?? {};

    // Prompts array: keep original relative order, then append new ones.
    const arr = [];
    for (const p of originalJson?.prompts ?? []) {
        if (prompts.has(p.identifier)) arr.push(structuredClone(prompts.get(p.identifier)));
    }
    for (const [id, p] of prompts) {
        if (!arr.some(q => q.identifier === id)) arr.push(structuredClone(p));
    }
    // Sync the order-level enabled flag onto the prompt objects to avoid
    // the classic ST confusion of the two disagreeing.
    const enabledById = new Map(order.map(o => [o.identifier, o.enabled]));
    for (const p of arr) {
        if (enabledById.has(p.identifier)) p.enabled = enabledById.get(p.identifier);
    }
    out.prompts = arr;

    // Active prompt_order entry: replace its order, keep everything else.
    if (Array.isArray(out.prompt_order) && activeOrderIndex >= 0 && out.prompt_order[activeOrderIndex]) {
        out.prompt_order[activeOrderIndex] = {
            ...structuredClone(out.prompt_order[activeOrderIndex]),
            character_id: activeCharacterId,
            order: order
                .filter(o => prompts.has(o.identifier))
                .map(o => ({ identifier: o.identifier, enabled: !!o.enabled })),
        };
    }

    for (const key of UTILITY_KEYS) {
        if (key in utility) out[key] = utility[key];
    }
    return out;
}

function saveDownload() {
    if (!originalJson) return;
    const problems = validateForSave().filter(m => !m.includes("will be dropped"));
    const fatal = problems.filter(m => m.startsWith("Duplicate") || m.startsWith("A prompt has"));
    if (fatal.length > 0) {
        errorsBar.hidden = false;
        errorsBar.textContent = fatal.join("\n");
        return;
    }
    errorsBar.hidden = true;
    errorsBar.textContent = "";
    const out = buildOutputJson();
    let name = (filenameInput.value || "preset.json").trim() || "preset.json";
    if (!name.toLowerCase().endsWith(".json")) name += ".json";
    download(JSON.stringify(out, null, 2), "application/json", name);
    markClean();
    saveButton.disabled = false; // staying loaded means further edits still save fine
}

/* ------------------------------------------------------------------ *
 * Sidebar
 * ------------------------------------------------------------------ */

function renderSidebar() {
    const query = (searchInput.value || "").trim().toLowerCase();
    orderList.innerHTML = "";
    orphanList.innerHTML = "";
    utilityList.innerHTML = "";

    // Built-ins are essential: offer one-click repair when any are missing.
    const missingBuiltin = DEFAULT_ORDER.filter(id => !prompts.has(id));
    builtinBanner.hidden = missingBuiltin.length === 0;
    builtinBanner.innerHTML = "";
    if (missingBuiltin.length > 0) {
        builtinBanner.appendChild(el("span", null, `Missing built-ins: ${missingBuiltin.join(", ")}`));
        const addMissing = el("button", "btn btn-ghost", `Add missing (${missingBuiltin.length})`);
        addMissing.type = "button";
        addMissing.addEventListener("click", () => {
            for (const id of missingBuiltin) {
                prompts.set(id, builtinPromptObject(id));
                insertOrderEntryAtDefaultPosition(id, true);
            }
            selection = { type: "prompt", key: missingBuiltin[0] };
            markDirty();
            renderAll();
        });
        builtinBanner.appendChild(addMissing);
    }

    const orphans = orphanIds();
    orderCount.textContent = `· ${order.length}`;
    orphanCount.textContent = `· ${orphans.length}`;

    order.forEach((entry, idx) => {
        const prompt = prompts.get(entry.identifier);
        const name = prompt?.name || entry.identifier;
        if (query && !`${name} ${entry.identifier}`.toLowerCase().includes(query)) return;
        const li = el("li", "order-row" + (entry.enabled ? "" : " is-disabled"));
        if (selection?.type === "prompt" && selection.key === entry.identifier) li.classList.add("selected");

        const check = document.createElement("input");
        check.type = "checkbox";
        check.className = "enable-check";
        check.checked = entry.enabled;
        check.disabled = !isToggleable(entry.identifier);
        check.title = !isToggleable(entry.identifier)
            ? "ST does not allow toggling this built-in."
            : (entry.enabled ? "Enabled in prompt order (click to disable)" : "Disabled in prompt order (click to enable)");
        check.addEventListener("change", () => {
            entry.enabled = check.checked;
            const p = prompts.get(entry.identifier);
            if (p) p.enabled = check.checked;
            markDirty();
            renderSidebar();
            if (selection?.type === "prompt" && selection.key === entry.identifier) renderMain();
            updateStats();
        });

        const btn = el("button", "order-select", name);
        btn.type = "button";
        btn.title = entry.identifier + (isBuiltin(entry.identifier) ? " (ST built-in)" : "");
        btn.addEventListener("click", () => { selection = { type: "prompt", key: entry.identifier }; renderSidebar(); renderMain(); });

        const up = el("button", "row-btn", "▲");
        up.type = "button"; up.title = "Move up"; up.disabled = idx === 0;
        up.addEventListener("click", () => {
            [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
            markDirty(); renderSidebar(); updateStats();
        });
        const down = el("button", "row-btn", "▼");
        down.type = "button"; down.title = "Move down"; down.disabled = idx === order.length - 1;
        down.addEventListener("click", () => {
            [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
            markDirty(); renderSidebar(); updateStats();
        });

        li.append(check, btn, up, down);
        orderList.appendChild(li);
    });

    if (orderList.children.length === 0) {
        orderList.appendChild(el("li", "order-row", query ? "No matches." : "Empty — add a prompt."));
    }

    for (const id of orphans) {
        const prompt = prompts.get(id);
        const name = prompt?.name || id;
        if (query && !`${name} ${id}`.toLowerCase().includes(query)) return;
        const li = el("li", "order-row");
        if (selection?.type === "prompt" && selection.key === id) li.classList.add("selected");
        const btn = el("button", "order-select", `${name} (orphan)`);
        btn.type = "button"; btn.title = id;
        btn.addEventListener("click", () => { selection = { type: "prompt", key: id }; renderSidebar(); renderMain(); });
        const add = el("button", "row-btn", "+order");
        add.type = "button"; add.title = "Append to prompt order";
        add.addEventListener("click", () => {
            order.push({ identifier: id, enabled: !!prompt?.enabled });
            markDirty(); renderAll();
        });
        li.append(btn, add);
        orphanList.appendChild(li);
    }
    if (orphanList.children.length === 0) orphanList.appendChild(el("li", "order-row", "None."));

    for (const key of UTILITY_KEYS) {
        if (!(key in utility)) continue;
        const li = el("li", "order-row util-row");
        if (selection?.type === "utility" && selection.key === key) li.classList.add("selected");
        const btn = el("button", "order-select", key);
        btn.type = "button";
        const info = getMacroField(key);
        const text = utility[key] ?? "";
        const a = analyzeMacros(text, { kind: "utility", field: key, expanded: info.expanded });
        btn.textContent = `${key} — ${macroSummaryText(a, info.expanded)}`;
        if (a.stats.errors > 0) btn.classList.add("warn");
        btn.addEventListener("click", () => { selection = { type: "utility", key }; renderSidebar(); renderMain(); });
        li.appendChild(btn);
        utilityList.appendChild(li);
    }
}

/* ------------------------------------------------------------------ *
 * Edit pane
 * ------------------------------------------------------------------ */

function fieldRow(labelText, control, { full = false, hint = "" } = {}) {
    const label = el("label", "ed-field" + (full ? " full" : ""));
    label.appendChild(el("span", null, labelText));
    label.appendChild(control);
    if (hint) label.title = hint;
    return label;
}

function checkRow(labelText, checked, onChange, hint = "", disabled = false) {
    const label = el("label", "ed-field ed-check");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!checked;
    box.disabled = !!disabled;
    if (hint) label.title = hint;
    box.addEventListener("change", () => onChange(box.checked));
    label.appendChild(box);
    label.appendChild(el("span", null, labelText));
    return label;
}

function renderPromptForm(prompt, orderEntry, inOrder) {
    const head = el("div", "ed-head");
    head.appendChild(el("h2", null, prompt.identifier));
    if (!inOrder) head.appendChild(el("span", "badge badge-orphan", "not in order"));
    if (inOrder && !orderEntry.enabled) head.appendChild(el("span", "badge badge-disabled", "disabled"));
    if (prompt.marker) head.appendChild(el("span", "badge badge-marker", "builtin"));
    else if (isBuiltin(prompt.identifier)) head.appendChild(el("span", "badge badge-marker", "default"));
    head.appendChild(el("span", "spacer"));

    const dupBtn = el("button", "btn btn-ghost", "Duplicate");
    dupBtn.type = "button";
    dupBtn.addEventListener("click", () => {
        const id = makeIdentifier();
        const copy = structuredClone(prompt);
        copy.identifier = id;
        copy.name = `${prompt.name || prompt.identifier} (copy)`;
        copy.marker = false;
        prompts.set(id, copy);
        order.push({ identifier: id, enabled: false });
        selection = { type: "prompt", key: id };
        markDirty(); renderAll();
    });

    const delBtn = el("button", "btn btn-ghost btn-danger", "Delete");
    delBtn.type = "button";
    delBtn.disabled = prompt.marker || isBuiltin(prompt.identifier);
    delBtn.title = (prompt.marker || isBuiltin(prompt.identifier))
        ? "ST built-in prompts cannot be deleted."
        : "Delete this prompt";
    delBtn.addEventListener("click", () => {
        if (!confirm(`Delete prompt "${prompt.identifier}"?`)) return;
        prompts.delete(prompt.identifier);
        order = order.filter(o => o.identifier !== prompt.identifier);
        selection = order.length > 0 ? { type: "prompt", key: order[0].identifier } : null;
        markDirty(); renderAll();
    });
    head.append(dupBtn, delBtn);
    main.appendChild(head);

    if (!inOrder) {
        const note = el("p", "macro-note", "This prompt is not in the active prompt_order, so ST does not evaluate it. Use “+order” in the sidebar or the button below to append it.");
        const addBtn = el("button", "btn btn-ghost", "Append to prompt order");
        addBtn.type = "button";
        addBtn.addEventListener("click", () => {
            order.push({ identifier: prompt.identifier, enabled: !!prompt.enabled });
            markDirty(); renderAll();
        });
        main.append(note, addBtn);
    }

    const grid = el("div", "ed-grid");

    const nameInput = document.createElement("input");
    nameInput.type = "text"; nameInput.value = prompt.name ?? "";
    nameInput.addEventListener("input", () => { prompt.name = nameInput.value; markDirty(); updateStats(); });
    grid.appendChild(fieldRow("Name", nameInput, { full: true, hint: "Labels only — ST does not expand macros here." }));

    const idInput = document.createElement("input");
    idInput.type = "text"; idInput.value = prompt.identifier;
    idInput.spellcheck = false;
    idInput.disabled = isBuiltin(prompt.identifier);
    idInput.addEventListener("change", () => {
        const oldId = prompt.identifier;
        const next = idInput.value.trim();
        if (!next || next === oldId) { idInput.value = oldId; return; }
        if (prompts.has(next)) {
            idInput.classList.add("invalid");
            errorsBar.hidden = false;
            errorsBar.textContent = `Identifier "${next}" already exists.`;
            return;
        }
        idInput.classList.remove("invalid");
        errorsBar.hidden = true; errorsBar.textContent = "";
        prompts.delete(oldId);
        prompt.identifier = next;
        prompts.set(next, prompt);
        for (const o of order) if (o.identifier === oldId) o.identifier = next;
        selection = { type: "prompt", key: next };
        markDirty(); renderAll();
    });
    grid.appendChild(fieldRow(
        "Identifier",
        idInput,
        {
            full: true,
            hint: isBuiltin(prompt.identifier)
                ? "Locked by ST for built-ins."
                : "UUID in ST, unchangeable there — editable here, must stay unique.",
        },
    ));

    const roleSel = document.createElement("select");
    for (const r of ["system", "user", "assistant"]) {
        const opt = document.createElement("option");
        opt.value = r; opt.textContent = r;
        if ((prompt.role ?? "system") === r) opt.selected = true;
        roleSel.appendChild(opt);
    }
    roleSel.addEventListener("change", () => { prompt.role = roleSel.value; markDirty(); updateStats(); });
    grid.appendChild(fieldRow("Role", roleSel));

    const posSel = document.createElement("select");
    [["0", "Relative (default)"], ["1", `In-chat @ depth`]].forEach(([v, label]) => {
        const opt = document.createElement("option");
        opt.value = v; opt.textContent = label;
        if (String(prompt.injection_position ?? 0) === v) opt.selected = true;
        posSel.appendChild(opt);
    });
    posSel.addEventListener("change", () => { prompt.injection_position = Number(posSel.value); markDirty(); renderSidebar(); });
    grid.appendChild(fieldRow("Position", posSel, { hint: "0 = relative (default), 1 = in-chat at depth." }));

    const depthInput = document.createElement("input");
    depthInput.type = "number"; depthInput.min = "0"; depthInput.value = prompt.injection_depth ?? 4;
    depthInput.addEventListener("input", () => { prompt.injection_depth = Number(depthInput.value); markDirty(); });
    grid.appendChild(fieldRow("Depth", depthInput, { hint: "In-chat injection depth." }));

    grid.appendChild(checkRow("Enabled", inOrder ? orderEntry.enabled : !!prompt.enabled, v => {
        if (inOrder) { orderEntry.enabled = v; prompt.enabled = v; }
        else prompt.enabled = v;
        markDirty(); renderSidebar(); renderMain(); updateStats();
    }, inOrder ? "This is what ST evaluates — not the prompt's own flag." : "Takes effect once added to the order.", !isToggleable(prompt.identifier)));

    grid.appendChild(checkRow("System prompt", !!prompt.system_prompt, v => { prompt.system_prompt = v; markDirty(); }));
    grid.appendChild(checkRow("Marker", !!prompt.marker, v => { prompt.marker = v; markDirty(); renderMain(); },
        isBuiltin(prompt.identifier)
            ? "Locked by ST — content comes from the character card, lorebooks, persona or chat history."
            : "When set, ST ignores the content box and supplies the output from runtime data.",
        isBuiltin(prompt.identifier)));
    grid.appendChild(checkRow("Forbid overrides", !!prompt.forbid_overrides, v => { prompt.forbid_overrides = v; markDirty(); }));
    main.appendChild(grid);

    // ST-supplied content: no textbox, just like ST. Stored text (usually
    // empty) is preserved verbatim on save but never evaluated.
    if (prompt.marker || isContentSupplied(prompt.identifier)) {
        const source = ST_SUPPLIED_SOURCES[prompt.identifier] ?? "runtime data (extension prompt)";
        const lockHead = el("div", "ed-field full");
        lockHead.appendChild(el("span", null, "Content — supplied by ST"));
        main.appendChild(lockHead);
        main.appendChild(el("p", "macro-note",
            `No textbox here, same as ST: this prompt's content comes from ${source}. ` +
            "Stored text below (if any) is ignored by ST and preserved unchanged on save."));
        if ((prompt.content ?? "") !== "") {
            const stored = document.createElement("details");
            stored.className = "ed-preview";
            stored.appendChild(el("summary", null, "Stored text (ignored by ST)"));
            const pre = el("pre", "prompt-content");
            const storedAnalysis = analyzeMacros(prompt.content, { kind: "prompt", enabled: false });
            renderHighlight(pre, prompt.content, storedAnalysis, true);
            stored.appendChild(pre);
            main.appendChild(stored);
        }
        return;
    }

    // Content + live macro feedback. The textarea is created once per
    // selection; only the panel/preview refresh on input (keeps focus).
    const contentHead = el("div", "ed-field full");
    contentHead.appendChild(el("span", null, "Content"));
    main.appendChild(contentHead);
    const textarea = el("textarea", "ed-textarea");
    textarea.value = prompt.content ?? "";
    textarea.spellcheck = false;
    main.appendChild(textarea);

    const line = el("div", "macro-line");
    const issuesBox = el("div");
    const chipsBox = el("div");
    const preview = document.createElement("details");
    preview.className = "ed-preview";
    preview.open = true;
    preview.appendChild(el("summary", null, "Highlighted preview (detection only — values are not resolved)"));
    const pre = el("pre", "prompt-content");
    preview.appendChild(pre);
    main.append(line, issuesBox, chipsBox, preview);

    const refresh = () => {
        prompt.content = textarea.value;
        const enabled = inOrder ? orderEntry.enabled : false;
        const analysis = analyzeMacros(textarea.value, { kind: "prompt", enabled });
        line.textContent = `${macroSummaryText(analysis, true)} · ${textarea.value.length.toLocaleString()} chars`;
        if (!inOrder) line.textContent += " · not in order, not evaluated";
        else if (!enabled) line.textContent += " · disabled, not evaluated";
        renderIssues(issuesBox, analysis);
        renderChips(chipsBox, analysis);
        renderHighlight(pre, textarea.value, analysis, true);
        updateStats();
    };
    let timer = 0;
    textarea.addEventListener("input", () => {
        markDirty();
        clearTimeout(timer);
        timer = setTimeout(refresh, 200);
    });
    refresh();
}

function renderUtilityForm() {
    const head = el("div", "ed-head");
    head.appendChild(el("h2", null, "Utility fields"));
    head.appendChild(el("span", "spacer"));
    const missing = UTILITY_KEYS.filter(k => !(k in utility));
    if (missing.length > 0) {
        const addSel = document.createElement("select");
        addSel.appendChild(el("option", null, "Add optional field…"));
        for (const k of missing) {
            const opt = document.createElement("option");
            opt.value = k; opt.textContent = k;
            addSel.appendChild(opt);
        }
        addSel.addEventListener("change", () => {
            if (!addSel.value || addSel.value.startsWith("Add")) return;
            utility[addSel.value] = originalJson?.[addSel.value] ?? "";
            if (!(addSel.value in utility)) utility[addSel.value] = "";
            selection = { type: "utility", key: addSel.value };
            markDirty(); renderAll();
        });
        head.appendChild(addSel);
    }
    main.appendChild(head);
    main.appendChild(el("p", "macro-note", "Plain-text fields ST substitutes macros into (except wi_format, which stays literal). Each field is analysed as its own document."));

    for (const key of UTILITY_KEYS) {
        if (!(key in utility)) continue;
        const info = getMacroField(key);
        const block = el("div", "util-block");
        block.appendChild(el("h3", null, key));
        if (info.note) block.appendChild(el("p", "util-note", info.note + (info.expanded ? "" : " Not macro-expanded by ST.")));

        const textarea = el("textarea", "ed-textarea small");
        textarea.value = utility[key] ?? "";
        textarea.spellcheck = false;
        textarea.dataset.field = key;
        block.appendChild(textarea);

        const line = el("div", "macro-line");
        const issuesBox = el("div");
        const preview = document.createElement("details");
        preview.className = "ed-preview";
        preview.appendChild(el("summary", null, "Preview"));
        const pre = el("pre", "prompt-content");
        preview.appendChild(pre);
        block.append(line, issuesBox, preview);

        const refresh = () => {
            utility[key] = textarea.value;
            const analysis = analyzeMacros(textarea.value, { kind: "utility", field: key, expanded: info.expanded });
            line.textContent = `${macroSummaryText(analysis, info.expanded)} · ${textarea.value.length.toLocaleString()} chars`;
            renderIssues(issuesBox, analysis);
            renderHighlight(pre, textarea.value, analysis, info.expanded);
        };
        let timer = 0;
        textarea.addEventListener("input", () => {
            markDirty();
            clearTimeout(timer);
            timer = setTimeout(() => { refresh(); renderSidebar(); updateStats(); }, 250);
        });
        refresh();

        if (OPTIONAL_UTILITY_KEYS.has(key)) {
            const rm = el("button", "row-btn", "remove field");
            rm.type = "button";
            rm.title = "Remove this optional field from the preset";
            rm.addEventListener("click", () => {
                delete utility[key];
                selection = { type: "utility", key: UTILITY_KEYS.find(k => k in utility) ?? key };
                markDirty(); renderAll();
            });
            block.appendChild(rm);
        }
        main.appendChild(block);
    }

    const raw = el("details", "ed-preview");
    raw.appendChild(el("summary", null, "Unedited keys (preserved verbatim on save)"));
    const restKeys = Object.keys(originalJson ?? {}).filter(k => !UTILITY_KEYS.includes(k) && k !== "prompts" && k !== "prompt_order");
    const pre = el("pre", "prompt-content", restKeys.length ? restKeys.join(", ") : "(none)");
    raw.appendChild(pre);
    main.appendChild(raw);
}

function renderMain() {
    main.innerHTML = "";
    if (!originalJson) return;
    if (!selection) {
        main.appendChild(el("p", "macro-note", "Select a prompt or utility field from the sidebar."));
        return;
    }
    if (selection.type === "prompt") {
        const prompt = prompts.get(selection.key);
        if (!prompt) {
            main.appendChild(el("p", "macro-note", "That prompt no longer exists."));
            return;
        }
        const orderEntry = order.find(o => o.identifier === selection.key) ?? null;
        renderPromptForm(prompt, orderEntry, !!orderEntry);
    } else {
        renderUtilityForm();
        const target = main.querySelector(`textarea[data-field="${CSS.escape(selection.key)}"]`);
        if (target) {
            target.scrollIntoView({ block: "nearest" });
            target.focus({ preventScroll: true });
        }
    }
}

/* ------------------------------------------------------------------ *
 * Stats + root render
 * ------------------------------------------------------------------ */

function countAllMacros() {
    let active = 0, errors = 0, warnings = 0;
    for (const o of order) {
        const p = prompts.get(o.identifier);
        // ST-supplied (marker) content is replaced with runtime data, so it
        // is never evaluated — excluded here (the viewer still counts the
        // stored text, since it reports on the file, not on ST behavior).
        if (!p || p.marker || isContentSupplied(o.identifier)) continue;
        const a = analyzeMacros(p.content ?? "", { kind: "prompt", enabled: o.enabled });
        if (o.enabled) {
            active += a.stats.total;
            errors += a.stats.errors;
            warnings += a.stats.warnings;
        }
    }
    for (const [key, value] of Object.entries(utility)) {
        const info = getMacroField(key);
        if (!info.expanded) continue;
        const a = analyzeMacros(value ?? "", { kind: "utility", field: key, expanded: true });
        active += a.stats.total;
        errors += a.stats.errors;
        warnings += a.stats.warnings;
    }
    return { active, errors, warnings };
}

function updateStats() {
    if (!originalJson) { statsBar.hidden = true; return; }
    const enabled = order.filter(o => o.enabled).length;
    const orphans = orphanIds().length;
    const m = countAllMacros();
    const parts = [`${order.length} in order (${enabled} enabled)`, `${prompts.size} prompts`, `${orphans} orphan${orphans === 1 ? "" : "s"}`];
    if (m.active > 0) parts.push(`${m.active} macros in active fields`);
    if (m.errors > 0) parts.push(`${m.errors} error${m.errors === 1 ? "" : "s"}`);
    if (m.warnings > 0) parts.push(`${m.warnings} warning${m.warnings === 1 ? "" : "s"}`);
    const missingBuiltin = DEFAULT_ORDER.filter(id => !prompts.has(id));
    if (missingBuiltin.length > 0) parts.push(`missing built-ins: ${missingBuiltin.join(", ")}`);
    parts.push(dirty ? "unsaved changes" : "saved");
    statsBar.textContent = parts.join(" · ");
    statsBar.hidden = false;
}

function renderAll() {
    const has = !!originalJson;
    emptyState.hidden = has;
    layout.hidden = !has;
    saveButton.disabled = !has;
    addPromptButton.disabled = !has;
    if (!has) { statsBar.hidden = true; return; }
    renderSidebar();
    renderMain();
    updateStats();
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));
newButton.addEventListener("click", () => {
    if (dirty && !confirm("Discard unsaved changes and start a blank preset?")) return;
    blankPreset();
});
reloadButton.addEventListener("click", () => {
    if (!currentFile) return;
    if (dirty && !confirm("Discard unsaved changes and reload from file?")) return;
    handleFile(currentFile);
});
saveButton.addEventListener("click", saveDownload);

addPromptButton.addEventListener("click", () => {
    const id = makeIdentifier();
    prompts.set(id, defaultPromptObject(id));
    order.push({ identifier: id, enabled: true });
    selection = { type: "prompt", key: id };
    markDirty();
    renderAll();
});

let searchTimer = 0;
searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderSidebar, 150);
});

document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    if (dirty && !confirm("Discard unsaved changes and open the dropped file?")) return;
    handleFile(file);
});

window.addEventListener("beforeunload", e => {
    if (dirty) e.preventDefault();
});

renderAll();
