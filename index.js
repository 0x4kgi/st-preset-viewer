import { downloadMarkdown } from "./utils/markdown.js";
import { extractFilename } from "./utils/download.js";
import {
    MACRO_CATEGORIES,
    analyzeMacros,
    availabilityLabel,
    getMacroDefinition,
    getMacroField,
} from "./utils/macros.js";
import {
    MACRO_FIELD_KEY_SET,
    MACRO_FIELD_KEYS,
    OPTIONAL_MACRO_FIELD_KEYS,
    STRUCTURAL_KEYS,
    findActiveOrderEntry,
    isJsonAPreset,
    syncFileInput,
} from "./utils/preset.js";

"use strict";

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

// [ { enabled, identifier }, ... ] — the active prompt_order entry
let promptOrder = [];

// prompts that exist in `prompts` but are absent from the active order
let orphanPrompts = [];

// key: string content for the plain-text utility prompts
let utilityPrompts = {};

// everything else in the file (samplers, models, toggles, ...)
let restJson = {};

// Macro analysis, one independent document per prompt entry / utility field.
let promptAnalyses = new Map();
let utilityAnalyses = new Map();

// Aggregate counts for the active fields (for the stats bar / legend).
let macroTotals = {
    active: 0,
    disabled: 0,
    names: 0,
    literal: 0,
    comments: 0,
    errors: 0,
    warnings: 0,
    newEngineOnly: 0,
    unknown: 0,
    extension: 0,
    dynamic: 0,
    categories: Object.create(null),
};

// which prompt_order entry we actually rendered (100001 > 100000 > last)
let activeOrderCharacterId = null;

// Single source of truth for the currently loaded file.
// `fileInput.files[0]` goes stale after a drag-and-drop, so every
// entry point (picker, drop, reload, export) goes through this.
let currentFile = null;

function makeBadge(text, className = "") {
    const span = document.createElement("span");
    span.className = `badge ${className}`.trim();
    span.textContent = text;
    return span;
}

function formatCount(value) {
    return Number(value || 0).toLocaleString();
}

function plural(value, singular, pluralForm = `${singular}s`) {
    return value === 1 ? singular : pluralForm;
}

function createMacroBadgeGroup(analysis, enabled) {
    const frag = document.createDocumentFragment();
    if (!analysis) return frag;

    const { total, comments, errors, warnings } = analysis.stats;

    if (total > 0) {
        const badge = makeBadge(
            `${formatCount(total)} ${plural(total, "macro")}`,
            "badge-macro",
        );
        badge.title = `${formatCount(total)} macro invocation${total === 1 ? "" : "s"} in this field`
            + (comments ? `, ${formatCount(comments)} comment${comments === 1 ? "" : "s"}` : "")
            + (enabled ? "" : " (not evaluated)");
        if (!enabled) badge.classList.add("badge-macro-muted");
        frag.appendChild(badge);
    }

    if (!analysis.expanded) {
        const badge = makeBadge("not expanded", "badge-literal");
        badge.title = "SillyTavern does not macro-expand this field.";
        frag.appendChild(badge);
    }

    if (errors > 0) {
        const badge = makeBadge(
            `${formatCount(errors)} ${plural(errors, "error")}`,
            "badge-error",
        );
        badge.title = "These macros cannot resolve as written.";
        frag.appendChild(badge);
    } else if (warnings > 0) {
        const badge = makeBadge(
            `${formatCount(warnings)} ${plural(warnings, "warning")}`,
            "badge-warn",
        );
        badge.title = "These macros resolve only in a specific engine, field, or extension.";
        frag.appendChild(badge);
    }

    return frag;
}

