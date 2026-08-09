import fs from "node:fs/promises";

export async function ensureStorageDirectory(
  directory: string,
): Promise<void> {
  const created = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (created !== undefined && process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
  }
}

export async function openPrivateFile(
  filePath: string,
): Promise<fs.FileHandle> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    return handle;
  } catch (caught) {
    const cleanupFailures: unknown[] = [];
    try {
      await handle.close();
    } catch (closeFailure) {
      cleanupFailures.push(closeFailure);
    }
    try {
      await fs.rm(filePath, { force: true });
    } catch (removalFailure) {
      cleanupFailures.push(removalFailure);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [caught, ...cleanupFailures],
        "Private response file setup and cleanup failed.",
      );
    }
    throw caught;
  }
}
