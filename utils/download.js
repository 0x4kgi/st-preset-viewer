// Source - https://stackoverflow.com/a/64908345
// Posted by Stelios333, modified by community. See post 'Timeline' for change history
// Retrieved 2026-10-16, License - CC BY-SA 4.0
export function download(content, mimeType, filename) {
    const a = document.createElement('a') // Create "a" element
    const blob = new Blob([content], { type: mimeType }) // Create a blob (file-like object)
    const url = URL.createObjectURL(blob) // Create an object URL from blob
    a.setAttribute('href', url) // Set "a" element link
    a.setAttribute('download', filename) // Set download filename
    a.click() // Start downloading
}

// https://html.spec.whatwg.org/multipage/input.html#fakepath-srsly
export function extractFilename(path) {
    if (path.substr(0, 12) == "C:\\fakepath\\")
        return path.substr(12); // modern browser
    let x;
    x = path.lastIndexOf('/');
    if (x >= 0) // Unix-based path
        return path.substr(x + 1);
    x = path.lastIndexOf('\\');
    if (x >= 0) // Windows-based path
        return path.substr(x + 1);
    return path; // just the filename
}