/**
 * Get an array of files to be skipped from the backport PR.
 * Filtering out empty strings.
 */
const getFilesToSkip = (input: string | undefined): string[] => {
  if (input === undefined || input === "") {
    return [];
  }

  const files_to_skip = input.split(",");
  return files_to_skip.map((v) => v.trim()).filter((v) => v !== "");
};

export { getFilesToSkip };
