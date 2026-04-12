import path from "node:path";

export function normalizeVaultPath(inputPath: string): string {
  const trimmed = inputPath.trim();

  if (!trimmed) {
    throw new Error("Path is required.");
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/");

  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid vault path: ${inputPath}`);
  }

  return parts.join("/");
}

export function resolveVaultPath(root: string, relativePath: string): string {
  const safeRelativePath = normalizeVaultPath(relativePath);
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, safeRelativePath);

  if (
    absolutePath !== absoluteRoot &&
    !absolutePath.startsWith(`${absoluteRoot}${path.sep}`)
  ) {
    throw new Error(`Path escapes vault root: ${relativePath}`);
  }

  return absolutePath;
}

export function toVaultRelativePath(root: string, absolutePath: string): string {
  const absoluteRoot = path.resolve(root);
  const relative = path.relative(absoluteRoot, absolutePath);
  return normalizeVaultPath(relative);
}
