"use strict";

/**
 * Preset-wide variable index for the editor's outline panel.
 *
 * Pure module: no DOM, no evaluation. It reuses the viewer's parser and turns
 * variable-related macros into definition (`write`) and reference (`read`)
 * sites that the editor can list, group, and jump to.
 *
 * Two syntaxes are covered:
 *   - call form: {{setvar::name::value}}, {{getvar::name}}, ... (local),
 *     {{setglobalvar::name::value}}, {{getglobalvar::name}}, ... (global);
 *   - shorthand: {{.name}}, {{.name = 5}}, {{.name++}} (local),
 *     {{$name}}, {{$name ??= 1}} (global).
 *
 * A site is only a claim about this file. Variables can also be created by
 * ST, extensions, or an earlier chat, so "0 definitions" is not an error.
 */

import { analyzeMacros, computeLineStarts, locate } from "./macros.js";

/**
 * Regular variable macros keyed by the registry's canonical name, so aliases
 * (varexists, flushvar, setvarindex, ...) resolve to the same bucket.
 * `write` covers creating, changing, and deleting; `read` covers reading.
 */
const VARIABLE_CALLS = Object.freeze({
    setvar: { scope: "local", access: "write" },
    addvar: { scope: "local", access: "write" },
    incvar: { scope: "local", access: "write" },
    decvar: { scope: "local", access: "write" },
    setvarkey: { scope: "local", access: "write" },
    deletevar: { scope: "local", access: "write" },
    getvar: { scope: "local", access: "read" },
    getvarkey: { scope: "local", access: "read" },
    hasvar: { scope: "local", access: "read" },
    setglobalvar: { scope: "global", access: "write" },
    addglobalvar: { scope: "global", access: "write" },
    incglobalvar: { scope: "global", access: "write" },
    decglobalvar: { scope: "global", access: "write" },
    setglobalvarkey: { scope: "global", access: "write" },
    deleteglobalvar: { scope: "global", access: "write" },
    getglobalvar: { scope: "global", access: "read" },
    getglobalvarkey: { scope: "global", access: "read" },
    hasglobalvar: { scope: "global", access: "read" },
});

// Shorthand operators that write. Everything else (none, ??, ||, ==, ...)
// only reads: the parser treats comparisons as reads too.
const WRITE_OPERATORS = new Set(["=", "+=", "-=", "++", "--", "??=", "||="]);

const VALUE_LIMIT = 60;

function cleanValue(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}…` : text;
}

/**
 * @param {any} macro
 * @param {any} doc
 * @param {number} start Absolute offset of the macro in the document.
 * @returns {Object|null}
 */
function makeSite(macro, doc, start) {
    if (!macro || macro.malformed || macro.isClosing) return null;

    let name;
    let scope;
    let access;
    let operator = null;
    let value = null;

    if (macro.isVariable) {
        name = macro.variable?.name ?? "";
        if (!name) return null;
        scope = macro.variable.scope === "global" ? "global" : "local";
        operator = macro.variable.operator ?? null;
        access = operator && WRITE_OPERATORS.has(operator) ? "write" : "read";
        if (operator) value = cleanValue(macro.variable.value) || null;
    } else {
        const call = VARIABLE_CALLS[String(macro.canonicalName ?? "").toLowerCase()];
        if (!call) return null;
        name = String(macro.args[0] ?? "").trim();
        // A name built from another macro cannot be resolved statically.
        if (!name || name.includes("{{")) return null;
        scope = call.scope;
        access = call.access;
        if (access === "write" && macro.args.length > 1) {
            value = cleanValue(macro.args.slice(1).join(" :: ")) || null;
        }
    }

    return {
        id: doc.id,
        kind: doc.kind,
        label: doc.label,
        note: doc.note ?? "",
        name,
        scope,
        access,
        macro: macro.name,
        operator,
        value,
        raw: macro.raw,
        line: 1,
        column: 1,
        start,
        end: start + macro.raw.length,
    };
}

function addSite(variables, byKey, site) {
    const key = `${site.scope}:${site.name}`;
    let variable = byKey.get(key);
    if (!variable) {
        variable = {
            key,
            name: site.name,
            scope: site.scope,
            writes: [],
            reads: [],
        };
        byKey.set(key, variable);
        variables.push(variable);
    }
    (site.access === "write" ? variable.writes : variable.reads).push(site);
}

/**
 * Build the index.
 *
 * @param {Array<{id: string, kind: 'prompt'|'utility', label: string,
 *                text: string, note?: string, enabled?: boolean,
 *                expanded?: boolean}>} documents
 *   Documents in evaluation order. Positions are reported relative to each
 *   document's own text, so the editor can select them in its textarea.
 * @returns {{variables: Array, byKey: Map<string, any>}}
 */
export function collectVariables(documents) {
    const variables = [];
    const byKey = new Map();

    for (const doc of documents ?? []) {
        if (!doc || typeof doc.text !== "string" || doc.text.length === 0) continue;

        const analysis = analyzeMacros(doc.text, {
            kind: doc.kind === "utility" ? "utility" : "prompt",
            field: doc.kind === "utility" ? doc.id : null,
            enabled: doc.enabled !== false,
            expanded: doc.expanded !== false,
        });

        const lineStarts = computeLineStarts(doc.text);

        // Nested macros keep coordinates relative to their parent's `inner`,
        // so walk with an offset instead of using `allMacros` as-is.
        const visit = (macros, offset) => {
            for (const macro of macros) {
                const start = offset + macro.start;
                const site = makeSite(macro, doc, start);
                if (site) {
                    const location = locate(lineStarts, start);
                    site.line = location.line;
                    site.column = location.column;
                    addSite(variables, byKey, site);
                }
                if (macro.nested) visit(macro.nested, start + 2);
            }
        };

        visit(analysis.macros, 0);
    }

    variables.sort((a, b) => {
        if (a.scope !== b.scope) return a.scope === "local" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    return { variables, byKey };
}
