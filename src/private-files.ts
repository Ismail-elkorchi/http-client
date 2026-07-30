import fs from "node:fs/promises";

export async function ensurePrivateDirectory(
  directory: string,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

export async function openPrivateFile(
  filePath: string,
): Promise<fs.FileHandle> {
  const handle = await fs.open(filePath, "wx", 0o600);
  if (process.platform !== "win32") await handle.chmod(0o600);
  return handle;
}
