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
const markdownExportButton = document.getElementById("markdown-export");

// identifier: { content, name, role, booleans }
let prompts = {};

// [ { enabled, identifier }, ... ]
let promptOrder = [];

function isJsonAPreset(json) {
    const jsonKeys = Object.keys(json);

    return UTILITY_PROMPTS_KEYS.every(key => jsonKeys.includes(key));
}

function createPromptSections(identifier) {
    const prompt = prompts[identifier];

    if (!prompt) return;

    let namePrefix = "";

    const elemDetails = document.createElement("details");
    const elemSummary = document.createElement("summary");

    elemDetails.id = `prompt-${identifier}`;
    elemSummary.textContent = prompt.name;
    elemDetails.appendChild(elemSummary);
    
    const elemPromptContent = document.createElement("pre");
    elemPromptContent.textContent = prompt.content;
    elemDetails.appendChild(elemPromptContent);

    elemDetails.classList.add(`role-${prompt.role}`);

    if (prompt.marker) {
        elemDetails.classList.add("marker");
    }
    
    if (prompt.injection_position > 0) {
        elemDetails.classList.add("injected");
        elemSummary.dataset.depth = prompt.injection_depth;
    }

    return elemDetails;
}

async function loadPresetFromJson(file) {
    const reader = new FileReader();
    
    reader.addEventListener("load", () => {
        const json = JSON.parse(reader.result);
        if (!isJsonAPreset(json)) {
            alert("The selected file is not a valid preset JSON.");
            return;
        }

        extractPresetData(json);
        displayPrompts();
    });

    reader.readAsText(file);
}

function resetEverything() {
    mainContainer.innerHTML = "";
    prompts = {};
    promptOrder = [];
    markdownExportButton.setAttribute("disabled", true);
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
     * prompt order has a lot of "versions" inside of the presets.
     * `prompt_order: [ { character_id, order }, ... ]`
     * I'm unsure on why that's the case, and peeking in the files show different
     * orders of prompts, and yet ST uses the last one.
     */
    json["prompt_order"].at(-1).order.forEach(i => promptOrder.push(i));

    console.log("prompts:", prompts);
    console.log("prompt_order:", promptOrder);
}

function displayPrompts() {
    mainContainer.innerHTML = "";

    promptOrder.forEach(prompt => {
        const promptElement = createPromptSections(prompt.identifier);
        const enabledClass = prompt.enabled ? "prompt-enabled" : "prompt-disabled";
        
        if (!promptElement) { return; }

        promptElement.classList.add(enabledClass);

        mainContainer.appendChild(promptElement);
    });

    markdownExportButton.removeAttribute("disabled");
}

async function loadJsonFromInputs() {
    const fileInput = document.getElementById("file-input");
    const file = fileInput.files[0];

    if (!file) {
        alert("Please select a JSON file.");
        return;
    }

    resetEverything();
    loadPresetFromJson(file);
}

loadButton.addEventListener("click", loadJsonFromInputs);
fileInput.addEventListener("change", loadJsonFromInputs);
markdownExportButton.addEventListener("click", () => {
    const presetName = extractFilename(fileInput.value)
        .replace(".json", "");
    downloadMarkdown(presetName, prompts, promptOrder);
});