function macroTitle(macro, expanded) {
    const lines = [];

    if (macro.malformed) {
        lines.push(macro.malformed.message);
    } else if (macro.isComment) {
        lines.push("Comment. Removed from the output.");
    } else if (macro.isVariable) {
        lines.push(`Variable shorthand (${macro.variable?.scope ?? "local"}).`);
    } else if (macro.isClosing) {
        lines.push(`Closing tag for {{${macro.name}}}.`);
    } else {
        lines.push(macro.name ? `{{${macro.name}}}` : "Malformed macro.");
    }

    const category = MACRO_CATEGORIES[macro.category];
    if (category) lines.push(category.label);

    const def = getMacroDefinition(macro.name);
    if (def && !macro.malformed) {
        lines.push(availabilityLabel(def));
        if (def.description) lines.push(def.description);
    }

    if (macro.known && macro.availability === "ext") {
        lines.push(`Only works when ${macro.extension} is loaded and enabled.`);
    }

    if (macro.dynamic) {
        lines.push("Supplied only for continue_nudge_prompt.");
    }

    if (macro.newEngineOnly) {
        lines.push("New macro engine only (default since ST 1.17.0).");
    }

    if (macro.scope?.role === "open") {
        lines.push(`Scoped block; pairs with {{/${macro.name}}}.`);
    }

    if (!expanded) {
        lines.push("This field is not macro-expanded by ST; the text stays literal.");
    }

    return lines.join("\n");
}

function createMacroSpan(macro, expanded) {
    const span = document.createElement("span");
    span.className = `macro-hl cat-${macro.category}`;

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
    span.dataset.macroName = macro.lowerName || "";

    return span;
}

function createHighlightedContent(text, analysis, { expanded = true } = {}) {
    const pre = document.createElement("pre");
    pre.className = "prompt-content";

    if (!analysis || !Array.isArray(analysis.segments) || analysis.segments.length === 0) {
        pre.textContent = text;
        return pre;
    }

    for (const segment of analysis.segments) {
        if (segment.type === "text") {
            pre.appendChild(document.createTextNode(segment.text));
        } else {
            pre.appendChild(createMacroSpan(segment.macro, expanded));
        }
    }

    return pre;
}

