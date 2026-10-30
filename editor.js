"use strict";

import {
    MACRO_CATEGORIES,
    analyzeMacros,
    availabilityLabel,
    getMacroDefinition,
    getMacroField,
} from "./utils/macros.js";
import { download, extractFilename } from "./utils/download.js";
import {
    DEFAULT_ORDER,
    MARKER_PROMPT_IDS,
    ST_SUPPLIED_SOURCES,
    isDefaultPromptId,
    isMarkerPromptId,
} from "./utils/preset.js";
import {
    OPTIONAL_UTILITY_KEYS,
    UTILITY_KEYS,
    findActiveOrderEntry,
    isJsonAPreset,
    syncFileInput,
} from "./utils/preset.js";
import { collectVariables } from "./utils/variables.js";

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

// Preset-wide variable index for the outline panel: { variables, byKey }.
let variableIndex = { variables: [], byKey: new Map() };
// The variable whose definition/reference list the outline shows, or null
// for the preset-wide list.
let outlineSelection = null;

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
const outlineBody = document.getElementById("outline-body");
const outlineTitle = document.getElementById("outline-title");
const outlineCount = document.getElementById("outline-count");
const outlineBack = document.getElementById("outline-back");

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

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
 * Default-prompt metadata (ST text-completion presets).
 *
 * The `marker` flag is freely toggleable in the JSON — ST does not expose
 * it — so it is just a checkbox here, never a default indicator. The
 * actual default prompt ids, their canonical order, and the ST-supplied
 * (uneditable content) subset live in utils/preset.js, shared with the
 * viewer.
 *
 * `toggleable` — whether ST lets the user enable/disable it;
 *                null = unknown, treated as allowed in this editor.
 * ST-supplied prompts show a locked panel instead of a textbox (stored
 * text, if any, is preserved verbatim on save but never evaluated by ST).
 * All prompts, default or not, are renameable.
 * ------------------------------------------------------------------ */

const BUILTIN_PROMPTS = Object.freeze({
    worldInfoBefore: { name: "World Info (before)", toggleable: null },
    personaDescription: { name: "Persona Description", toggleable: true },
    charDescription: { name: "Char Description", toggleable: true },
    charPersonality: { name: "Char Personality", toggleable: true },
    scenario: { name: "Scenario", toggleable: true },
    worldInfoAfter: { name: "World Info (after)", toggleable: null },
    dialogueExamples: { name: "Chat Examples", toggleable: true },
    chatHistory: { name: "Chat history", toggleable: false },
    main: { name: "Main Prompt", toggleable: null },
    enhanceDefinitions: { name: "Enhance Definitions", toggleable: true },
    nsfw: { name: "Auxiliary Prompt", toggleable: true },
    jailbreak: { name: "Post-History Instructions", toggleable: true },
});

function isToggleable(id) {
    return BUILTIN_PROMPTS[id]?.toggleable !== false;
}

// ST assigns UUIDs to every new prompt, and the identifier cannot be changed
// there afterwards. This editor still allows editing (except for defaults),
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
        marker: MARKER_PROMPT_IDS.has(identifier),
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

function macroChipTitle(item) {
    if (item.isVariable) {
        const scope = item.variableScope === "global" ? "global" : "local";
        return [
            item.name,
            `${scope === "global" ? "Global" : "Local"} variable shorthand.`,
            "Reads, sets, or updates the variable; the value is resolved at runtime.",
            "New macro engine only (default since ST 1.17.0).",
        ].join("\n");
    }

    const def = getMacroDefinition(item.name);
    const lines = [`{{${item.name}}}`];
    if (def?.description) lines.push(def.description);
    let flag = "";
    if (item.newEngineOnly) flag = "new engine only";
    else if (item.extension) flag = `requires ${item.extension}`;
    else if (item.dynamic) flag = "continue_nudge_prompt only";
    else if (!item.known) flag = "not in the 1.19.0 registry";
    if (flag) lines.push(flag);
    return lines.join("\n");
}

