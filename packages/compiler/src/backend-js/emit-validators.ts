/** Sanitize a name to a JS binding identifier (e.g. for a referenced factory import). */
export function factoryIdent(name: string): string {
    return name.replace(/-/g, "_");
}