function compactPreview(value, limit = 160) {
    const compact = String(value ?? "").replace(/\s+/g, " ").trim();
    return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function macroChipTitle(item) {
    const def = getMacroDefinition(item.name);
    const lines = [`{{${item.name}}}`];
    const category = MACRO_CATEGORIES[item.category];
    if (category) lines.push(category.label);

    if (def) {
        lines.push(availabilityLabel(def));
        if (def.description) lines.push(def.description);
    } else if (!item.known) {
        lines.push("Unknown in the 1.19.0 registry; ST leaves it literal unless an extension registers it.");
    }

    if (item.extension) lines.push(`Requires ${item.extension}.`);
    if (item.dynamic) lines.push("Supplied only for continue_nudge_prompt.");
    if (item.newEngineOnly) lines.push("New macro engine only (default since ST 1.17.0).");
    if (item.comments) lines.push(`${item.comments} comment${item.comments === 1 ? "" : "s"}.`);

    return lines.join("\n");
}

function createMacroChip(item) {
    const chip = document.createElement("span");
    chip.className = `macro-chip cat-${item.category}`;
    chip.title = macroChipTitle(item);

    if (!item.known) chip.classList.add("is-unknown");
    if (item.comments) chip.classList.add("is-comment");
    if (item.extension) chip.classList.add("is-extension");
    if (item.dynamic) chip.classList.add("is-dynamic");
    if (item.newEngineOnly) chip.classList.add("is-new");

    const dot = document.createElement("span");
    dot.className = "macro-dot";

    const name = document.createElement("code");
    name.className = "macro-chip-name";
    name.textContent = item.name;

    const count = document.createElement("span");
    count.className = "macro-chip-count";
    count.textContent = `×${formatCount(item.count)}`;

    chip.append(dot, name, count);

    if (item.newEngineOnly) {
        const flag = document.createElement("span");
        flag.className = "macro-chip-flag";
        flag.textContent = "new";
        chip.appendChild(flag);
    } else if (item.extension) {
        const flag = document.createElement("span");
        flag.className = "macro-chip-flag";
        flag.textContent = "ext";
        chip.appendChild(flag);
    } else if (item.dynamic) {
        const flag = document.createElement("span");
        flag.className = "macro-chip-flag";
        flag.textContent = "dyn";
        chip.appendChild(flag);
    } else if (!item.known) {
        const flag = document.createElement("span");
        flag.className = "macro-chip-flag";
        flag.textContent = "?";
        chip.appendChild(flag);
    }

    return chip;
}

function appendTextWithCode(parent, text) {
    const parts = String(text).split("`");
    parts.forEach((part, index) => {
        if (index % 2 === 1) {
            const code = document.createElement("code");
            code.textContent = part;
            parent.appendChild(code);
        } else if (part) {
            parent.appendChild(document.createTextNode(part));
        }
    });
}

function createIssueItem(issue) {
    const li = document.createElement("li");
    li.className = `macro-issue issue-${issue.severity}`;
    li.title = issue.message;

    const severity = document.createElement("span");
    severity.className = "issue-severity";
    severity.textContent = issue.severity;

    const location = document.createElement("span");
    location.className = "issue-location";
    location.textContent = issue.line ? `L${issue.line}:${issue.column}` : "";

    const message = document.createElement("span");
    message.className = "issue-message";
    appendTextWithCode(message, issue.message);

    li.append(severity, location, message);
    return li;
}

function createConditionalBlock(conditional, text) {
    const details = document.createElement("details");
    details.className = "macro-block";

    const summary = document.createElement("summary");
    const kind = document.createElement("span");
    kind.className = "block-kind";
    kind.textContent = conditional.mode === "block" ? "if block" : "if inline";

    const condition = document.createElement("code");
    condition.className = "block-condition";
    condition.textContent = conditional.condition?.trim() || "(no condition)";

    const meta = document.createElement("span");
    meta.className = "block-meta";
    meta.textContent = conditional.mode === "block"
        ? `${conditional.pair.branches.length} branch${conditional.pair.branches.length === 1 ? "" : "es"}`
        : "then →";

    summary.append(kind, condition, meta);
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "block-branches";

    if (conditional.mode === "block") {
        for (const branch of conditional.pair.branches) {
            const value = text.slice(branch.start, branch.end);
            const row = document.createElement("div");
            row.className = "block-branch";

            const label = document.createElement("span");
            label.className = "branch-label";
            label.textContent = branch.kind;

            const size = document.createElement("span");
            size.className = "branch-size";
            size.textContent = `${formatCount(value.length)} chars`;

            const preview = document.createElement("pre");
            preview.className = "branch-preview";
            preview.textContent = compactPreview(value);

            row.append(label, size, preview);
            body.appendChild(row);
        }
    } else {
        const row = document.createElement("div");
        row.className = "block-branch";

        const label = document.createElement("span");
        label.className = "branch-label";
        label.textContent = "then";

        const preview = document.createElement("pre");
        preview.className = "branch-preview";
        preview.textContent = compactPreview(conditional.then);

        row.append(label, preview);
        body.appendChild(row);
    }

    details.appendChild(body);
    return details;
}

function createMacroPanel(analysis, options = {}) {
    if (!analysis || (analysis.stats.total === 0 && !options.nameMacroCount)) return null;

    const {
        enabled = true,
        inOrder = true,
        marker = false,
        fieldInfo = null,
        nameMacroCount = 0,
    } = options;

    const panel = document.createElement("div");
    panel.className = "macro-panel";
    if (!enabled || !inOrder) panel.classList.add("macro-panel-muted");

    const head = document.createElement("div");
    head.className = "macro-head";

    const title = document.createElement("span");
    title.className = "macro-title";
    title.textContent = "Macros ";

    const total = document.createElement("span");
    total.className = "macro-total";
    total.textContent = formatCount(analysis.stats.total);
    title.appendChild(total);

    const meta = document.createElement("span");
    meta.className = "macro-meta";

    const metaBits = [];
    if (analysis.stats.names.length) {
        metaBits.push(`${analysis.stats.names.length} ${plural(analysis.stats.names.length, "name")}`);
    }
    if (analysis.stats.comments) {
        metaBits.push(`${formatCount(analysis.stats.comments)} ${plural(analysis.stats.comments, "comment")}`);
    }
    if (analysis.scopes.length) {
        metaBits.push(`${analysis.scopes.length} ${plural(analysis.scopes.length, "block")}`);
    }
    meta.textContent = metaBits.join(" · ");

    head.append(title, meta);
    panel.appendChild(head);

    const notes = [];
    if (!inOrder) {
        notes.push("This prompt is not in the active prompt_order, so ST does not evaluate it.");
    } else if (!enabled) {
        notes.push("This entry is disabled in the active prompt order, so these macros do not run.");
    }
    if (marker) {
        notes.push("Marker prompt: its content is evaluated, but ST replaces the output with runtime data.");
    }
    if (fieldInfo?.note) {
        notes.push(fieldInfo.note);
    }
    if (nameMacroCount > 0) {
        notes.push("The prompt name contains macro-like text, but ST does not expand prompt names.");
    }
    if (analysis.allMacros.length > analysis.macros.length) {
        notes.push("Nested invocations inside arguments or comments are counted here but not highlighted separately.");
    }

    for (const note of notes) {
        const p = document.createElement("p");
        p.className = "macro-note";
        p.textContent = note;
        panel.appendChild(p);
    }

    if (analysis.issues.length > 0) {
        const list = document.createElement("ul");
        list.className = "macro-issues";
        for (const issue of analysis.issues) {
            list.appendChild(createIssueItem(issue));
        }
        panel.appendChild(list);
    }

    if (analysis.stats.total > 0) {
        const chips = document.createElement("div");
        chips.className = "macro-chips";
        const items = Object.values(analysis.stats.byName)
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        for (const item of items) chips.appendChild(createMacroChip(item));
        panel.appendChild(chips);
    }

    if (analysis.conditionals.length > 0) {
        const blocks = document.createElement("div");
        blocks.className = "macro-blocks";
        for (const conditional of analysis.conditionals) {
            blocks.appendChild(createConditionalBlock(conditional, analysis.text));
        }
        panel.appendChild(blocks);
    }

    return panel;
}

function renderLegend() {
    const slot = document.getElementById("macro-legend-slot");
    if (!slot) return;

    slot.innerHTML = "";
    slot.hidden = true;

    const entries = Object.entries(macroTotals.categories)
        .filter(([category]) => MACRO_CATEGORIES[category])
        .sort((a, b) => b[1] - a[1]);

    if (entries.length === 0) return;

    const details = document.createElement("details");
    details.className = "macro-legend";

    const summary = document.createElement("summary");
    summary.textContent = `Macro legend · ${entries.length} ${plural(entries.length, "category", "categories")}`;
    details.appendChild(summary);

    const items = document.createElement("div");
    items.className = "legend-items";

    for (const [category, count] of entries) {
        const item = document.createElement("span");
        item.className = `legend-item cat-${category}`;

        const dot = document.createElement("span");
        dot.className = "legend-dot";

        const label = document.createElement("span");
        label.textContent = MACRO_CATEGORIES[category].label;

        const total = document.createElement("span");
        total.className = "legend-count";
        total.textContent = formatCount(count);

        item.append(dot, label, total);
        items.appendChild(item);
    }

    details.appendChild(items);

    const note = document.createElement("p");
    note.className = "legend-note";
    note.textContent = "new = new engine only · ext = requires an extension · ? = unknown · comments are counted but muted";
    details.appendChild(note);

    slot.appendChild(details);
    slot.hidden = false;
}

function createPromptSections(identifier, enabledOverride, options = {}) {
    const prompt = prompts[identifier];

    if (!prompt) return null;

    const { inOrder = true } = options;
    const enabled = enabledOverride ?? prompt.enabled;
    const content = prompt.content ?? "";
    const charCount = content.length;
    const analysis = promptAnalyses.get(identifier) ?? null;

    const elemDetails = document.createElement("details");
    const elemSummary = document.createElement("summary");

    elemDetails.id = `prompt-${identifier}`;

    const nameEl = document.createElement("span");
    nameEl.className = "prompt-name";
    nameEl.textContent = prompt.name || identifier;
    if (analysis?.stats.total) {
        nameEl.title = `${prompt.name || identifier} — ${formatCount(analysis.stats.total)} macro invocation${analysis.stats.total === 1 ? "" : "s"}`;
    }

    const badgesEl = document.createElement("span");
    badgesEl.className = "badges";
    // "system" is the default role in ST — showing it on every card is just noise.
    if (prompt.role && prompt.role !== "system") {
        badgesEl.appendChild(makeBadge(prompt.role, `badge-role-${prompt.role}`));
    }
    if (!inOrder) {
        badgesEl.appendChild(makeBadge("not in order", "badge-orphan"));
    } else if (!enabled) {
        badgesEl.appendChild(makeBadge("disabled", "badge-disabled"));
    }
    if (prompt.marker) badgesEl.appendChild(makeBadge("builtin", "badge-marker"));
    if (prompt.injection_position > 0) {
        badgesEl.appendChild(makeBadge(`in-chat @${prompt.injection_depth}`, "badge-injected"));
    }
    badgesEl.appendChild(createMacroBadgeGroup(analysis, enabled && inOrder));

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

    const macroPanel = createMacroPanel(analysis, {
        enabled,
        inOrder,
        marker: !!prompt.marker,
        nameMacroCount: prompt.nameMacroCount ?? 0,
    });

    const elemPromptContent = createHighlightedContent(content, analysis, {
        expanded: analysis?.expanded !== false,
    });

    bodyEl.append(toolsEl);
    if (macroPanel) bodyEl.append(macroPanel);
    bodyEl.append(elemPromptContent);
    elemDetails.appendChild(bodyEl);

    elemDetails.classList.add(`role-${prompt.role}`);

    if (prompt.marker) {
        elemDetails.classList.add("marker");
    }

    if (prompt.injection_position > 0) {
        elemDetails.classList.add("injected");
    }

    if (!inOrder) {
        elemDetails.classList.add("prompt-orphan");
    }

    // searchable index for filtering (name + content + macro names)
    const macroSearch = analysis ? analysis.stats.names.join(" ") : "";
    elemDetails.dataset.search = `${prompt.name} ${content} ${macroSearch}`.toLowerCase();
    elemDetails.dataset.role = prompt.role;
    elemDetails.classList.add("prompt-card");

    return elemDetails;
}

function createUtilityPromptDetails(key, value) {
    const content = value ?? "";
    const charCount = content.length;
    const fieldInfo = getMacroField(key);
    const analysis = utilityAnalyses.get(key) ?? null;

    const elemDetails = document.createElement("details");
    elemDetails.classList.add("prompt-card", "utility-prompt");
    elemDetails.id = `utility-${key}`;

    const elemSummary = document.createElement("summary");
    const nameEl = document.createElement("span");
    nameEl.className = "prompt-name";
    nameEl.textContent = key;
    elemSummary.appendChild(nameEl);

    const badgesEl = document.createElement("span");
    badgesEl.className = "badges";
    badgesEl.appendChild(createMacroBadgeGroup(analysis, fieldInfo.expanded));
    elemSummary.appendChild(badgesEl);
    elemDetails.appendChild(elemSummary);

    const bodyEl = document.createElement("div");
    bodyEl.className = "prompt-body";

    const toolsEl = document.createElement("div");
    toolsEl.className = "prompt-tools";

    const countEl = document.createElement("span");
    countEl.textContent = `${charCount.toLocaleString()} chars`;

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

    const macroPanel = createMacroPanel(analysis, {
        enabled: true,
        inOrder: true,
        fieldInfo,
    });

    const elemContent = createHighlightedContent(content, analysis, {
        expanded: fieldInfo.expanded,
    });

    bodyEl.append(toolsEl);
    if (macroPanel) bodyEl.append(macroPanel);
    bodyEl.append(elemContent);
    elemDetails.appendChild(bodyEl);

    // searchable index for filtering (key + content + macro names)
    const macroSearch = analysis ? analysis.stats.names.join(" ") : "";
    elemDetails.dataset.search = `${key} ${content} ${macroSearch}`.toLowerCase();
    elemDetails.dataset.role = "all";

    return elemDetails;
}

function createUtilityPromptsSection() {
    const keys = Object.keys(utilityPrompts);
    if (keys.length === 0) return null;

    const outer = document.createElement("details");
    outer.id = "utility-prompts";
    outer.classList.add("utility-group");
    outer.dataset.nofilter = "true";

    const summary = document.createElement("summary");
    const nameEl = document.createElement("span");
    nameEl.className = "prompt-name";
    nameEl.textContent = `Utility Prompts (${keys.length})`;
    const badgesEl = document.createElement("span");
    badgesEl.className = "badges";
    const macroCount = [...utilityAnalyses.entries()]
        .filter(([key]) => getMacroField(key).expanded)
        .reduce((sum, [, analysis]) => sum + analysis.stats.total, 0);
    if (macroCount > 0) {
        badgesEl.appendChild(makeBadge(`${formatCount(macroCount)} macros`, "badge-macro"));
    }
    badgesEl.appendChild(makeBadge("default", "badge-marker"));
    summary.append(nameEl, badgesEl);
    outer.appendChild(summary);

    const bodyEl = document.createElement("div");
    bodyEl.className = "utility-list";
    keys.forEach(key => bodyEl.appendChild(createUtilityPromptDetails(key, utilityPrompts[key])));
    outer.appendChild(bodyEl);

    return outer;
}

function createOrphanPromptsSection() {
    if (orphanPrompts.length === 0) return null;

    const outer = document.createElement("details");
    outer.id = "orphan-prompts";
    outer.classList.add("utility-group", "orphan-group");
    outer.dataset.nofilter = "true";

    const summary = document.createElement("summary");
    const nameEl = document.createElement("span");
    nameEl.className = "prompt-name";
    nameEl.textContent = `Prompts not in active order (${orphanPrompts.length})`;
    const badgesEl = document.createElement("span");
    badgesEl.className = "badges";
    badgesEl.appendChild(makeBadge("not evaluated", "badge-orphan"));
    summary.append(nameEl, badgesEl);
    outer.appendChild(summary);

    const bodyEl = document.createElement("div");
    bodyEl.className = "utility-list";
    orphanPrompts.forEach(prompt => {
        bodyEl.appendChild(createPromptSections(prompt.identifier, false, { inOrder: false }));
    });
    outer.appendChild(bodyEl);

    return outer;
}

function createRawJsonSection() {
    const keys = Object.keys(restJson);
    if (keys.length === 0) return null;

    const divider = document.createElement("hr");
    divider.className = "section-divider";
    divider.dataset.nofilter = "true";

    const rawText = JSON.stringify(restJson, null, 2);

    const outer = document.createElement("details");
    outer.id = "raw-json";
    outer.classList.add("raw-group");
    outer.dataset.nofilter = "true";

    const summary = document.createElement("summary");
    const nameEl = document.createElement("span");
    nameEl.className = "prompt-name";
    nameEl.textContent = `Rest of preset (${keys.length} settings)`;
    const badgesEl = document.createElement("span");
    badgesEl.className = "badges";
    badgesEl.appendChild(makeBadge("raw json", "badge-marker"));
    summary.append(nameEl, badgesEl);
    outer.appendChild(summary);

    const bodyEl = document.createElement("div");
    bodyEl.className = "prompt-body";

    const toolsEl = document.createElement("div");
    toolsEl.className = "prompt-tools";

    const countEl = document.createElement("span");
    countEl.textContent = `${rawText.length.toLocaleString()} chars - indent 2`;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(rawText);
            copyBtn.textContent = "Copied ✓";
        } catch {
            copyBtn.textContent = "Copy failed";
        }
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });

    toolsEl.append(countEl, copyBtn);

    const elemContent = document.createElement("pre");
    elemContent.textContent = rawText;

    bodyEl.append(toolsEl, elemContent);
    outer.appendChild(bodyEl);

    const frag = document.createDocumentFragment();
    frag.append(divider, outer);
    return frag;
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
    syncFileInput(fileInput, file);

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