function createMacroChip(item) {
    const chip = el("span", `macro-chip cat-${item.category}`);
    chip.title = macroChipTitle(item);

    if (!item.known) chip.classList.add("is-unknown");
    if (item.comments) chip.classList.add("is-comment");
    if (item.extension) chip.classList.add("is-extension");
    if (item.dynamic) chip.classList.add("is-dynamic");
    if (item.newEngineOnly) chip.classList.add("is-new");

    chip.appendChild(el("span", "macro-dot"));
    chip.appendChild(el("code", "macro-chip-name", item.name));
    chip.appendChild(el("span", "macro-chip-count", `×${item.count}`));

    // Shorthands sit inside a scoped group whose summary carries "new".
    if (item.isVariable) return chip;

    let flag = "";
    if (item.newEngineOnly) flag = "new";
    else if (item.extension) flag = "ext";
    else if (item.dynamic) flag = "dyn";
    else if (!item.known) flag = "?";
    if (flag) chip.appendChild(el("span", "macro-chip-flag", flag));
    return chip;
}

/** Same grouping the viewer uses: one collapsible group per variable scope. */
function createVariableGroup(scope, items) {
    const details = el("details", "macro-var-group");
    const summary = el("summary");

    summary.appendChild(el("span", "macro-dot"));
    summary.appendChild(el("span", "var-group-label",
        scope === "global" ? "global variables" : "local variables"));

    const uses = items.reduce((sum, item) => sum + item.count, 0);
    summary.appendChild(el("span", "var-group-count",
        `${items.length.toLocaleString()} name${items.length === 1 ? "" : "s"}`
        + ` · ${uses.toLocaleString()} use${uses === 1 ? "" : "s"}`));
    summary.appendChild(el("span", "macro-chip-flag", "new"));
    summary.title = scope === "global"
        ? "Global variable shorthands ($name). Click to list the variables in this text."
        : "Local variable shorthands (.name). Click to list the variables in this text.";

    const chips = el("div", "macro-chips var-group-chips");
    for (const item of items) chips.appendChild(createMacroChip(item));

    details.append(summary, chips);
    return details;
}

