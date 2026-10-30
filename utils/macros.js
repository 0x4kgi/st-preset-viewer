"use strict";

/**
 * Static macro support for the preset viewer.
 *
 * This module is intentionally pure: it never touches the DOM and never
 * evaluates a macro. It mirrors the *shape* of SillyTavern's current macro
 * grammar (1.19.0) closely enough to:
 *
 *   - find balanced `{{...}}` spans without a naive regex;
 *   - understand flags, comments, variables, arguments, and scoped pairs;
 *   - classify names against a vendored registry snapshot;
 *   - validate arity, scope pairing, and field-specific dynamic macros;
 *   - separate enabled content from disabled content at the call site.
 *
 * It is not an implementation of SillyTavern. Unknown names stay unknown,
 * runtime values stay unresolved, and malformed text is reported rather than
 * "fixed".
 *
 * References:
 *   ST-Macro-Docs/syntax-and-resolution.md
 *   ST-Macro-Docs/macro-reference.md
 *   dev/public/scripts/macros/engine/MacroLexer.js
 *   dev/public/scripts/macros/engine/MacroParser.js
 */

/* ------------------------------------------------------------------------- *
 * Categories and registry
 * ------------------------------------------------------------------------- */

export const MACRO_CATEGORIES = Object.freeze({
    names: { label: "Names" },
    character: { label: "Character" },
    chat: { label: "Chat history" },
    time: { label: "Time & date" },
    variable: { label: "Variables" },
    random: { label: "Random & dice" },
    prompts: { label: "Prompt templates" },
    state: { label: "Runtime state" },
    layout: { label: "Layout & utility" },
    control: { label: "Control flow" },
    extension: { label: "Extension" },
    dynamic: { label: "Dynamic" },
    unknown: { label: "Unknown" },
});

const AVAILABILITY_LABELS = Object.freeze({
    both: "Both engines",
    new: "New engine only",
    ext: "Extension",
    dynamic: "Dynamic, field-specific",
    unknown: "Unknown",
});

/**
 * @typedef {Object} MacroDefinition
 * @property {string} name
 * @property {string} category
 * @property {'both'|'new'|'ext'|'dynamic'} availability
 * @property {number} min
 * @property {number} max
 * @property {boolean} list
 * @property {string} description
 * @property {string|null} aliasOf
 * @property {string|null} extension
 * @property {boolean} dynamic
 * @property {boolean} newWhenArgs
 * @property {boolean} newWhenScoped
 * @property {boolean} newWhenMulti
 * @property {boolean} hidden
 */

/** @type {Map<string, MacroDefinition>} */
export const MACRO_REGISTRY = new Map();

/**
 * Add one primary macro and its aliases to the snapshot.
 * @param {string} name
 * @param {Partial<MacroDefinition> & { aliases?: any[] }} options
 */
function define(name, options = {}) {
    const { aliases = [], ...rest } = options;
    /** @type {MacroDefinition} */
    const base = Object.freeze({
        name,
        category: "layout",
        availability: "both",
        min: 0,
        max: 0,
        list: false,
        description: "",
        aliasOf: null,
        extension: null,
        dynamic: false,
        newWhenArgs: false,
        newWhenScoped: false,
        newWhenMulti: false,
        hidden: false,
        ...rest,
    });

    MACRO_REGISTRY.set(name.toLowerCase(), base);

    for (const alias of aliases) {
        MACRO_REGISTRY.set(alias.name.toLowerCase(), Object.freeze({
            ...base,
            ...alias,
            name: alias.name,
            aliasOf: base.name,
            hidden: alias.hidden ?? false,
        }));
    }
}

// -- Participant names ------------------------------------------------------

define("user", {
    category: "names",
    description: "Current persona / user name.",
});
define("char", {
    category: "names",
    description: "Current character name.",
});
define("group", {
    category: "names",
    description: "Group member names, or the character name in a solo chat.",
    aliases: [{ name: "charIfNotGroup", hidden: true }],
});
define("groupNotMuted", {
    category: "names",
    description: "Group members excluding muted members, or the character name solo.",
});
define("notChar", {
    category: "names",
    description: "All participants except the current speaker.",
});

// -- Character card and persona --------------------------------------------

define("charDescription", {
    category: "character",
    availability: "new",
    description: "The character's description.",
    aliases: [{ name: "description", availability: "both" }],
});
define("charPersonality", {
    category: "character",
    availability: "new",
    description: "The character's personality.",
    aliases: [{ name: "personality", availability: "both" }],
});
define("charScenario", {
    category: "character",
    availability: "new",
    description: "The character's scenario.",
    aliases: [{ name: "scenario", availability: "both" }],
});
define("persona", {
    category: "character",
    description: "Current persona description.",
});
define("charPrompt", {
    category: "character",
    description: "The character's Main Prompt override.",
});
define("charInstruction", {
    category: "character",
    description: "The character's Post-History Instructions override.",
});
define("charDepthPrompt", {
    category: "character",
    description: "The character's @ Depth Note.",
});
define("charCreatorNotes", {
    category: "character",
    availability: "new",
    description: "Creator notes from the character card.",
    aliases: [{ name: "creatorNotes", availability: "both" }],
});
define("charVersion", {
    category: "character",
    description: "The character's version string.",
    aliases: [
        { name: "version", availability: "new", hidden: true },
        { name: "char_version", availability: "new", hidden: true },
    ],
});
define("charFirstMessage", {
    category: "character",
    availability: "new",
    min: 0,
    max: 1,
    description: "The first message / greeting. Optional 0-based index for alternate greetings.",
    aliases: [{ name: "greeting", availability: "new" }],
});
define("mesExamplesRaw", {
    category: "character",
    description: "Unformatted dialogue examples.",
});
define("mesExamples", {
    category: "character",
    description: "Dialogue examples, formatted for instruct mode when enabled.",
});
define("original", {
    category: "character",
    description: "The original prompt text a character Main Prompt override replaces.",
});

// -- Chat history -----------------------------------------------------------

for (const [name, description] of [
    ["lastMessage", "Text of the last message."],
    ["lastMessageId", "0-based index of the last message."],
    ["lastUserMessage", "Text of the last non-system user message."],
    ["lastCharMessage", "Text of the last non-user, non-system message."],
    ["firstIncludedMessageId", "Index of the first message included in context."],
    ["firstDisplayedMessageId", "Index of the first message currently displayed."],
    ["lastSwipeId", "Number of swipes on the last message."],
    ["currentSwipeId", "1-based index of the current swipe."],
    ["allChatRange", "`0-<last index>` for the chat."],
]) {
    define(name, { category: "chat", description });
}

// -- Time and date ----------------------------------------------------------

