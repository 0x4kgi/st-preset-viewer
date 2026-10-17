import { downloadMarkdown } from "./utils/markdown.js";
import { extractFilename } from "./utils/download.js";

"use strict";

// keys in the preset that ARE always present no matter what
// the default preset from ST always comes with these keys
// so it's safe to assume
const UTILITY_PROMPTS_KEYS = [
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

const mainContainer = document.getElementById("main");
const loadButton = document.getElementById("load-button");
const fileInput = document.getElementById("file-input");
const fileNameLabel = document.getElementById("file-name");
const markdownExportButton = document.getElementById("markdown-export");
const searchInput = document.getElementById("search-input");
const roleFilter = document.getElementById("role-filter");
const expandAllButton = document.getElementById("expand-all");
const collapseAllButton = document.getElementById("collapse-all");
const statsBar = document.getElementById("stats");
const emptyState = document.getElementById("empty-state");

// identifier: { content, name, role, booleans }
let prompts = {};

// [ { enabled, identifier }, ... ]
let promptOrder = [];

// Single source of truth for the currently loaded file.
// `fileInput.files[0]` goes stale after a drag-and-drop, so every
// entry point (picker, drop, reload, export) goes through this.
let currentFile = null;

function isJsonAPreset(json) {
    const jsonKeys = Object.keys(json);

    return UTILITY_PROMPTS_KEYS.every(key => jsonKeys.includes(key));
}

function makeBadge(text, className = "") {
    const span = document.createElement("span");
    span.className = `badge ${className}`.trim();
    span.textContent = text;
    return span;
}

function createPromptSections(identifier, enabledOverride) {
    const prompt = prompts[identifier];

    if (!prompt) return null;

    const enabled = enabledOverride ?? prompt.enabled;
    const content = prompt.content ?? "";
    const charCount = content.length;

    const elemDetails = document.createElement("details");
    const elemSummary = document.createElement("summary");

    elemDetails.id = `prompt-${identifier}`;

    const nameEl = document.createElement("span");
    nameEl.className = "prompt-name";
    nameEl.textContent = prompt.name || identifier;

    const badgesEl = document.createElement("span");
    badgesEl.className = "badges";
    // "system" is the default role in ST — showing it on every card is just noise.
    if (prompt.role && prompt.role !== "system") {
        badgesEl.appendChild(makeBadge(prompt.role, `badge-role-${prompt.role}`));
    }
    if (!enabled) badgesEl.appendChild(makeBadge("disabled", "badge-disabled"));
    if (prompt.marker) badgesEl.appendChild(makeBadge("builtin", "badge-marker"));
    if (prompt.injection_position > 0) {
        badgesEl.appendChild(makeBadge(`in-chat @${prompt.injection_depth}`, "badge-injected"));
    }

    elemSummary.append(nameEl, badgesEl);
    elemDetails.appendChild(elemSummary);

    const bodyEl = document.createElement("div");
    bodyEl.className = "prompt-body";

    const toolsEl = document.createElement("div");
    toolsEl.className = "prompt-tools";

    const countEl = document.createElement("span");
    countEl.textContent = `${charCount.toLocaleString()} chars - id: ${identifier}`;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(content);
            copyBtn.textContent = "Copied ✓";
        } catch {
            copyBtn.textContent = "Copy failed";
        }
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });

    toolsEl.append(countEl, copyBtn);

    const elemPromptContent = document.createElement("pre");
    elemPromptContent.textContent = content;

    bodyEl.append(toolsEl, elemPromptContent);
    elemDetails.appendChild(bodyEl);

    elemDetails.classList.add(`role-${prompt.role}`);

    if (prompt.marker) {
        elemDetails.classList.add("marker");
    }

    if (prompt.injection_position > 0) {
        elemDetails.classList.add("injected");
    }

    // searchable index for filtering (name + content, lowercased)
    elemDetails.dataset.search = `${prompt.name} ${content}`.toLowerCase();
    elemDetails.dataset.role = prompt.role;

    return elemDetails;
}

function handleFile(file) {
    if (!file) {
        alert("Please select a JSON file.");
        return;
    }

    currentFile = file;

    // Keep the <input> in sync so picker / drop / reload all agree.
    // DataTransfer assignment can throw in some browsers — currentFile
    // remains the source of truth regardless.
    try {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
    } catch {
        /* ignore — currentFile already holds the file */
    }

    fileNameLabel.textContent = file.name || "Selected file";
    resetEverything(false);
    loadPresetFromJson(file);
}

async function loadPresetFromJson(file) {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
        let json;
        try {
            json = JSON.parse(reader.result);
        } catch {
            alert("Could not parse that file as JSON.");
            return;
        }
        if (!isJsonAPreset(json)) {
            alert("The selected file is not a valid preset JSON.");
            return;
        }

        extractPresetData(json);
        displayPrompts();
    });

    reader.readAsText(file);
}

