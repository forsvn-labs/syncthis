// Neutral public wording for diagnostics. Pure text policy shared by the CLI
// and TUI adapters; it must never import a renderer or a screen.

export function neutralPluginText(value: unknown, fallback = "plugin reach unavailable"): string {
  return String(value ?? fallback)
    .replace(/\bnpx\b/gi, "plugin wrapper")
    .replace(/\bskills?\b/gi, "plugin content")
    .replace(/\bmcp\b/gi, "plugin wrapper");
}