define("time", {
    category: "time",
    min: 0,
    max: 1,
    newWhenArgs: true,
    description: "Local time; an optional `UTC+2` / `UTC-7` argument selects an offset.",
});
define("date", { category: "time", description: "Local date (LL)." });
define("weekday", { category: "time", description: "Weekday name." });
define("isotime", { category: "time", description: "Time in HH:mm." });
define("isodate", { category: "time", description: "Date in YYYY-MM-DD." });
define("datetimeformat", {
    category: "time",
    min: 1,
    max: 1,
    description: "Formats the current date/time with a moment.js format string.",
});
define("idleDuration", {
    category: "time",
    availability: "new",
    description: "Human-readable time since the last user message.",
    aliases: [{ name: "idle_duration", availability: "both", hidden: true }],
});
define("timeDiff", {
    category: "time",
    min: 2,
    max: 2,
    description: "Human-readable, signed difference between two times.",
});

// -- Variables --------------------------------------------------------------

for (const [name, min, max, description, availability] of [
    ["setvar", 2, 2, "Sets a local variable; outputs nothing.", "both"],
    ["addvar", 2, 2, "Adds to / appends to a local variable; outputs nothing.", "both"],
    ["incvar", 1, 1, "Increments a local variable and returns the new value.", "both"],
    ["decvar", 1, 1, "Decrements a local variable and returns the new value.", "both"],
    ["getvar", 1, 1, "Reads a local variable.", "both"],
    ["hasvar", 1, 1, "Checks whether a local variable exists.", "new"],
    ["deletevar", 1, 1, "Deletes a local variable.", "new"],
    ["setvarkey", 3, 3, "Sets a property / index on a local variable.", "new"],
    ["getvarkey", 2, 2, "Reads a property / index from a local variable.", "new"],
    ["setglobalvar", 2, 2, "Sets a global variable; outputs nothing.", "both"],
    ["addglobalvar", 2, 2, "Adds to / appends to a global variable.", "both"],
    ["incglobalvar", 1, 1, "Increments a global variable and returns the new value.", "both"],
    ["decglobalvar", 1, 1, "Decrements a global variable and returns the new value.", "both"],
    ["getglobalvar", 1, 1, "Reads a global variable.", "both"],
    ["hasglobalvar", 1, 1, "Checks whether a global variable exists.", "new"],
    ["deleteglobalvar", 1, 1, "Deletes a global variable.", "new"],
    ["setglobalvarkey", 3, 3, "Sets a property / index on a global variable.", "new"],
    ["getglobalvarkey", 2, 2, "Reads a property / index from a global variable.", "new"],
]) {
    define(name, { category: "variable", availability, min, max, description });
}

for (const [alias, target, availability] of [
    ["varexists", "hasvar", "new"],
    ["flushvar", "deletevar", "new"],
    ["setvarindex", "setvarkey", "new"],
    ["getvarindex", "getvarkey", "new"],
    ["globalvarexists", "hasglobalvar", "new"],
    ["flushglobalvar", "deleteglobalvar", "new"],
    ["setglobalvarindex", "setglobalvarkey", "new"],
    ["getglobalvarindex", "getglobalvarkey", "new"],
]) {
    const targetDef = MACRO_REGISTRY.get(target);
    define(alias, {
        category: "variable",
        availability,
        min: targetDef.min,
        max: targetDef.max,
        description: targetDef.description,
        aliasOf: target,
        hidden: true,
    });
}

// -- Randomisation and dice -------------------------------------------------

define("random", {
    category: "random",
    list: true,
    description: "Picks a random item from a list; re-rolls every evaluation.",
});
define("pick", {
    category: "random",
    list: true,
    description: "Picks a stable random item for a given chat and position.",
});
define("roll", {
    category: "random",
    min: 1,
    max: 1,
    newWhenMulti: true,
    description: "Rolls dice using droll syntax (e.g. `1d20`).",
});

// -- Layout and utility -----------------------------------------------------

define("space", {
    category: "layout",
    availability: "new",
    min: 0,
    max: 1,
    description: "One or more spaces.",
});
define("newline", {
    category: "layout",
    min: 0,
    max: 1,
    newWhenArgs: true,
    description: "One or more newlines.",
});
define("noop", {
    category: "layout",
    description: "Produces an empty string.",
});
define("trim", {
    category: "layout",
    min: 0,
    max: 1,
    newWhenScoped: true,
    description: "Trims surrounding newlines; scoped form trims its content.",
});
define("reverse", {
    category: "layout",
    min: 1,
    max: 1,
    description: "Reverses the characters of its argument.",
});
define("//", {
    category: "layout",
    min: 0,
    max: 1,
    newWhenScoped: true,
    description: "Comment. Removed from the output; scoped content is still evaluated.",
    aliases: [{ name: "comment", availability: "new", hidden: true }],
});
define("banned", {
    category: "layout",
    min: 1,
    max: 1,
    newWhenMulti: true,
    description: "Adds a word to the Text Completion ban list; no effect for chat completion.",
});
define("outlet", {
    category: "layout",
    min: 1,
    max: 1,
    description: "World Info outlet prompt for a key.",
});
define("input", {
    category: "layout",
    description: "Current send-textarea text.",
});

// -- Control flow -----------------------------------------------------------

define("if", {
    category: "control",
    availability: "new",
    min: 1,
    max: 2,
    description: "Conditional block. Only the selected branch is resolved.",
});
define("else", {
    category: "control",
    availability: "new",
    description: "Branch separator inside a scoped `if` block.",
});

// -- Runtime state ----------------------------------------------------------

for (const [name, aliases, description] of [
    ["maxPrompt", ["maxPromptTokens"], "Maximum prompt context size."],
    ["maxContext", ["maxContextTokens"], "Maximum context token limit."],
    ["maxResponse", ["maxResponseTokens"], "Maximum response token limit."],
]) {
    define(name, {
        category: "state",
        description,
        aliases: aliases.map(alias => ({ name: alias })),
    });
}
define("model", { category: "state", description: "Current model name." });
define("isMobile", { category: "state", description: "Whether the client is mobile." });
define("lastGenerationType", {
    category: "state",
    description: "The current generation type, or empty before the first generation.",
});
define("hasExtension", {
    category: "state",
    availability: "new",
    min: 1,
    max: 1,
    description: "Whether an extension is enabled.",
});

// -- Prompt-template macros -------------------------------------------------

