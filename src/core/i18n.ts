export type Locale = "en" | "zh-CN";

export const DEFAULT_LOCALE: Locale = "en";

/**
 * Normalize a user-supplied locale. Unknown or unsupported values fall back to
 * the default English locale rather than making every command fail.
 */
export function normalizeLocale(value: string | undefined): Locale | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (["zh", "zh-cn", "zh-hans", "zh-hans-cn"].includes(normalized)) return "zh-CN";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return undefined;
}

/**
 * `TUILENS_LANG` is intentionally explicit. Host `LANG`/`LC_ALL` values do not
 * change the default, so English remains the stable default across platforms.
 */
export function resolveLocale(value = process.env.TUILENS_LANG): Locale {
  return normalizeLocale(value) ?? DEFAULT_LOCALE;
}

/** Select a value for the current locale. */
export function pick(en: string, zh: string, locale = resolveLocale()): string {
  return locale === "zh-CN" ? zh : en;
}
