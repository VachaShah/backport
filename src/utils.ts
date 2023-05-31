/**
 * Converts a comma-delimited string into an array of strings while eliminating
 * empty strings.
 */
export const parseCommaDelimitedStrings = (input?: string): string[] =>
  input
    ?.split?.(",")
    .map((item) => item.trim())
    .filter((item) => item)
    .filter((item, idx, labels) => labels.indexOf(item) === idx) ?? [];