for (const [name, aliases, description] of [
    ["instructStoryStringPrefix", [], "Instruct story-string prefix."],
    ["instructStoryStringSuffix", [], "Instruct story-string suffix."],
    ["instructUserPrefix", ["instructInput"], "Instruct input / user prefix."],
    ["instructUserSuffix", [], "Instruct input / user suffix."],
    ["instructAssistantPrefix", ["instructOutput"], "Instruct output / assistant prefix."],
    ["instructAssistantSuffix", ["instructSeparator"], "Instruct output / assistant suffix."],
    ["instructSystemPrefix", [], "Instruct system prefix."],
    ["instructSystemSuffix", [], "Instruct system suffix."],
    ["instructFirstAssistantPrefix", ["instructFirstOutputPrefix"], "First assistant / output prefix."],
    ["instructLastAssistantPrefix", ["instructLastOutputPrefix"], "Last assistant / output prefix."],
    ["instructStop", [], "Instruct stop sequence."],
    ["instructUserFiller", [], "Instruct user alignment message."],
    ["instructSystemInstructionPrefix", [], "Last-system instruction prefix."],
    ["instructFirstUserPrefix", ["instructFirstInput"], "First user / input prefix."],
    ["instructLastUserPrefix", ["instructLastInput"], "Last user / input prefix."],
    ["defaultSystemPrompt", ["instructSystem", "instructSystemPrompt"], "Default system prompt."],
    ["systemPrompt", [], "Active system prompt (character override aware)."],
    ["exampleSeparator", ["chatSeparator"], "Example-chat separator."],
    ["chatStart", [], "Chat-start marker."],
]) {
    define(name, {
        category: "prompts",
        description,
        aliases: aliases.map(alias => ({ name: alias })),
    });
}

// -- Extension-provided macros ---------------------------------------------

/**
 * These are not core. They only work when the named extension is loaded and
 * enabled; otherwise SillyTavern leaves the name literal.
 */
for (const [name, extension, description, extra = {}] of [
    ["summary", "Memory", "Latest memory / summary; empty when none exists."],
    ["defaultExpression", "Expressions", "Global fallback expression."],
    ["lastExpression", "Expressions", "Last expression used."],
    ["availableExpressions", "Expressions", "Comma-separated expression labels."],
    ["charPrefix", "Stable Diffusion", "Character's positive image prompt prefix."],
    ["charNegativePrefix", "Stable Diffusion", "Character's negative image prompt prefix."],
    ["authorsNote", "Author's Note", "Current chat's Author's Note."],
    ["charAuthorsNote", "Author's Note", "Character-specific Author's Note."],
    ["defaultAuthorsNote", "Author's Note", "Default Author's Note."],
    ["qm-short-term-memory", "qvink_memory", "Short-term memory text (third-party)."],
    ["qm-long-term-memory", "qvink_memory", "Long-term memory text (third-party)."],
    ["summaryception_memory", "Summaryception", "Summary text (third-party, not installed in the reference sandbox)."],
]) {
    define(name, {
        category: "extension",
        availability: "ext",
        min: 0,
        max: Infinity,
        extension,
        description,
        ...extra,
    });
}

// -- Dynamic, per-call macros ----------------------------------------------

define("lastChatMessage", {
    category: "dynamic",
    availability: "dynamic",
    dynamic: true,
    description: "Last chat message. Only supplied for `continue_nudge_prompt`.",
});

// -- Reasoning (core, new engine) ------------------------------------------

for (const [name, description] of [
    ["reasoningPrefix", "Reasoning block prefix."],
    ["reasoningSuffix", "Reasoning block suffix."],
    ["reasoningSeparator", "Thinking / answer separator."],
]) {
    define(name, {
        category: "prompts",
        availability: "new",
        description,
    });
}

/**
 * @param {string} name
 * @returns {MacroDefinition|undefined}
 */
export function getMacroDefinition(name) {
    if (!name) return undefined;
    return MACRO_REGISTRY.get(String(name).toLowerCase());
}

/**
 * @param {MacroDefinition|undefined} def
 * @returns {string}
 */
export function availabilityLabel(def) {
    if (!def) return AVAILABILITY_LABELS.unknown;
    if (def.availability === "ext") return `Requires ${def.extension ?? "an extension"}`;
    return AVAILABILITY_LABELS[def.availability] ?? AVAILABILITY_LABELS.unknown;
}

/* ------------------------------------------------------------------------- *
 * Field metadata
 * ------------------------------------------------------------------------- */

/**
 * Utility fields that SillyTavern substitutes, plus the two fields that look
 * like macro fields but are not.
 */
export const MACRO_FIELDS = Object.freeze({
    impersonation_prompt: {
        expanded: true,
        note: "Used for /impersonate.",
    },
    new_chat_prompt: {
        expanded: true,
        note: "Used when a new solo chat starts.",
    },
    new_group_chat_prompt: {
        expanded: true,
        note: "Used when a new group chat starts.",
    },
    new_example_chat_prompt: {
        expanded: true,
        note: "Prepended to the example-dialogue block.",
    },
    continue_nudge_prompt: {
        expanded: true,
        note: "The only field where ST supplies {{lastChatMessage}}.",
    },
    group_nudge_prompt: {
        expanded: true,
        note: "Injected when a group member needs a nudge.",
    },
    scenario_format: {
        expanded: true,
        note: "Wraps the scenario text.",
    },
    personality_format: {
        expanded: true,
        note: "Wraps the personality text.",
    },
    assistant_prefill: {
        expanded: true,
        note: "Substituted when assistant prefill is configured.",
    },
    assistant_impersonation: {
        expanded: true,
        note: "Substituted when building an impersonation request.",
    },
    custom_include_body: {
        expanded: true,
        note: "Custom OpenAI-compatible endpoints only.",
    },
    custom_exclude_body: {
        expanded: true,
        note: "Custom OpenAI-compatible endpoints only.",
    },
    custom_include_headers: {
        expanded: true,
        note: "Custom OpenAI-compatible endpoints only.",
    },
    wi_format: {
        expanded: false,
        note: "ST does not macro-expand this field; only {0} is substituted.",
    },
});

/**
 * @param {string} field
 */
export function getMacroField(field) {
    return MACRO_FIELDS[field] ?? { expanded: true, note: "" };
}

/* ------------------------------------------------------------------------- *
 * Source locations
 * ------------------------------------------------------------------------- */

function computeLineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
}

function locate(lineStarts, offset) {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lineStarts[mid] <= offset) low = mid + 1;
        else high = mid - 1;
    }
    const lineIndex = Math.max(0, high);
    return {
        line: lineIndex + 1,
        column: offset - lineStarts[lineIndex] + 1,
    };
}

/* ------------------------------------------------------------------------- *
 * Low-level scanning
 * ------------------------------------------------------------------------- */

const FLAG_CHARS = "!?~#/>";
const NAME_MAX = 128;

