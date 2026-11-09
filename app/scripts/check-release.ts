/** Verify desktop release metadata before packaging or creating a draft release. */
const appDirectory = new URL("../", import.meta.url);
const manifest = await Bun.file(new URL("package.json", appDirectory)).json();
const config = await Bun.file(new URL("src-tauri/tauri.conf.json", appDirectory)).json();
const cargo = Bun.TOML.parse(await Bun.file(new URL("src-tauri/Cargo.toml", appDirectory)).text()) as {
	package: { version: string };
};
const lock = Bun.TOML.parse(await Bun.file(new URL("src-tauri/Cargo.lock", appDirectory)).text()) as {
	package: { name: string; version: string }[];
};
const version: string = manifest.version;
const versions = {
	"tauri.conf.json": config.version,
	"Cargo.toml": cargo.package.version,
	"Cargo.lock": lock.package.find(entry => entry.name === "open-transcribe-app")?.version,
};
for (const [file, found] of Object.entries(versions)) {
	if (found !== version) throw new Error(`${file} has version ${found}; expected ${version}.`);
}
const expectedTag = `v${version}`;
const tag = process.argv[2] ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
if (tag !== undefined && tag !== expectedTag) throw new Error(`Release tag ${tag} does not match ${expectedTag}.`);
const notes = await Bun.file(new URL(`../docs/releases/${expectedTag}.md`, appDirectory)).text();
if (notes.trim() === "") throw new Error(`Release notes for ${expectedTag} are empty.`);
console.log(`Desktop release ${expectedTag}: versions and release notes match.`);