function resetMacroTotals() {
    return {
        active: 0,
        disabled: 0,
        names: 0,
        literal: 0,
        comments: 0,
        errors: 0,
        warnings: 0,
        newEngineOnly: 0,
        unknown: 0,
        extension: 0,
        dynamic: 0,
        categories: Object.create(null),
    };
}

function resetEverything(clearFileLabel = true) {
    mainContainer.innerHTML = "";
    prompts = {};
    promptOrder = [];
    orphanPrompts = [];
    utilityPrompts = {};
    restJson = {};
    promptAnalyses = new Map();
    utilityAnalyses = new Map();
    macroTotals = resetMacroTotals();
    activeOrderCharacterId = null;
    markdownExportButton.setAttribute("disabled", true);
    expandAllButton.setAttribute("disabled", true);
    collapseAllButton.setAttribute("disabled", true);
    statsBar.hidden = true;
    statsBar.textContent = "";
    statsBar.title = "";

    const legendSlot = document.getElementById("macro-legend-slot");
    if (legendSlot) {
        legendSlot.innerHTML = "";
        legendSlot.hidden = true;
    }

    emptyState.hidden = false;
    if (clearFileLabel) fileNameLabel.textContent = "No file selected";
}

function addActiveMacroTotals(analysis) {
    const stats = analysis.stats;
    macroTotals.active += stats.total;
    macroTotals.comments += stats.comments;
    macroTotals.errors += stats.errors;
    macroTotals.warnings += stats.warnings;
    macroTotals.newEngineOnly += stats.newEngineOnly;
    macroTotals.unknown += stats.unknown;
    macroTotals.extension += stats.extension;
    macroTotals.dynamic += stats.dynamic;

    for (const [category, count] of Object.entries(stats.categories)) {
        macroTotals.categories[category] = (macroTotals.categories[category] ?? 0) + count;
    }
}

