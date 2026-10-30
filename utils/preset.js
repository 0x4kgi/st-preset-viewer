"use strict";

/**
 * Shared preset contract for the viewer (index.js) and the editor (editor.js).
 *
 * Pure module: no DOM access except syncFileInput(), which only touches the
 * file <input> it is given. Everything here is verbatim shared logic that
 * previously lived in both entry files.
 */

// Keys that every ST OpenAI preset carries. These are only the signature;
// they are not all macro-expanded (see MACRO_FIELD_KEYS below).
export const PRESET_SIGNATURE_KEYS = [
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

// Fields ST actually passes through substituteParams(), in display order.
// `wi_format` is deliberately last: it is the one "macro-looking" field that
// ST does not expand.
export const MACRO_FIELD_KEYS = [
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

// Same list under the editor's name (it calls these "utility fields").
export const UTILITY_KEYS = MACRO_FIELD_KEYS;

// Optional fields are only shown when the preset actually carries text for
// them; the base fields are shown even when empty, as before.
export const OPTIONAL_MACRO_FIELD_KEYS = new Set([
    "assistant_prefill",
    "assistant_impersonation",
    "custom_include_body",
    "custom_exclude_body",
    "custom_include_headers",
]);

// Same set under the editor's name.
export const OPTIONAL_UTILITY_KEYS = OPTIONAL_MACRO_FIELD_KEYS;

export const STRUCTURAL_KEYS = new Set(["prompts", "prompt_order"]);
export const MACRO_FIELD_KEY_SET = new Set(MACRO_FIELD_KEYS);

export function isJsonAPreset(json) {
    if (!json || typeof json !== "object") return false;
    const jsonKeys = Object.keys(json);

    return PRESET_SIGNATURE_KEYS.every(key => jsonKeys.includes(key));
}

/**
 * ST loads 100001 as the default, 100000 is kept for legacy reasons,
 * and if both fail, fall back to the last prompt_order[] entry.
 *
 * Returns { entry, index }; entry is undefined and index is -1 when there
 * is no usable entry. Callers keep their own shape on top of this
 * (the viewer only needs the entry, the editor also needs the index).
 */
export function findActiveOrderEntry(promptOrder) {
    const entries = Array.isArray(promptOrder) ? promptOrder : [];
    let index = entries.findIndex(e => String(e?.character_id) === "100001");
    if (index === -1) index = entries.findIndex(e => String(e?.character_id) === "100000");
    if (index === -1) index = entries.length - 1;
    return { entry: entries[index], index };
}

/**
 * Keep a file <input> in sync after a picker / drop / reload handoff.
 * DataTransfer assignment can throw in some browsers — the caller's file
 * variable remains the source of truth regardless.
 */
export function syncFileInput(input, file) {
    try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
    } catch {
        /* ignore — caller-held file variable is the source of truth */
    }
}

/* ------------------------------------------------------------------ *
 * Default prompts (ST text-completion presets).
 *
 * These are the prompt ids that ship with ST — the shared key for "the
 * actual default prompts", used by both the viewer and the editor. Note
 * the `marker` flag in the JSON is NOT this: preset makers can freely
 * toggle that flag, so it is never treated as a default indicator here.
 * ------------------------------------------------------------------ */

// Canonical prompt arrangement, mirroring ST's default text-completion order.
export const DEFAULT_ORDER = Object.freeze([
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

const DEFAULT_PROMPT_ID_SET = new Set(DEFAULT_ORDER);

export function isDefaultPromptId(id) {
    return DEFAULT_PROMPT_ID_SET.has(id);
}

// Identifiers whose content ST supplies at runtime. ST does not even show
// a textbox for these, so both apps treat them as uneditable: the stored
// text (if any) is preserved verbatim, never evaluated, and never shown
// as an editable/previewable prompt body.
export const MARKER_PROMPT_IDS = new Set([
    "worldInfoBefore",
    "personaDescription",
    "charDescription",
    "charPersonality",
    "scenario",
    "worldInfoAfter",
    "dialogueExamples",
    "chatHistory",
]);

export function isMarkerPromptId(id) {
    return MARKER_PROMPT_IDS.has(id);
}

// Where ST-supplied content actually comes from (shown in locked panels
// and viewer indications).
export const ST_SUPPLIED_SOURCES = Object.freeze({
    worldInfoBefore: "World Info entries placed before the character block \u2014 edit your lorebooks",
    personaDescription: "the active user persona \u2014 edit the persona directly",
    charDescription: "the character card description \u2014 edit the character card",
    charPersonality: "the character card personality \u2014 edit the character card",
    scenario: "the scenario \u2014 edit the character card",
    worldInfoAfter: "World Info entries placed after the scenario \u2014 edit your lorebooks",
    dialogueExamples: "the character card example dialogue \u2014 edit the character card",
    chatHistory: "the chat history",
});
