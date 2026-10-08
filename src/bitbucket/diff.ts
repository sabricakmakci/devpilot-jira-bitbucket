export type LineType = 'ADDED' | 'REMOVED' | 'CONTEXT';

export interface DiffLine {
    type: LineType;
    text: string;
    /** Line number in the new version; undefined for removed lines. */
    newLine?: number;
}

export interface DiffHunk {
    newStart: number;
    newCount: number;
    lines: DiffLine[];
}

export interface FileDiff {
    /** Undefined for added files. */
    oldPath?: string;
    /** Undefined for deleted files. */
    newPath?: string;
    binary: boolean;
    hunks: DiffHunk[];
}

function diffPath(raw: string): string | undefined {
    let value = raw.replace(/\t.*$/, '').trim();
    if (value === '/dev/null') {
        return undefined;
    }
    if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
    }
    return value.replace(/^(a\/|b\/|src:\/\/|dst:\/\/)/, '');
}

/** Parses a unified git diff. */
export function parseDiff(text: string): FileDiff[] {
    const files: FileDiff[] = [];
    let file: FileDiff | undefined;
    let hunk: DiffHunk | undefined;
    let oldLeft = 0;
    let newLeft = 0;
    let newLine = 0;
    const startFile = () => {
        file = { binary: false, hunks: [] };
        files.push(file);
        hunk = undefined;
    };

    for (const line of text.split('\n')) {
        if (hunk && (oldLeft > 0 || newLeft > 0) && !line.startsWith('@@ ')) {
            const marker = line[0];
            const content = line.slice(1);
            if (marker === '+') {
                hunk.lines.push({ type: 'ADDED', text: content, newLine: newLine++ });
                newLeft--;
            } else if (marker === '-') {
                hunk.lines.push({ type: 'REMOVED', text: content });
                oldLeft--;
            } else if (marker === ' ' || line === '') {
                hunk.lines.push({ type: 'CONTEXT', text: content, newLine: newLine++ });
                oldLeft--;
                newLeft--;
            }
            continue;
        }
        if (line.startsWith('diff --git ')) {
            startFile();
            continue;
        }
        if (line.startsWith('--- ') && (!file || file.hunks.length > 0)) {
            startFile();
        }
        if (!file) {
            continue;
        }
        const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header) {
            oldLeft = header[1] === undefined ? 1 : Number(header[1]);
            newLine = Number(header[2]);
            newLeft = header[3] === undefined ? 1 : Number(header[3]);
            hunk = { newStart: newLine, newCount: newLeft, lines: [] };
            file.hunks.push(hunk);
        } else if (line.startsWith('--- ')) {
            file.oldPath = diffPath(line.slice(4));
        } else if (line.startsWith('+++ ')) {
            file.newPath = diffPath(line.slice(4));
        } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
            file.binary = true;
        }
    }
    return files;
}

/** Rebuilds the old version of a file from its new version by reverting the hunks. */
export function reconstructOld(newText: string, file: FileDiff): string {
    if (!file.oldPath) {
        return '';
    }
    const lines = newText.split('\n');
    const result: string[] = [];
    let cursor = 0;
    for (const hunk of [...file.hunks].sort((a, b) => a.newStart - b.newStart)) {
        const start = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
        result.push(...lines.slice(cursor, start));
        result.push(...hunk.lines.filter(line => line.type !== 'ADDED').map(line => line.text));
        cursor = start + hunk.newCount;
    }
    result.push(...lines.slice(cursor));
    return result.join('\n');
}

/** Supports `**`, `*` and `?`. */
export function globToRegExp(glob: string): RegExp {
    let source = '';
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i];
        if (char === '*' && glob[i + 1] === '*') {
            if (glob[i + 2] === '/') {
                source += '(?:.*/)?';
                i += 2;
            } else {
                source += '.*';
                i++;
            }
        } else if (char === '*') {
            source += '[^/]*';
        } else if (char === '?') {
            source += '[^/]';
        } else {
            source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`);
}