function computeMacroAnalyses() {
    promptAnalyses = new Map();
    utilityAnalyses = new Map();
    macroTotals = resetMacroTotals();

    // Ordered prompts: `prompt_order[].enabled` is what ST evaluates, not
    // the prompt object's own `enabled` field.
    for (const item of promptOrder) {
        const prompt = prompts[item.identifier];
        if (!prompt) continue;

        const analysis = analyzeMacros(prompt.content ?? "", {
            kind: "prompt",
            enabled: item.enabled,
        });
        promptAnalyses.set(item.identifier, analysis);

        if (item.enabled) {
            addActiveMacroTotals(analysis);
        } else {
            macroTotals.disabled += analysis.stats.total;
        }
    }

    // Prompts absent from the active order are never evaluated, even if their
    // own `enabled` flag is true. Keep them visible; count them as not run.
    for (const prompt of orphanPrompts) {
        const analysis = analyzeMacros(prompt.content ?? "", {
            kind: "prompt",
            enabled: false,
        });
        promptAnalyses.set(prompt.identifier, analysis);
        macroTotals.disabled += analysis.stats.total;
    }

    // Prompt names are labels, not substitution targets.
    for (const prompt of Object.values(prompts)) {
        prompt.nameMacroCount = 0;
        if (typeof prompt.name === "string" && prompt.name.includes("{{")) {
            const nameAnalysis = analyzeMacros(prompt.name, {
                kind: "name",
                expanded: false,
            });
            prompt.nameMacroCount = nameAnalysis.stats.total;
            macroTotals.names += nameAnalysis.stats.total;
        }
    }

    // Utility fields are separate documents too.
    for (const [key, value] of Object.entries(utilityPrompts)) {
        const fieldInfo = getMacroField(key);
        const analysis = analyzeMacros(value ?? "", {
            kind: "utility",
            field: key,
            expanded: fieldInfo.expanded,
        });
        utilityAnalyses.set(key, analysis);

        if (fieldInfo.expanded) {
            addActiveMacroTotals(analysis);
        } else {
            macroTotals.literal += analysis.stats.total;
        }
    }
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
            nameMacroCount: 0,
        }
    });

    /**
     * ST loads 100001 as the default, 100000 is kept for legacy reasons,
     * and if both fails, fallback the last prompt_order[] entry.
     */
    const { entry: orderEntry } = findActiveOrderEntry(json.prompt_order);

    if (orderEntry?.order) {
        orderEntry.order.forEach(i => promptOrder.push(i));
        activeOrderCharacterId = orderEntry.character_id ?? null;
    }

    const orderedIds = new Set(promptOrder.map(item => item.identifier));
    orphanPrompts = json.prompts.filter(prompt => !orderedIds.has(prompt.identifier));

    // Plain-text utility prompts. Base fields show even when empty; optional
    // fields only when the preset actually carries text.
    MACRO_FIELD_KEYS.forEach(key => {
        const value = json[key];
        if (OPTIONAL_MACRO_FIELD_KEYS.has(key) && (typeof value !== "string" || value.length === 0)) {
            return;
        }
        utilityPrompts[key] = typeof value === "string" ? value : (value ?? "");
    });

    // the rest of the file (samplers, models, toggles, ...) verbatim
    restJson = {};
    Object.keys(json).forEach(key => {
        if (STRUCTURAL_KEYS.has(key) || MACRO_FIELD_KEY_SET.has(key)) return;
        restJson[key] = json[key];
    });

    computeMacroAnalyses();
}