function isSpaceChar(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isNameStart(ch) {
    return ch !== undefined && /[A-Za-z]/.test(ch);
}

function isNameChar(ch) {
    return ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
}

/**
 * Find the matching `}}` for an opener, counting nested `{{`.
 * Mirrors ST's brace handling closely enough, including the `{{{char}}`
 * "literal `{` then macro" case.
 *
 * @param {string} text
 * @param {number} from
 * @returns {number} index of the closing `}}`, or -1
 */
function findMacroEnd(text, from) {
    let depth = 1;
    let i = from;

    while (i < text.length) {
        const ch = text[i];

        if (ch === "\\") {
            i += 2;
            continue;
        }

        if (ch === "{" && text[i + 1] === "{") {
            depth++;
            i += text[i + 2] === "{" ? 3 : 2;
            continue;
        }

        if (ch === "}" && text[i + 1] === "}") {
            depth--;
            if (depth === 0) return i;
            i += 2;
            continue;
        }

        i++;
    }

    return -1;
}

/**
 * Split an argument string on top-level `::`. Nested macros and escaped
 * braces do not split.
 *
 * @param {string} text
 * @param {string} separator
 * @returns {string[]}
 */
function splitTopLevel(text, separator = "::") {
    const out = [];
    let start = 0;
    let depth = 0;
    let i = 0;

    while (i < text.length) {
        if (text[i] === "\\") {
            i += 2;
            continue;
        }

        if (text[i] === "{" && text[i + 1] === "{") {
            depth++;
            i += text[i + 2] === "{" ? 3 : 2;
            continue;
        }

        if (text[i] === "}" && text[i + 1] === "}") {
            if (depth > 0) depth--;
            i += 2;
            continue;
        }

        if (depth === 0 && text.startsWith(separator, i)) {
            out.push(text.slice(start, i));
            i += separator.length;
            start = i;
            continue;
        }

        i++;
    }

    out.push(text.slice(start));
    return out;
}

/* ------------------------------------------------------------------------- *
 * Macro construction
 * ------------------------------------------------------------------------- */

/**
 * @typedef {Object} Macro
 * @property {number} index
 * @property {number} start
 * @property {number} end
 * @property {string} raw
 * @property {string} inner
 * @property {string} name
 * @property {string} lowerName
 * @property {string[]} flags
 * @property {boolean} isClosing
 * @property {boolean} isComment
 * @property {boolean} isVariable
 * @property {Object|null} variable
 * @property {string[]} args
 * @property {string[]} rawArgs
 * @property {number} argCount
 * @property {'zero'|'single'|'space'|'multi'|'legacy'} separator
 * @property {string} category
 * @property {string} canonicalName
 * @property {string} availability
 * @property {boolean} known
 * @property {string|null} extension
 * @property {boolean} dynamic
 * @property {boolean} newEngineOnly
 * @property {Object|null} malformed
 * @property {Object|null} scope
 * @property {{line:number,column:number}} location
 */

/**
 * @param {Object} values
 * @returns {Macro}
 */
function makeMacro(values) {
    const name = values.name ?? "";
    return {
        index: 0,
        start: 0,
        end: 0,
        raw: "",
        inner: "",
        name,
        lowerName: name.toLowerCase(),
        flags: [],
        isClosing: false,
        isComment: false,
        isVariable: false,
        variable: null,
        args: [],
        rawArgs: [],
        argCount: 0,
        separator: "zero",
        category: "unknown",
        canonicalName: name,
        availability: "unknown",
        known: false,
        extension: null,
        dynamic: false,
        newEngineOnly: false,
        malformed: null,
        scope: null,
        location: { line: 1, column: 1 },
        ...values,
        lowerName: (values.name ?? "").toLowerCase(),
    };
}

/**
 * @param {string} code
 * @param {string} message
 * @param {'error'|'warning'} severity
 */
function malformed(code, message, severity = "warning") {
    return { code, message, severity };
}

/**
 * Parse one opener at `open`. The scanner has already established that
 * `text.startsWith("{{", open)` and that the next character is not `{`
 * (the `{{{` case is handled by the scanner).
 *
 * @param {string} text
 * @param {number} open
 * @returns {Macro}
 */
function parseMacroAt(text, open) {
    const len = text.length;
    let pos = open + 2;
    const flags = [];
    let isComment = false;

    // Flags and leading whitespace. `//` wins over the `/` flag.
    while (pos < len) {
        if (text.startsWith("//", pos)) {
            isComment = true;
            pos += 2;
            break;
        }

        const ch = text[pos];
        if (isSpaceChar(ch)) {
            pos++;
            continue;
        }
        if (FLAG_CHARS.includes(ch)) {
            flags.push(ch);
            pos++;
            continue;
        }
        break;
    }

    if (isComment) {
        return parseComment(text, open, flags, pos);
    }

    if (pos >= len) {
        return makeMacro({
            start: open,
            end: len,
            raw: text.slice(open),
            inner: text.slice(open + 2),
            name: "",
            flags,
            malformed: malformed("unterminated", "Unterminated macro: no closing `}}`.", "warning"),
        });
    }

    if (text[pos] === "." || text[pos] === "$") {
        return parseVariable(text, open, flags, pos);
    }

    const nameStart = pos;
    if (!isNameStart(text[nameStart])) {
        // `{{}}`, `{{ }}`, `{{!}}`, ...
        const end = text.startsWith("}}", nameStart)
            ? nameStart + 2
            : Math.min(len, nameStart + 1);
        return makeMacro({
            start: open,
            end,
            raw: text.slice(open, end),
            inner: text.slice(open + 2, Math.max(open + 2, end - 2)),
            name: "",
            flags,
            malformed: malformed("invalid-head", "Not a macro: expected a macro name after `{{`.", "warning"),
        });
    }

    let nameEnd = nameStart + 1;
    while (nameEnd < len && isNameChar(text[nameEnd])) nameEnd++;

    let name = text.slice(nameStart, nameEnd);
    let forcedArg = null;

    // Legacy `{{time_UTC+2}}` spelling. The new engine rewrites it before
    // parsing; the viewer can normalise it itself.
    if (name.toLowerCase() === "time_utc" && (text[nameEnd] === "+" || text[nameEnd] === "-")) {
        let p = nameEnd + 1;
        while (p < len && text[p] >= "0" && text[p] <= "9") p++;
        if (p > nameEnd + 1) {
            forcedArg = `UTC${text.slice(nameEnd, p)}`;
            name = "time";
            nameEnd = p;
        }
    }

    pos = nameEnd;

    if (forcedArg !== null) {
        const end = findMacroEnd(text, pos);
        if (end === -1) {
            return makeMacro({
                start: open,
                end: len,
                raw: text.slice(open),
                inner: text.slice(open + 2),
                name,
                flags,
                args: [forcedArg],
                rawArgs: [forcedArg],
                argCount: 1,
                separator: "legacy",
                malformed: malformed("unterminated", "Unterminated macro: no closing `}}`.", "warning"),
            });
        }
        return makeMacro({
            start: open,
            end: end + 2,
            raw: text.slice(open, end + 2),
            inner: text.slice(open + 2, end),
            name,
            flags,
            args: [forcedArg],
            rawArgs: [forcedArg],
            argCount: 1,
            separator: "legacy",
        });
    }

    // Whitespace between the name and the argument / closing braces.
    let after = pos;
    while (after < len && isSpaceChar(text[after])) after++;
    const sawSpace = after > pos;

    if (after >= len) {
        return makeMacro({
            start: open,
            end: len,
            raw: text.slice(open),
            inner: text.slice(open + 2),
            name,
            flags,
            malformed: malformed("unterminated", "Unterminated macro: no closing `}}`.", "warning"),
        });
    }

    let separator = "zero";
    let argStart = after;
    let argEnd = after;

    if (text.startsWith("::", after)) {
        separator = "multi";
        argStart = after + 2;
        argEnd = findMacroEnd(text, after);
    } else if (text[after] === ":") {
        separator = "single";
        argStart = after + 1;
        argEnd = findMacroEnd(text, after);
    } else if (text.startsWith("}}", after)) {
        separator = "zero";
        argEnd = after;
    } else if (sawSpace || text[after] === "|") {
        separator = "space";
        argStart = after;
        argEnd = findMacroEnd(text, after);
    } else {
        // A real malformation: `{{user)`, `{{foo.bar}}`, ...
        const badEnd = Math.min(len, after + 1);
        return makeMacro({
            start: open,
            end: badEnd,
            raw: text.slice(open, badEnd),
            inner: text.slice(open + 2, Math.max(open + 2, badEnd - 2)),
            name,
            flags,
            malformed: malformed(
                "invalid-after-name",
                `Malformed macro: unexpected \`${text[after]}\` after \`${name}\`. Did you mean \`}}\`?`,
                "error",
            ),
        });
    }

    if (argEnd === -1) {
        const lineEnd = text.indexOf("\n", after);
        const nextOpen = text.indexOf("{{", after);
        let stop = Math.min(
            lineEnd === -1 ? len : lineEnd,
            nextOpen === -1 ? len : nextOpen,
            open + 96,
        );
        if (stop <= after) stop = Math.min(len, after + 1);
        return makeMacro({
            start: open,
            end: stop,
            raw: text.slice(open, stop),
            inner: text.slice(open + 2, Math.max(open + 2, stop - 2)),
            name,
            flags,
            separator,
            malformed: malformed("unterminated", "Unterminated macro: no closing `}}`.", "warning"),
        });
    }

    const rawArgText = text.slice(argStart, argEnd);
    let args;
    let rawArgs;

    if (separator === "zero") {
        args = [];
        rawArgs = [];
    } else if (separator === "multi") {
        rawArgs = splitTopLevel(rawArgText, "::");
        args = rawArgs.map(arg => arg.trim());
    } else {
        const trimmed = rawArgText.trim();
        args = trimmed === "" ? [""] : [trimmed];
        rawArgs = [rawArgText];
    }

    return makeMacro({
        start: open,
        end: argEnd + 2,
        raw: text.slice(open, argEnd + 2),
        inner: text.slice(open + 2, argEnd),
        name,
        flags,
        isClosing: flags.includes("/"),
        args,
        rawArgs,
        argCount: args.length,
        separator,
    });
}

/**
 * @param {string} text
 * @param {number} open
 * @param {string[]} flags
 * @param {number} pos
 * @returns {Macro}
 */
function parseComment(text, open, flags, pos) {
    const end = findMacroEnd(text, pos);

    if (end === -1) {
        return makeMacro({
            start: open,
            end: text.length,
            raw: text.slice(open),
            inner: text.slice(open + 2),
            name: "//",
            flags,
            isComment: true,
            malformed: malformed("unterminated", "Unterminated comment: no closing `}}`.", "warning"),
        });
    }

    const body = text.slice(pos, end);
    const isClosing = /^\s*\/\s*$/.test(body);

    if (isClosing) {
        return makeMacro({
            start: open,
            end: end + 2,
            raw: text.slice(open, end + 2),
            inner: text.slice(open + 2, end),
            name: "//",
            flags,
            isClosing: true,
            isComment: true,
            separator: "zero",
        });
    }

    let args;
    if (body.trim() === "") {
        args = [];
    } else if (/^\s*::/.test(body)) {
        // Matches the parser's multi-argument branch for `{{//::a::b}}`.
        args = splitTopLevel(body.replace(/^\s*::/, ""), "::").map(arg => arg.trim());
    } else {
        // One body argument. `this::is::not` stays one argument: the parser's
        // single-argument branch allows `::` inside it.
        args = [body.trim()];
    }

    return makeMacro({
        start: open,
        end: end + 2,
        raw: text.slice(open, end + 2),
        inner: text.slice(open + 2, end),
        name: "//",
        flags,
        isComment: true,
        args,
        rawArgs: [body],
        argCount: args.length,
        separator: args.length > 1 ? "multi" : "single",
    });
}

const VARIABLE_OPERATORS = [
    "??=", "||=", "++", "--", "??", "||", "-=", "==", "!=", ">=", "<=", "+=", "=", ">", "<",
];

/**
 * @param {string} text
 * @param {number} open
 * @param {string[]} flags
 * @param {number} pos
 * @returns {Macro}
 */
function parseVariable(text, open, flags, pos) {
    const prefix = text[pos];
    const scope = prefix === "." ? "local" : "global";
    const identStart = pos + 1;

    const match = /^[A-Za-z](?:[\w-]*\w)?/.exec(text.slice(identStart, identStart + NAME_MAX));
    if (!match) {
        const badEnd = Math.min(text.length, identStart + 1);
        return makeMacro({
            start: open,
            end: badEnd,
            raw: text.slice(open, badEnd),
            inner: text.slice(open + 2, badEnd),
            name: prefix,
            flags,
            isVariable: true,
            malformed: malformed("bad-variable", "Malformed variable expression: expected a variable name.", "error"),
        });
    }

    const varName = match[0];
    let after = identStart + varName.length;
    while (after < text.length && isSpaceChar(text[after])) after++;

    const name = `${prefix}${varName}`;

    if (after >= text.length) {
        return makeMacro({
            start: open,
            end: text.length,
            raw: text.slice(open),
            inner: text.slice(open + 2),
            name,
            flags,
            isVariable: true,
            variable: { scope, name: varName, operator: null, value: null },
            malformed: malformed("unterminated", "Unterminated variable expression.", "warning"),
        });
    }

    if (text.startsWith("}}", after)) {
        return makeMacro({
            start: open,
            end: after + 2,
            raw: text.slice(open, after + 2),
            inner: text.slice(open + 2, after),
            name,
            flags,
            isVariable: true,
            variable: { scope, name: varName, operator: null, value: null },
        });
    }

    const operator = VARIABLE_OPERATORS.find(op => text.startsWith(op, after));
    if (!operator) {
        const badEnd = Math.min(text.length, after + 1);
        return makeMacro({
            start: open,
            end: badEnd,
            raw: text.slice(open, badEnd),
            inner: text.slice(open + 2, badEnd),
            name,
            flags,
            isVariable: true,
            malformed: malformed(
                "bad-variable-operator",
                `Malformed variable expression: unexpected \`${text[after]}\` after \`${varName}\`.`,
                "error",
            ),
        });
    }

    let valueStart = after + operator.length;
    let p = valueStart;
    while (p < text.length && isSpaceChar(text[p])) p++;

    if (operator === "++" || operator === "--") {
        if (!text.startsWith("}}", p)) {
            const badEnd = Math.min(text.length, p + 1);
            return makeMacro({
                start: open,
                end: badEnd,
                raw: text.slice(open, badEnd),
                inner: text.slice(open + 2, badEnd),
                name,
                flags,
                isVariable: true,
                variable: { scope, name: varName, operator, value: null },
                malformed: malformed(
                    "variable-trailing",
                    `Malformed variable expression: trailing text after \`${operator}\`.`,
                    "error",
                ),
            });
        }
        return makeMacro({
            start: open,
            end: p + 2,
            raw: text.slice(open, p + 2),
            inner: text.slice(open + 2, p),
            name,
            flags,
            isVariable: true,
            variable: { scope, name: varName, operator, value: null },
        });
    }

    const end = findMacroEnd(text, valueStart);
    if (end === -1) {
        return makeMacro({
            start: open,
            end: text.length,
            raw: text.slice(open),
            inner: text.slice(open + 2),
            name,
            flags,
            isVariable: true,
            variable: { scope, name: varName, operator, value: text.slice(valueStart).trim() },
            malformed: malformed("unterminated", "Unterminated variable expression.", "warning"),
        });
    }

    return makeMacro({
        start: open,
        end: end + 2,
        raw: text.slice(open, end + 2),
        inner: text.slice(open + 2, end),
        name,
        flags,
        isVariable: true,
        variable: { scope, name: varName, operator, value: text.slice(valueStart, end).trim() },
    });
}

/* ------------------------------------------------------------------------- *
 * Scope pairing
 * ------------------------------------------------------------------------- */

function canAcceptScope(macro) {
    if (macro.malformed || macro.isClosing || macro.isVariable) return false;
    const def = getMacroDefinition(macro.lowerName);
    if (!def) return true; // unknown macros are permissive
    if (def.list) return false; // random / pick do not take scoped content
    if (macro.argCount + 1 > def.max) return false;
    return true;
}

function needsClosing(macro) {
    if (macro.lowerName === "if") return macro.argCount === 1;
    if (macro.lowerName === "//") return macro.argCount === 0;
    return false;
}

/**
 * Pair scoped tags inside one document. This also marks `else` branches on
 * their enclosing `if`.
 *
 * @param {Macro[]} macros
 * @param {any[]} issues
 */
function pairScopes(macros, issues) {
    /** @type {number[]} */
    const stack = [];
    /** @type {any[]} */
    const pairs = [];
    // `{{else}}` is seen before its `{{/if}}`, so the pair does not exist
    // yet. Stash it here keyed by the opener's position in `macros`.
    /** @type {Map<number, { elsePos: number, depth: number }>} */
    const pendingElse = new Map();

    for (let i = 0; i < macros.length; i++) {
        const macro = macros[i];
        if (macro.malformed) continue;

        if (macro.isClosing) {
            const name = macro.lowerName;
            let match = -1;
            for (let j = stack.length - 1; j >= 0; j--) {
                if (macros[stack[j]].lowerName === name) {
                    match = j;
                    break;
                }
            }

            if (match === -1) {
                issues.push({
                    code: "unmatched-closing",
                    severity: "error",
                    message: `Unmatched closing tag \`{{/${macro.name}}}\`.`,
                    macroIndex: macro.index,
                    start: macro.start,
                });
                continue;
            }

            const open = macros[stack[match]];
            const openPos = stack[match];
            if (match !== stack.length - 1) {
                for (let j = match + 1; j < stack.length; j++) {
                    const inner = macros[stack[j]];
                    if (needsClosing(inner)) {
                        issues.push({
                            code: "unclosed-scope",
                            severity: "error",
                            message: `\`{{${inner.name}}}\` is still open when \`{{/${macro.name}}}\` closes the outer block.`,
                            macroIndex: inner.index,
                            start: inner.start,
                        });
                    }
                    // Discarded inner openers never get a pair; drop any
                    // `{{else}}` stashed for them so it stays scopeless.
                    pendingElse.delete(stack[j]);
                }
            }

            const pairIndex = pairs.length;
            pairs.push({
                name: open.name,
                openIndex: open.index,
                closeIndex: macro.index,
                hasElse: false,
                elseIndex: null,
                condition: open.lowerName === "if" ? (open.args[0] ?? "") : open.args.join("::"),
                branches: [],
            });

            const stashed = pendingElse.get(openPos);
            if (stashed !== undefined && open.lowerName === "if") {
                const elseMacro = macros[stashed.elsePos];
                pairs[pairIndex].hasElse = true;
                pairs[pairIndex].elseIndex = elseMacro.index;
                elseMacro.scope = { role: "else", pairIndex, depth: stashed.depth };
                pendingElse.delete(openPos);
            }

            open.scope = { role: "open", pairIndex, depth: stack.length - 1 };
            macro.scope = { role: "close", pairIndex, depth: stack.length - 1 };
            stack.length = match; // remove the opener and any inner openers
            continue;
        }

        if (macro.lowerName === "else") {
            let match = -1;
            for (let j = stack.length - 1; j >= 0; j--) {
                if (macros[stack[j]].lowerName === "if") {
                    match = j;
                    break;
                }
            }

            if (match === -1) {
                issues.push({
                    code: "else-outside-if",
                    severity: "warning",
                    message: "`{{else}}` outside a scoped `{{if}}` has no effect.",
                    macroIndex: macro.index,
                    start: macro.start,
                });
                continue;
            }

            const open = macros[stack[match]];
            const openPos = stack[match];
            if (pendingElse.has(openPos)) {
                issues.push({
                    code: "duplicate-else",
                    severity: "warning",
                    message: "This `{{if}}` already has an `{{else}}` branch.",
                    macroIndex: macro.index,
                    start: macro.start,
                });
            } else {
                pendingElse.set(openPos, { elsePos: i, depth: match });
            }
            continue;
        }

        if (canAcceptScope(macro)) {
            stack.push(i);
        }
    }

    for (const index of stack) {
        const macro = macros[index];
        if (needsClosing(macro)) {
            issues.push({
                code: "unclosed-scope",
                severity: "error",
                message: macro.lowerName === "if"
                    ? "`{{if}}` has no matching `{{/if}}` in this entry; ST leaves it literal."
                    : "`{{//}}` has no body and no `{{///}}` closing tag.",
                macroIndex: macro.index,
                start: macro.start,
            });
        }
    }

    for (const pair of pairs) {
        const open = macros[pair.openIndex];
        const close = macros[pair.closeIndex];
        const elseMacro = pair.elseIndex === null ? null : macros[pair.elseIndex];

        pair.branches.push({
            kind: "then",
            start: open.end,
            end: elseMacro ? elseMacro.start : close.start,
        });

        if (elseMacro) {
            pair.branches.push({
                kind: "else",
                start: elseMacro.end,
                end: close.start,
            });
        }
    }

    return pairs;
}

/* ------------------------------------------------------------------------- *
 * Classification / validation
 * ------------------------------------------------------------------------- */

function addNameIssue(map, code, severity, name, message, macro) {
    const key = `${code}:${name.toLowerCase()}`;
    const existing = map.get(key);
    if (existing) {
        existing.count++;
        return;
    }
    map.set(key, {
        code,
        severity,
        message,
        macroIndex: macro?.index ?? null,
        start: macro?.start ?? 0,
        count: 1,
    });
}

function arityText(def) {
    if (def.list) return `at least ${def.min} argument${def.min === 1 ? "" : "s"}`;
    if (def.max === Infinity) return `${def.min}+ arguments`;
    if (def.min === def.max) return `${def.min} argument${def.min === 1 ? "" : "s"}`;
    return `${def.min}–${def.max} arguments`;
}

function availabilityForCall(def, macro) {
    if (!def) return "unknown";
    if (def.availability === "ext") return "ext";
    if (def.dynamic) return "dynamic";
    if (def.availability === "new") return "new";
    if (macro.separator === "legacy") return "both";
    if (def.newWhenArgs && macro.argCount > 0) return "new";
    if (def.newWhenScoped && macro.scope?.role === "open") return "new";
    if (def.newWhenMulti && macro.separator === "multi") return "new";
    return "both";
}

/* ------------------------------------------------------------------------- *
 * Public analysis
 * ------------------------------------------------------------------------- */

/**
 * Parse and classify one independent macro document. A document is one
 * prompt entry, one utility field, or one prompt name. Never pass a
 * concatenation of entries.
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {string} [options.field] Utility field name, when applicable.
 * @param {'prompt'|'utility'|'name'|'text'} [options.kind]
 * @param {boolean} [options.enabled] Whether the prompt entry is enabled.
 * @param {boolean} [options.expanded] False for fields ST does not expand.
 * @returns {Object}
 */
export function analyzeMacros(text, options = {}) {
    text = typeof text === "string" ? text : "";
    const {
        field = null,
        kind = "text",
        enabled = true,
        expanded = true,
    } = options;

    const macros = [];
    /** @type {Array<{type:'text', text:string}|{type:'macro', macro:Macro}>} */
    const segments = [];
    /** @type {any[]} */
    const issues = [];

    const pushText = (start, end) => {
        if (end <= start) return;
        const value = text.slice(start, end);
        const last = segments[segments.length - 1];
        if (last && last.type === "text") last.text += value;
        else segments.push({ type: "text", text: value });
    };

    let i = 0;
    while (i < text.length) {
        const open = text.indexOf("{{", i);
        if (open === -1) {
            pushText(i, text.length);
            break;
        }

        if (open > i) pushText(i, open);

        // `{{{char}}` is a literal `{` followed by `{{char}}`.
        if (text[open + 2] === "{") {
            pushText(open, open + 1);
            i = open + 1;
            continue;
        }

        const macro = parseMacroAt(text, open);
        macro.index = macros.length;
        macros.push(macro);
        segments.push({ type: "macro", macro });
        i = macro.end;
    }

    const lineStarts = computeLineStarts(text);
    for (const macro of macros) {
        macro.location = locate(lineStarts, macro.start);
        if (macro.malformed && expanded) {
            issues.push({
                code: macro.malformed.code,
                severity: macro.malformed.severity,
                message: macro.malformed.message,
                macroIndex: macro.index,
                start: macro.start,
            });
        }
    }

    // Nested macros are evaluated inside arguments and comments before the
    // outer handler runs. They are not separate top-level segments (the outer
    // span covers them), but they still count as invocations and can carry
    // issues. Parse `inner` recursively; it is strictly shorter, so this
    // terminates.
    for (const macro of macros) {
        if (!macro.inner.includes("{{")) continue;
        const nested = analyzeMacros(macro.inner, {
            field,
            kind: "nested",
            enabled,
            expanded,
        });
        macro.nested = nested.macros;
        macro.nestedIssues = nested.issues;
        macro.nestedOffset = macro.start + 2;
    }

    const pairs = expanded ? pairScopes(macros, issues) : [];
    const nameIssues = new Map();

    for (const macro of macros) {
        if (macro.isVariable) {
            macro.known = true;
            macro.category = "variable";
            macro.canonicalName = macro.name;
            macro.availability = "new";
            macro.newEngineOnly = true;
            // Variable shorthand is a complete expression, not a call; the
            // normal arity/scope checks do not apply.
            continue;
        }

        const def = getMacroDefinition(macro.lowerName);
        if (def) {
            macro.known = true;
            macro.category = def.category;
            macro.canonicalName = def.aliasOf ?? def.name;
            macro.extension = def.extension;
            macro.dynamic = def.dynamic;
        } else {
            macro.category = "unknown";
            macro.canonicalName = macro.name;
        }

        macro.availability = availabilityForCall(def, macro);
        macro.newEngineOnly = macro.availability === "new";

        if (macro.malformed) continue;
        if (!expanded) continue;

        // Field-specific dynamic macro.
        if (def?.dynamic) {
            if (field !== "continue_nudge_prompt") {
                addNameIssue(
                    nameIssues,
                    "dynamic-outside-field",
                    "error",
                    macro.name,
                    `\`{{${macro.name}}}\` is only supplied for \`continue_nudge_prompt\`; everywhere else ST leaves it literal.`,
                    macro,
                );
            }
            continue;
        }

        if (!def) {
            addNameIssue(
                nameIssues,
                "unknown",
                "warning",
                macro.name,
                `\`{{${macro.name}}}\` is not in the 1.19.0 registry. ST leaves unknown names literal unless an extension registers one.`,
                macro,
            );
            continue;
        }

        if (def.availability === "ext") {
            addNameIssue(
                nameIssues,
                "extension",
                "warning",
                macro.name,
                `\`{{${macro.name}}}\` requires the ${def.extension} extension; otherwise it stays literal.`,
                macro,
            );
        }

        // Closing tags are paired, not called; their arguments are ignored.
        if (macro.isClosing) {
            if (macro.argCount > 0) {
                issues.push({
                    code: "closing-args",
                    severity: "warning",
                    message: `Closing tag \`{{/${macro.name}}}\` arguments are ignored by the pairing logic.`,
                    macroIndex: macro.index,
                    start: macro.start,
                });
            }
            continue;
        }

        if (macro.lowerName === "else") {
            if (macro.argCount > 0) {
                issues.push({
                    code: "arity",
                    severity: "error",
                    message: "`{{else}}` takes no arguments.",
                    macroIndex: macro.index,
                    start: macro.start,
                });
            }
            continue;
        }

        if (def.availability === "ext") {
            // Argument shape is unknown for extension macros; do not invent an
            // arity error for them.
            continue;
        }

        const effectiveArgs = macro.args.length + (macro.scope?.role === "open" ? 1 : 0);

        if (macro.lowerName === "//") {
            if (effectiveArgs > 1) {
                issues.push({
                    code: "arity",
                    severity: "error",
                    message: `A comment takes at most one body argument, but got ${effectiveArgs}. A body starting with \`::\` is split into multiple arguments.`,
                    macroIndex: macro.index,
                    start: macro.start,
                });
            }
            continue;
        }

        if (macro.lowerName === "if" && macro.argCount === 0) {
            issues.push({
                code: "if-no-condition",
                severity: "error",
                message: "`{{if}}` needs a condition. Scoped content is the branch, not the condition.",
                macroIndex: macro.index,
                start: macro.start,
            });
        }

        if (macro.lowerName === "if" && macro.argCount === 1 && !macro.scope) {
            issues.push({
                code: "if-no-block",
                severity: "error",
                message: "`{{if}}` with one argument needs a `{{/if}}` block. The inline form is `{{if::condition::then}}`.",
                macroIndex: macro.index,
                start: macro.start,
            });
        }

        // List macros (`random`, `pick`) accept any number of arguments at
        // or above their positional minimum; `max` does not apply.
        const tooFew = effectiveArgs < def.min;
        const tooMany = !def.list && effectiveArgs > def.max;
        if (tooFew || tooMany) {
            issues.push({
                code: "arity",
                severity: "error",
                message: `\`{{${macro.name}}}\` expects ${arityText(def)}, but got ${effectiveArgs}. ST leaves an arity-invalid macro literal.`,
                macroIndex: macro.index,
                start: macro.start,
            });
        }

        // Cheap, high-value type checks. Skip values that contain a nested
        // macro: those are resolved at runtime and cannot be judged here.
        if (["space", "newline", "charFirstMessage"].includes(macro.lowerName) && macro.args[0] !== undefined) {
            const value = macro.args[0];
            if (!value.includes("{{") && value !== "" && !/^-?\d+$/.test(value.trim())) {
                issues.push({
                    code: "type",
                    severity: "warning",
                    message: `\`{{${macro.name}}}\` expects an integer, but got \`${value}\`.`,
                    macroIndex: macro.index,
                    start: macro.start,
                });
            }
        }

        if (macro.lowerName === "time" && macro.args[0] !== undefined) {
            const value = macro.args[0];
            if (!value.includes("{{") && value !== "" && !/^UTC[+-]\d+$/.test(value.trim())) {
                issues.push({
                    code: "time-offset",
                    severity: "warning",
                    message: `\`{{time}}\` expects an offset like \`UTC+2\`; \`${value}\` falls back to local time.`,
                    macroIndex: macro.index,
                    start: macro.start,
                });
            }
        }
    }

    for (const issue of nameIssues.values()) {
        issues.push({
            code: issue.code,
            severity: issue.severity,
            message: issue.count > 1 ? `${issue.message} (×${issue.count})` : issue.message,
            macroIndex: issue.macroIndex,
            start: issue.start,
        });
    }

    // Fold nested-document issues into this document. Their offsets are
    // relative to the parent's `inner`, so shift them into parent space.
    // New-engine use is the default since ST 1.17: never surface it as a
    // warning, at any nesting level.
    for (const macro of macros) {
        if (!macro.nestedIssues) continue;
        for (const issue of macro.nestedIssues) {
            if (issue.code === "new-engine") continue;
            issues.push({
                ...issue,
                start: (issue.start ?? 0) + macro.nestedOffset,
                macroIndex: null,
            });
        }
    }

    /** @param {Macro[]} list @returns {Macro[]} */
    const flatten = (list) => {
        const out = [];
        for (const macro of list) {
            out.push(macro);
            if (macro.nested) out.push(...flatten(macro.nested));
        }
        return out;
    };

    const allMacros = flatten(macros);

    // Stable, useful ordering: errors before warnings, then source order.
    const severityRank = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => {
        const bySeverity = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
        if (bySeverity !== 0) return bySeverity;
        return (a.start ?? 0) - (b.start ?? 0);
    });

    // Attach locations to issues.
    for (const issue of issues) {
        const location = locate(lineStarts, issue.start ?? 0);
        issue.line = location.line;
        issue.column = location.column;
    }

    /** @type {Record<string, any>} */
    const byName = Object.create(null);
    /** @type {Record<string, number>} */
    const categories = Object.create(null);
    let comments = 0;
    let newEngineOnly = 0;

    for (const macro of allMacros) {
        const key = macro.lowerName || "(malformed)";
        let item = byName[key];
        if (!item) {
            item = byName[key] = {
                key,
                name: macro.name || "(malformed)",
                canonicalName: macro.canonicalName,
                category: macro.category,
                availability: macro.availability,
                known: macro.known,
                extension: macro.extension,
                dynamic: macro.dynamic,
                isVariable: false,
                variableScope: null,
                newEngineOnly: false,
                count: 0,
                comments: 0,
            };
        }
        item.count++;
        if (macro.isVariable) {
            item.isVariable = true;
            item.variableScope = macro.variable?.scope === "global" ? "global" : "local";
        }
        item.newEngineOnly ||= macro.newEngineOnly;
        if (macro.isComment) {
            item.comments++;
            comments++;
        }
        if (macro.newEngineOnly) newEngineOnly++;
        categories[macro.category] = (categories[macro.category] ?? 0) + 1;
    }

    // Shorthand variable notations (`.name` / `$name`) are collected per
    // scope so a prompt that leans on them can present two collapsible
    // groups instead of dozens of chips.
    const shorthandVars = { local: [], global: [] };
    for (const item of Object.values(byName)) {
        if (!item.isVariable) continue;
        shorthandVars[item.variableScope === "global" ? "global" : "local"].push(item);
    }

    const conditionals = [];
    for (const macro of macros) {
        if (macro.lowerName !== "if" || macro.isClosing) continue;
        if (macro.scope?.role === "open") {
            const pair = pairs[macro.scope.pairIndex];
            conditionals.push({
                mode: "block",
                condition: pair.condition,
                hasElse: pair.hasElse,
                pair,
            });
        } else if (macro.argCount >= 2) {
            conditionals.push({
                mode: "inline",
                condition: macro.args[0] ?? "",
                then: macro.args[1] ?? "",
                hasElse: false,
                macroIndex: macro.index,
            });
        }
    }

    const errors = issues.filter(issue => issue.severity === "error").length;
    const warnings = issues.filter(issue => issue.severity === "warning").length;
    const infos = issues.filter(issue => issue.severity === "info").length;

    return {
        text,
        expanded,
        enabled,
        field,
        kind,
        macros,
        allMacros,
        segments,
        scopes: pairs,
        conditionals,
        issues,
        stats: {
            total: allMacros.length,
            comments,
            errors,
            warnings,
            infos,
            newEngineOnly,
            unknown: allMacros.filter(macro => !macro.known && !macro.isVariable && !macro.malformed).length,
            extension: allMacros.filter(macro => macro.availability === "ext").length,
            dynamic: allMacros.filter(macro => macro.dynamic).length,
            byName,
            shorthandVars,
            categories,
            names: Object.keys(byName),
        },
    };
}
