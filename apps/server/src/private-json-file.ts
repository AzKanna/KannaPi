import * as fs from "node:fs/promises";
import { dirname } from "node:path";

type FileOperations = Pick<
  typeof fs,
  "mkdir" | "writeFile" | "readFile" | "chmod" | "rename" | "copyFile" | "unlink"
>;

/** Prefer atomic replacement; MSIX redirected AppData can report EXDEV even for sibling paths. */
export async function writePrivateJsonFile(
  path: string,
  value: unknown,
  files: FileOperations = fs,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await files.mkdir(dirname(path), { recursive: true });
  await files.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flush: true });
  await files.chmod(temporary, 0o600);
  try {
    await files.rename(temporary, path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }

  // Only EXDEV permits this non-atomic fallback. Keep staging data for recovery if copying fails.
  let previous: Buffer | undefined;
  try {
    previous = await files.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await files.copyFile(temporary, path);
    await files.chmod(path, 0o600);
  } catch (error) {
    try {
      if (previous !== undefined) await files.writeFile(path, previous, { mode: 0o600, flush: true });
      else
        await files.unlink(path).catch((cleanupError: NodeJS.ErrnoException) => {
          if (cleanupError.code !== "ENOENT") throw cleanupError;
        });
    } catch {
      throw new Error(
        "Configuration save failed and the previous file could not be restored. The staged .tmp file was retained; do not delete it.",
      );
    }
    throw error;
  }
  // The destination is now committed: cleanup failure must not make the caller retain stale state.
  await files.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT")
      console.warn("Saved configuration; temporary-file cleanup failed:", error.code);
  });
}