function displayPrompts() {
    mainContainer.innerHTML = "";

    const utilitySection = createUtilityPromptsSection();
    if (utilitySection) mainContainer.appendChild(utilitySection);

    promptOrder.forEach(prompt => {
        const promptElement = createPromptSections(prompt.identifier, prompt.enabled);
        const enabledClass = prompt.enabled ? "prompt-enabled" : "prompt-disabled";

        if (!promptElement) { return; }

        promptElement.classList.add(enabledClass);

        mainContainer.appendChild(promptElement);
    });

    const orphanSection = createOrphanPromptsSection();
    if (orphanSection) mainContainer.appendChild(orphanSection);

    const rawSection = createRawJsonSection();
    if (rawSection) mainContainer.appendChild(rawSection);

    markdownExportButton.removeAttribute("disabled");
    expandAllButton.removeAttribute("disabled");
    collapseAllButton.removeAttribute("disabled");

    updateStats();
    renderLegend();
    applyFilters();
    updateEmptyState();
}

function updateStats() {
    const total = promptOrder.length;
    const enabledCount = promptOrder.filter(p => p.enabled).length;
    const fileLabel = fileNameLabel.textContent || "preset";
    const parts = [`${fileLabel} — ${total} prompts, ${enabledCount} enabled`];

    if (orphanPrompts.length > 0) {
        parts.push(`${orphanPrompts.length} not in order`);
    }

    if (macroTotals.active > 0) {
        let macroPart = `${formatCount(macroTotals.active)} macros in active fields`;
        if (macroTotals.comments > 0) {
            macroPart += ` (${formatCount(macroTotals.comments)} comments)`;
        }
        parts.push(macroPart);
    }

    if (macroTotals.errors > 0) {
        parts.push(`${formatCount(macroTotals.errors)} active ${plural(macroTotals.errors, "error")}`);
    }
    if (macroTotals.warnings > 0) {
        parts.push(`${formatCount(macroTotals.warnings)} active ${plural(macroTotals.warnings, "warning")}`);
    }
    if (macroTotals.disabled > 0) {
        parts.push(`${formatCount(macroTotals.disabled)} not evaluated`);
    }
    if (macroTotals.names > 0) {
        parts.push(`${formatCount(macroTotals.names)} in prompt names`);
    }
    if (macroTotals.literal > 0) {
        parts.push(`${formatCount(macroTotals.literal)} in literal fields`);
    }

    statsBar.textContent = parts.join(" · ");
    statsBar.hidden = total === 0 && orphanPrompts.length === 0;
    statsBar.title = [
        "Active fields = enabled prompt content plus macro-expanded utility fields.",
        "Disabled entries and prompts absent from the active prompt_order are shown but not counted as active.",
        "Counts are source invocations, not generated tokens or a claim about what the model sees.",
    ].join("\n");
}