function resetEverything(clearFileLabel = true) {
    mainContainer.innerHTML = "";
    prompts = {};
    promptOrder = [];
    markdownExportButton.setAttribute("disabled", true);
    expandAllButton.setAttribute("disabled", true);
    collapseAllButton.setAttribute("disabled", true);
    statsBar.hidden = true;
    statsBar.textContent = "";
    emptyState.hidden = false;
    if (clearFileLabel) fileNameLabel.textContent = "No file selected";
}

function extractPresetData(json) {
    json["prompts"].forEach(prompt => {
        prompts[prompt.identifier] = {
            content: prompt.content, // string, lots of text
            name: prompt.name, // string
            role: prompt.role, // user, system, assistant
            system_prompt: prompt.system_prompt, // boolean, kind of redundant
            marker: prompt.marker, // boolean, is ST builtin
            enabled: prompt.enabled, // redundant? also specified at prompt_order and that takes priority
            injection_position: prompt.injection_position, // 0 (relative) or 1 (in-chat)
            injection_depth: prompt.injection_depth, // positive? int
            forbid_overrides: prompt.forbid_overrides,
        }
    });

    /**
     * ST loads 100001 as the default, 100000 is kept for legacy reasons,
     * and if both fails, fallback the last prompt_order[] entry.
     */
    const orderEntry =
        json.prompt_order.find(e => String(e.character_id) === '100001')
        ?? json.prompt_order.find(e => String(e.character_id) === '100000')
        ?? json.prompt_order.at(-1);

    orderEntry.order.forEach(i => promptOrder.push(i));

    console.log("prompts:", prompts);
    console.log("prompt_order:", promptOrder);
}

function displayPrompts() {
    mainContainer.innerHTML = "";

    promptOrder.forEach(prompt => {
        const promptElement = createPromptSections(prompt.identifier, prompt.enabled);
        const enabledClass = prompt.enabled ? "prompt-enabled" : "prompt-disabled";

        if (!promptElement) { return; }

        promptElement.classList.add(enabledClass);

        mainContainer.appendChild(promptElement);
    });

    markdownExportButton.removeAttribute("disabled");
    expandAllButton.removeAttribute("disabled");
    collapseAllButton.removeAttribute("disabled");

    updateStats();
    applyFilters();
    updateEmptyState();
}

function updateStats() {
    const total = promptOrder.length;
    const enabledCount = promptOrder.filter(p => p.enabled).length;
    const fileLabel = fileNameLabel.textContent || "preset";

    statsBar.textContent = `${fileLabel} — ${total} prompts, ${enabledCount} enabled`;
    statsBar.hidden = total === 0;
}

function updateEmptyState() {
    emptyState.hidden = mainContainer.children.length > 0;
}

function applyFilters() {
    const query = (searchInput.value || "").trim().toLowerCase();
    const role = roleFilter.value || "all";
    let visible = 0;

    for (const details of mainContainer.children) {
        const matchesQuery = !query || details.dataset.search.includes(query);
        const matchesRole = role === "all" || details.dataset.role === role;
        const show = matchesQuery && matchesRole;
        details.hidden = !show;
        if (show) visible++;
    }

    // show a hint inside stats when filtering hides everything
    if (mainContainer.children.length > 0 && visible === 0) {
        statsBar.hidden = false;
        statsBar.textContent += " — no matches for current filter";
    } else if (mainContainer.children.length > 0) {
        updateStats();
        if (visible !== mainContainer.children.length) {
            statsBar.textContent += ` — showing ${visible}`;
        }
    }
}

function loadJsonFromInputs() {
    // Prefer the picker's file when present (it IS the newest selection
    // in that flow), otherwise fall back to the last dropped file.
    const file = fileInput.files[0] ?? currentFile;

    if (!file) {
        alert("Please select a JSON file.");
        return;
    }

    handleFile(file);
}

loadButton.addEventListener("click", loadJsonFromInputs);
fileInput.addEventListener("change", loadJsonFromInputs);
searchInput.addEventListener("input", applyFilters);
roleFilter.addEventListener("change", applyFilters);

expandAllButton.addEventListener("click", () => {
    mainContainer.querySelectorAll("details:not([hidden])").forEach(d => { d.open = true; });
});

collapseAllButton.addEventListener("click", () => {
    mainContainer.querySelectorAll("details").forEach(d => { d.open = false; });
});

markdownExportButton.addEventListener("click", () => {
    const rawName = currentFile?.name ?? fileInput.files[0]?.name ?? extractFilename(fileInput.value);
    const presetName = (rawName || "preset").replace(/\.json$/i, "");
    downloadMarkdown(presetName, prompts, promptOrder);
});

// Drag & drop anywhere on the page
document.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
});

document.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) document.body.classList.remove("dragging");
});

document.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
});
