import { download } from "./download.js";

"use strict";

function tag(name) {
    // different preset makers use different "tags" in their configs
    // might as well use something so outrageous to minimize collision.
    return `<<!!__||[[@@${name}@@]]||__!!>>`;
}

const markdownHeader = `
# ${tag("header")}
`.trim();

const promptLayout = `
### ${tag("name")}

|   |   |
| --- | --- |
| Enabled | ${tag("enabled")} |
| Role | ${tag("role")} |
| System Prompt | ${tag("system_prompt")} |
| Marker | ${tag("marker")} |
| Position | ${tag("injection_position")} @${tag("injection_depth")} |

\`\`\`
${tag("content")}
\`\`\`
`.trim();

const markdownLayout = `
${tag("header")}

## Preset Prompts

${tag("prompts")}
`.trim();

function buildPrompts(prompts, promptOrder) {
    let sections = [];

    promptOrder.forEach(item => {
        const prompt = structuredClone(prompts[item.identifier]);

        // prioritze promptOrder item's enabled flag, instead of the prompt's
        prompt.enabled = item.enabled;

        // actually use words for injection_position
        prompt.injection_position = prompt.injection_position ? "In-chat" : "Relative";

        let section = promptLayout;
        Object.keys(prompt).forEach(key => section = section.replaceAll(tag(key), prompt[key]));
        sections.push(section);
    });

    return sections.join('\n\n');
}

function buildMarkdownContent(heading, promptsSection) {
    return markdownLayout
        .replace(tag("header"), heading)
        .replace(tag("prompts"), promptsSection);
}

export function downloadMarkdown(presetName, prompts, promptOrder) {
    const heading = markdownHeader.replace(tag("header"), presetName);
    const promptsSection = buildPrompts(prompts, promptOrder);
    const content = buildMarkdownContent(heading, promptsSection);

    download(content, "text/markdown", `${presetName}.md`);
}