function updateEmptyState() {
    emptyState.hidden = mainContainer.children.length > 0;
}

function applyFilters() {
    const query = (searchInput.value || "").trim().toLowerCase();
    const role = roleFilter.value || "all";
    let visible = 0;
    let nestedVisible = 0;

    let total = 0;

    for (const child of mainContainer.children) {
        if (child.id === "utility-prompts" || child.id === "orphan-prompts") {
            let innerVisible = 0;
            const selector = child.id === "utility-prompts" ? ".utility-prompt" : ".prompt-card";
            const filtered = query !== "" || role !== "all";

            for (const d of child.querySelectorAll(selector)) {
                const hay = d.dataset.search || "";
                const matchesQuery = !query || hay.includes(query);
                const matchesRole = role === "all"
                    || d.dataset.role === role
                    || d.dataset.role === "all";
                const show = matchesQuery && matchesRole;
                d.hidden = !show;
                if (show) innerVisible++;
            }

            child.hidden = filtered && innerVisible === 0;
            if (filtered && innerVisible > 0) child.open = true;
            nestedVisible += innerVisible;
            continue;
        }

        if (child.dataset.nofilter === "true" || child.id === "raw-json") continue;

        total++;
        const hay = child.dataset.search || "";
        const matchesQuery = !query || hay.includes(query);
        const matchesRole = role === "all" || child.dataset.role === role;
        const show = matchesQuery && matchesRole;
        child.hidden = !show;
        if (show) visible++;
    }

    // show a hint inside stats when filtering hides everything
    if (total > 0 && visible === 0 && nestedVisible === 0) {
        statsBar.hidden = false;
        statsBar.textContent += " — no matches for current filter";
    } else if (total > 0) {
        updateStats();
        if (visible !== total) {
            const grouped = nestedVisible > 0 ? ` + ${nestedVisible} nested` : "";
            statsBar.textContent += ` — showing ${visible}${grouped}`;
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
