import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { isInside } from './ipc';

const execFileAsync = promisify(execFile);
const HOOK_NAME = 'commit-msg';
const MARKER = '# Managed by the DevPilot for Jira & Bitbucket VS Code extension. Do not edit.';
// Hooks written before the rename must still be recognized as ours.
const LEGACY_MARKER = '# Managed by the Jira & Bitbucket Flow VS Code extension. Do not edit.';

function isManaged(content: string | undefined): boolean {
    return !!content && (content.includes(MARKER) || content.includes(LEGACY_MARKER));
}

/** 'unsupported': hooks live outside .git (core.hooksPath, husky...), we don't touch tracked files. */
export type HookState = 'missing' | 'managed' | 'foreign' | 'unsupported';

export class HookInstaller {
    constructor(private readonly gitPath: string, private readonly hookScript: string) { }

    async state(repoRoot: string): Promise<HookState> {
        const { hooksDir, gitDir } = await this.locate(repoRoot);
        if (!isInside(hooksDir, gitDir)) {
            return 'unsupported';
        }
        const existing = readIfExists(path.join(hooksDir, HOOK_NAME));
        if (existing === undefined) {
            return 'missing';
        }
        return isManaged(existing) ? 'managed' : 'foreign';
    }

    /** Also used to refresh the hook after VS Code or the extension moved to a new path. */
    async install(repoRoot: string): Promise<void> {
        const { hooksDir } = await this.locate(repoRoot);
        const file = path.join(hooksDir, HOOK_NAME);
        const existing = readIfExists(file);
        const content = this.content();
        if (existing === content) {
            return;
        }
        if (existing !== undefined && !isManaged(existing)) {
            fs.renameSync(file, backupPath(file));
        }
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.writeFileSync(file, content);
        fs.chmodSync(file, 0o755);
    }

    async uninstall(repoRoot: string): Promise<boolean> {
        const file = path.join((await this.locate(repoRoot)).hooksDir, HOOK_NAME);
        if (!isManaged(readIfExists(file))) {
            return false;
        }
        fs.rmSync(file);
        return true;
    }

    private async locate(repoRoot: string): Promise<{ hooksDir: string; gitDir: string }> {
        const revParse = async (...args: string[]) => {
            const { stdout } = await execFileAsync(this.gitPath, ['rev-parse', ...args], { cwd: repoRoot });
            return path.resolve(repoRoot, stdout.trim());
        };
        return { hooksDir: await revParse('--git-path', 'hooks'), gitDir: await revParse('--git-common-dir') };
    }

    private content(): string {
        // VS Code's own executable acts as Node.js, so users don't need Node or Python installed.
        const node = shellQuote(toPosixPath(process.execPath));
        const script = shellQuote(toPosixPath(this.hookScript));
        return [
            '#!/bin/sh',
            MARKER,
            `NODE=${node}`,
            `SCRIPT=${script}`,
            'if [ -x "$NODE" ] && [ -f "$SCRIPT" ]; then',
            '  ELECTRON_RUN_AS_NODE=1 "$NODE" "$SCRIPT" "$1" || exit $?',
            'else',
            '  echo "[devpilot] Extension not found; the commit message was not checked." >&2',
            'fi',
            '',
        ].join('\n');
    }
}

function readIfExists(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

function backupPath(file: string): string {
    const backup = `${file}.backup`;
    return fs.existsSync(backup) ? `${backup}-${Date.now()}` : backup;
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toPosixPath(value: string): string {
    return value.replace(/\\/g, '/');
}
