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
