import {readFileSync} from 'node:fs';

const isSectionEnd = (line: string): boolean => line.startsWith('## [') || /^\[[^\]]+\]: /.test(line);

/** The body of a version's section in a Keep a Changelog file, or undefined when the section is missing or empty. */
export const extractReleaseNotes = (changelog: string, version: string): string | undefined => {
	const lines = changelog.split('\n');
	const headingIndex = lines.findIndex(line => line.startsWith(`## [${version}]`));
	if (headingIndex === -1) {
		return undefined;
	}

	const body = lines.slice(headingIndex + 1);
	const endIndex = body.findIndex(line => isSectionEnd(line));
	const notes = body.slice(0, endIndex === -1 ? undefined : endIndex).join('\n').trim();
	return notes === '' ? undefined : notes;
};

if (import.meta.main) {
	const version = process.argv[2] ?? '';
	const notes = extractReleaseNotes(readFileSync('CHANGELOG.md', 'utf8'), version);
	if (notes === undefined) {
		console.error(`CHANGELOG.md has no entries for ${version}. Add a "## [${version}] - YYYY-MM-DD" section before tagging.`);
		process.exit(1);
	}

	console.log(notes);
}
