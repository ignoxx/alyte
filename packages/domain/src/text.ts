/**
 * Normalize user-visible aliases without depending on the device's ambient locale.
 * This is the shared matching contract for extraction and user-entered Measurements.
 */
export function normalizeAlias(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