function renderChips(container, analysis) {
    container.innerHTML = "";
    if (!analysis || analysis.stats.total === 0) return;

    const items = Object.values(analysis.stats.byName)
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const regular = items.filter(item => !item.isVariable);
    if (regular.length > 0) {
        const chips = el("div", "macro-chips");
        for (const item of regular) chips.appendChild(createMacroChip(item));
        container.appendChild(chips);
    }

    const groups = el("div", "macro-var-groups");
    for (const scope of ["local", "global"]) {
        const scoped = (analysis.stats.shorthandVars?.[scope] ?? [])
            .slice()
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        if (scoped.length > 0) groups.appendChild(createVariableGroup(scope, scoped));
    }
    if (groups.children.length > 0) container.appendChild(groups);
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
    activeOrderIndex = findActiveOrderEntry(json.prompt_order).index;
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
    syncFileInput(fileInput, file);
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

    // Defaults are essential: offer one-click repair when any are missing.
    const missingDefaults = DEFAULT_ORDER.filter(id => !prompts.has(id));
    builtinBanner.hidden = missingDefaults.length === 0;
    builtinBanner.innerHTML = "";
    if (missingDefaults.length > 0) {
        builtinBanner.appendChild(el("span", null, `Missing defaults: ${missingDefaults.join(", ")}`));
        const addMissing = el("button", "btn btn-ghost", `Add missing (${missingDefaults.length})`);
        addMissing.type = "button";
        addMissing.addEventListener("click", () => {
            for (const id of missingDefaults) {
                prompts.set(id, builtinPromptObject(id));
                insertOrderEntryAtDefaultPosition(id, true);
            }
            selection = { type: "prompt", key: missingDefaults[0] };
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
            ? "ST does not allow toggling this default prompt."
            : (entry.enabled ? "Enabled in prompt order (click to disable)" : "Disabled in prompt order (click to enable)");
        check.addEventListener("change", () => {
            entry.enabled = check.checked;
            const p = prompts.get(entry.identifier);
            if (p) p.enabled = check.checked;
            markDirty();
            renderSidebar();
            if (selection?.type === "prompt" && selection.key === entry.identifier) renderMain();
            updateStats();
            refreshVariableIndex();
        });

        const btn = el("button", "order-select", name);
        btn.type = "button";
        btn.title = entry.identifier + (isDefaultPromptId(entry.identifier) ? " (ST default)" : "");
        btn.addEventListener("click", () => showDocumentSelection({ type: "prompt", key: entry.identifier }));

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
        btn.addEventListener("click", () => showDocumentSelection({ type: "prompt", key: id }));
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
        btn.addEventListener("click", () => showDocumentSelection({ type: "utility", key }));
        li.appendChild(btn);
        utilityList.appendChild(li);
    }
}

/* ------------------------------------------------------------------ *
 * Variable outline (right panel)
 *
 * The index is preset-wide: a variable set in one prompt and read in
 * another is the whole point. Documents are listed in evaluation order
 * (active order, orphans, utility fields) so site lists read naturally.
 * ------------------------------------------------------------------ */

function promptOutlineNote(identifier, entry) {
    if (isMarkerPromptId(identifier)) return "ignored by ST";
    if (entry && !entry.enabled) return "disabled";
    return "";
}

function outlineDocuments() {
    const docs = [];
    const ordered = new Set(order.map(entry => entry.identifier));

    for (const entry of order) {
        const prompt = prompts.get(entry.identifier);
        if (!prompt) continue;
        docs.push({
            id: prompt.identifier,
            kind: "prompt",
            label: prompt.name || prompt.identifier,
            text: prompt.content ?? "",
            note: promptOutlineNote(prompt.identifier, entry),
        });
    }

    for (const [identifier, prompt] of prompts) {
        if (ordered.has(identifier)) continue;
        docs.push({
            id: identifier,
            kind: "prompt",
            label: prompt.name || identifier,
            text: prompt.content ?? "",
            note: "not in order",
        });
    }

    for (const key of UTILITY_KEYS) {
        if (!(key in utility)) continue;
        const info = getMacroField(key);
        docs.push({
            id: key,
            kind: "utility",
            label: key,
            text: utility[key] ?? "",
            note: info.expanded ? "" : "not expanded by ST",
            expanded: info.expanded,
        });
    }

    return docs;
}

function refreshVariableIndex() {
    variableIndex = collectVariables(outlineDocuments());
    if (outlineSelection && !variableIndex.byKey.has(outlineSelection)) {
        outlineSelection = null;
    }
    renderOutline();
}

function renderOutline() {
    if (!outlineBody) return;

    const variable = outlineSelection ? variableIndex.byKey.get(outlineSelection) : null;
    outlineBody.innerHTML = "";
    outlineBack.hidden = !variable;

    if (variable) {
        outlineTitle.textContent = `${variable.scope === "global" ? "$" : "."}${variable.name}`;
        const sites = variable.writes.length + variable.reads.length;
        outlineCount.textContent = `${sites} ${sites === 1 ? "site" : "sites"}`;
        renderVariableDetail(variable);
        return;
    }

    outlineTitle.textContent = "Variables";
    const total = variableIndex.variables.length;
    outlineCount.textContent = total > 0 ? `· ${total.toLocaleString()}` : "";
    renderVariableList();
}

function renderVariableList() {
    if (variableIndex.variables.length === 0) {
        outlineBody.appendChild(el("p", "macro-note",
            "No variables yet. {{setvar}}, {{getvar}}, {{.local}} and {{$global}} usages in any prompt or utility field show up here."));
        return;
    }

    renderCurrentVariables();

    for (const scope of ["local", "global"]) {
        const scoped = variableIndex.variables.filter(variable => variable.scope === scope);
        if (scoped.length === 0) continue;

        const group = el("div", "outline-group");
        group.appendChild(el("h3", null,
            `${scope === "global" ? "Global" : "Local"} variables (${scoped.length})`));

        const list = el("ul", "outline-list");
        for (const variable of scoped) list.appendChild(createVariableRow(variable));
        group.appendChild(list);
        outlineBody.appendChild(group);
    }
}

/**
 * Variables that occur in the document currently open in the middle pane,
 * with counts limited to that document. Sorted by usage, not by name: this
 * is "what is in front of me", not a directory listing.
 */
function currentDocumentVariables() {
    if (!selection) return null;
    const { type, key } = selection;
    const entries = [];

    for (const variable of variableIndex.variables) {
        const writes = variable.writes.filter(site => site.kind === type && site.id === key);
        const reads = variable.reads.filter(site => site.kind === type && site.id === key);
        if (writes.length + reads.length === 0) continue;
        entries.push({ variable, writes, reads });
    }

    entries.sort((a, b) =>
        (b.writes.length + b.reads.length) - (a.writes.length + a.reads.length)
        || a.variable.name.localeCompare(b.variable.name));
    return entries;
}

function renderCurrentVariables() {
    const entries = currentDocumentVariables();
    if (!entries) return;

    const isUtility = selection.type === "utility";
    const where = isUtility ? "in this field" : "in this prompt";

    const section = el("div", "outline-group outline-current");
    section.appendChild(el("h3", null,
        `${isUtility ? "In this utility field" : "In this prompt"} (${entries.length})`));

    if (entries.length === 0) {
        section.appendChild(el("p", "outline-empty", `No variables ${where}.`));
        outlineBody.appendChild(section);
        return;
    }

    const list = el("ul", "outline-list");
    for (const { variable, writes, reads } of entries) {
        list.appendChild(createVariableRow(variable, writes.length, reads.length, where));
    }
    section.appendChild(list);
    outlineBody.appendChild(section);
}

function createVariableRow(variable, defs = variable.writes.length, refs = variable.reads.length, where = "") {
    const li = el("li");
    const btn = el("button", "outline-var");
    btn.type = "button";

    const prefix = el("span", "var-scope", variable.scope === "global" ? "$" : ".");
    const name = el("span", "var-name", variable.name);
    const counts = el("span", "var-counts",
        `${defs} def${defs === 1 ? "" : "s"} · ${refs} ref${refs === 1 ? "" : "s"}`);

    btn.title = `${variable.scope} variable "${variable.name}" — `
        + `${defs} definition${defs === 1 ? "" : "s"}, ${refs} reference${refs === 1 ? "" : "s"}`
        + `${where ? ` ${where}` : " in this preset"}.`;
    btn.append(prefix, name, counts);
    btn.addEventListener("click", () => {
        outlineSelection = variable.key;
        renderOutline();
    });

    li.appendChild(btn);
    return li;
}

function renderVariableDetail(variable) {
    const defs = variable.writes.length;
    const refs = variable.reads.length;

    outlineBody.appendChild(el("p", "outline-summary",
        `${variable.scope === "global" ? "Global" : "Local"} variable · `
        + `${defs} definition${defs === 1 ? "" : "s"} · `
        + `${refs} reference${refs === 1 ? "" : "s"}`));

    outlineBody.appendChild(createSiteSection("Definitions", variable.writes,
        "No definition in this preset — it may come from ST, an extension, or an earlier chat."));
    outlineBody.appendChild(createSiteSection("References", variable.reads,
        "No references in this preset."));
}

function createSiteSection(title, sites, emptyText) {
    const section = el("section", "outline-section");
    section.appendChild(el("h3", null, `${title} (${sites.length})`));

    if (sites.length === 0) {
        section.appendChild(el("p", "outline-empty", emptyText));
        return section;
    }

    const list = el("ul", "outline-sites");
    for (const site of sites) {
        const li = el("li");
        li.appendChild(createSiteButton(site));
        list.appendChild(li);
    }
    section.appendChild(list);
    return section;
}

function createSiteButton(site) {
    const btn = el("button", "outline-site");
    btn.type = "button";
    btn.title = `${site.label} — L${site.line}:${site.column}. Click to open this prompt and select the macro.`;

    const doc = el("span", "site-doc");
    doc.appendChild(el("span", "site-label", site.label));
    if (site.note) doc.appendChild(el("span", "site-note", site.note));

    const loc = el("span", "site-loc", `L${site.line}:${site.column}`);

    const detail = el("span", "site-detail");
    detail.appendChild(el("code", "site-macro", site.macro));
    // `setvar` / shorthand writes carry a value; show it as an assignment.
    const suffix = site.value
        ? `${site.operator ?? "="} ${site.value}`
        : (site.operator ?? "");
    if (suffix) detail.append(" ", document.createTextNode(suffix));

    btn.append(doc, loc, detail);
    btn.addEventListener("click", () => openVariableSite(site));
    return btn;
}

function openVariableSite(site) {
    selection = site.kind === "utility"
        ? { type: "utility", key: site.id }
        : { type: "prompt", key: site.id };

    renderSidebar();
    renderMain();

    const textarea = site.kind === "utility"
        ? main.querySelector(`textarea[data-field="${CSS.escape(site.id)}"]`)
        : main.querySelector("textarea.ed-textarea");

    if (!textarea) return;

    textarea.focus({ preventScroll: true });
    const end = Math.min(site.end, textarea.value.length);
    textarea.setSelectionRange(Math.min(site.start, end), end);

    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    textarea.scrollTop = Math.max(0, (site.line - 1) * lineHeight - textarea.clientHeight / 2);
}

/**
 * Selecting a document in the sidebar returns the outline to its list view,
 * where the "in this prompt" section describes the new selection.
 */
function showDocumentSelection(next) {
    selection = next;
    outlineSelection = null;
    renderSidebar();
    renderMain();
    renderOutline();
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
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = prompt.name ?? "";
    nameInput.className = "ed-name-input";
    nameInput.spellcheck = false;
    nameInput.setAttribute("aria-label", "Prompt name");
    nameInput.title = "Labels only — ST does not expand macros here.";
    let nameTimer = 0;
    nameInput.addEventListener("input", () => {
        prompt.name = nameInput.value;
        markDirty();
        clearTimeout(nameTimer);
        nameTimer = setTimeout(() => { renderSidebar(); refreshVariableIndex(); }, 300);
        updateStats();
    });
    head.appendChild(nameInput);
    if (!inOrder) head.appendChild(el("span", "badge badge-orphan", "not in order"));
    if (inOrder && !orderEntry.enabled) head.appendChild(el("span", "badge badge-disabled", "disabled"));
    if (prompt.marker) head.appendChild(el("span", "badge badge-marker", "marker"));
    else if (isDefaultPromptId(prompt.identifier)) head.appendChild(el("span", "badge badge-marker", "default"));
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
    delBtn.disabled = isDefaultPromptId(prompt.identifier);
    delBtn.title = isDefaultPromptId(prompt.identifier)
        ? "ST default prompts cannot be deleted."
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

    const idInput = document.createElement("input");
    idInput.type = "text"; idInput.value = prompt.identifier;
    idInput.spellcheck = false;
    idInput.disabled = isDefaultPromptId(prompt.identifier);
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
            hint: isDefaultPromptId(prompt.identifier)
                ? "Locked by ST for default prompts."
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
    const row3 = el("div", "ed-row ed-row-3");
    row3.appendChild(fieldRow("Role", roleSel));

    const posSel = document.createElement("select");
    [["0", "Relative (default)"], ["1", `In-chat @ depth`]].forEach(([v, label]) => {
        const opt = document.createElement("option");
        opt.value = v; opt.textContent = label;
        if (String(prompt.injection_position ?? 0) === v) opt.selected = true;
        posSel.appendChild(opt);
    });
    posSel.addEventListener("change", () => { prompt.injection_position = Number(posSel.value); markDirty(); renderSidebar(); });
    row3.appendChild(fieldRow("Position", posSel, { hint: "0 = relative (default), 1 = in-chat at depth." }));

    const depthInput = document.createElement("input");
    depthInput.type = "number"; depthInput.min = "0"; depthInput.value = prompt.injection_depth ?? 4;
    depthInput.addEventListener("input", () => { prompt.injection_depth = Number(depthInput.value); markDirty(); });
    row3.appendChild(fieldRow("Depth", depthInput, { hint: "In-chat injection depth." }));

    main.appendChild(grid);
    main.appendChild(row3);

    const row2 = el("div", "ed-row ed-row-3");
    row2.appendChild(checkRow("System prompt", !!prompt.system_prompt, v => { prompt.system_prompt = v; markDirty(); }));
    row2.appendChild(checkRow("Forbid overrides", !!prompt.forbid_overrides, v => { prompt.forbid_overrides = v; markDirty(); }));
    row2.appendChild(checkRow("Marker", !!prompt.marker, v => { prompt.marker = v; markDirty(); renderMain(); },
        "ST replaces marker content with runtime data. Freely toggleable — saved to the preset JSON."));
    main.appendChild(row2);

    // ST-supplied content: no textbox, just like ST. Stored text (usually
    // empty) is preserved verbatim on save but never evaluated.
    if (isMarkerPromptId(prompt.identifier)) {
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
        timer = setTimeout(() => { refresh(); refreshVariableIndex(); }, 200);
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
            timer = setTimeout(() => { refresh(); renderSidebar(); updateStats(); refreshVariableIndex(); }, 250);
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
        // Marker is just a label: stored content counts like any other
        // prompt, matching the viewer (both report on the file, not on
        // what ST evaluates at runtime).
        if (!p) continue;
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
    const missingDefaults = DEFAULT_ORDER.filter(id => !prompts.has(id));
    if (missingDefaults.length > 0) parts.push(`missing defaults: ${missingDefaults.join(", ")}`);
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
    if (!has) {
        statsBar.hidden = true;
        variableIndex = { variables: [], byKey: new Map() };
        outlineSelection = null;
        renderOutline();
        return;
    }
    // Structural re-render (load, add, duplicate, delete): go back to the
    // preset-wide list for the document that is now selected.
    outlineSelection = null;
    renderSidebar();
    renderMain();
    updateStats();
    refreshVariableIndex();
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

outlineBack.addEventListener("click", () => {
    outlineSelection = null;
    renderOutline();
});

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
