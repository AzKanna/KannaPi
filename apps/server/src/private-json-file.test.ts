import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writePrivateJsonFile } from "./private-json-file.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});
async function file() {
  const directory = await fs.mkdtemp(join(tmpdir(), "kanna-private-json-"));
  directories.push(directory);
  return join(directory, "config.json");
}
function failure(code: string) {
  return Object.assign(new Error(code), { code });
}
const exdev = () => Promise.reject(failure("EXDEV"));

test("normal save uses atomic rename and removes staging file", async () => {
  const path = await file(),
    rename = vi.fn(fs.rename),
    copyFile = vi.fn(fs.copyFile);
  await writePrivateJsonFile(path, { key: "test-only" }, { ...fs, rename, copyFile });
  expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ key: "test-only" });
  expect(rename).toHaveBeenCalledTimes(1);
  expect(copyFile).not.toHaveBeenCalled();
  await expect(fs.stat(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
});
test("EXDEV fallback supports first save and replaces existing file", async () => {
  const path = await file();
  await writePrivateJsonFile(path, { key: "first" }, { ...fs, rename: exdev });
  await writePrivateJsonFile(path, { key: "second" }, { ...fs, rename: exdev });
  expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ key: "second" });
  await expect(fs.stat(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
});
test("permission errors do not fall back or overwrite previous configuration", async () => {
  const path = await file();
  await fs.writeFile(path, '{"key":"original"}');
  const copyFile = vi.fn(fs.copyFile);
  await expect(
    writePrivateJsonFile(
      path,
      { key: "new" },
      { ...fs, rename: () => Promise.reject(failure("EACCES")), copyFile },
    ),
  ).rejects.toMatchObject({ code: "EACCES" });
  expect(copyFile).not.toHaveBeenCalled();
  expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ key: "original" });
  expect(JSON.parse(await fs.readFile(`${path}.tmp`, "utf8"))).toEqual({ key: "new" });
});
test("failed cross-device copy restores old data and retains the staged new data", async () => {
  const path = await file();
  await fs.writeFile(path, '{"key":"original"}');
  const copyFile = async (_source: PathLike, destination: PathLike) => {
    await fs.writeFile(destination, "partial");
    throw failure("EIO");
  };
  await expect(
    writePrivateJsonFile(path, { key: "new" }, { ...fs, rename: exdev, copyFile }),
  ).rejects.toMatchObject({ code: "EIO" });
  expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ key: "original" });
  expect(JSON.parse(await fs.readFile(`${path}.tmp`, "utf8"))).toEqual({ key: "new" });
});
test("failed first cross-device copy removes partial target but preserves staging file", async () => {
  const path = await file();
  const copyFile = async (_source: PathLike, destination: PathLike) => {
    await fs.writeFile(destination, "partial");
    throw failure("EIO");
  };
  await expect(
    writePrivateJsonFile(path, { key: "new" }, { ...fs, rename: exdev, copyFile }),
  ).rejects.toMatchObject({ code: "EIO" });
  await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await fs.readFile(`${path}.tmp`, "utf8"))).toEqual({ key: "new" });
});
