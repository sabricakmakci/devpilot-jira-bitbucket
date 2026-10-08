import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';

// Subset of the built-in Git extension API (extensions/git/src/api/git.d.ts).
export interface InputBox {
    value: string;
}

export interface Remote {
    readonly name: string;
    readonly fetchUrl?: string;
    readonly pushUrl?: string;
}

export interface Branch {
    readonly name?: string;
    readonly commit?: string;
}

export interface Repository {
    readonly rootUri: vscode.Uri;
    readonly inputBox: InputBox;
    readonly state: { readonly remotes: Remote[]; readonly HEAD?: Branch };
    createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
    checkout(treeish: string): Promise<void>;
}

export interface API {
    readonly git: { readonly path: string };
    readonly repositories: Repository[];
    readonly onDidOpenRepository: vscode.Event<Repository>;
    readonly onDidCloseRepository: vscode.Event<Repository>;
    getRepository(uri: vscode.Uri): Repository | null;
}

interface GitExtension {
    getAPI(version: 1): API;
}

export async function getGitApi(): Promise<API | undefined> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) {
        return undefined;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.getAPI(1);
}

export async function pickRepository(git: API): Promise<Repository | undefined> {
    if (git.repositories.length <= 1) {
        return git.repositories[0];
    }
    const activeDocument = vscode.window.activeTextEditor?.document.uri;
    const fromEditor = activeDocument && git.getRepository(activeDocument);
    if (fromEditor) {
        return fromEditor;
    }
    const pick = await vscode.window.showQuickPick(
        git.repositories.map(repo => ({ label: path.basename(repo.rootUri.fsPath), description: repo.rootUri.fsPath, repo })),
        { placeHolder: l10n.t('Select a repository') },
    );
    return pick?.repo;
}

export interface RemoteLocation {
    /** Lower-case host name without port. */
    host: string;
    /** Lower-case last two path segments without `.git`, e.g. `proj/repo`. */
    path: string;
}

/** Handles https://host/scm/proj/repo.git, ssh://git@host:7999/proj/repo.git and git@host:ws/repo.git. */
export function parseRemoteUrl(url: string): RemoteLocation | undefined {
    let host: string;
    let pathname: string;
    const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(url);
    if (scp) {
        [, host, pathname] = scp;
    } else {
        try {
            const parsed = new URL(url);
            host = parsed.hostname;
            pathname = parsed.pathname;
        } catch {
            return undefined;
        }
    }
    const segments = pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (!host || segments.length < 2) {
        return undefined;
    }
    return { host: host.toLowerCase(), path: segments.slice(-2).join('/').toLowerCase() };
}

export function remoteLocations(git: API): RemoteLocation[] {
    return git.repositories.flatMap(repo =>
        repo.state.remotes.flatMap(remote => {
            const location = parseRemoteUrl(remote.fetchUrl ?? remote.pushUrl ?? '');
            return location ? [location] : [];
        }),
    );
}

/** Finds an open repository with a remote pointing at one of the given `project/repo` paths. */
export function findRepository(git: API, host: string, repoPaths: string[]): Repository | undefined {
    const wanted = new Set(repoPaths.map(repoPath => repoPath.toLowerCase()));
    return git.repositories.find(repo =>
        repo.state.remotes.some(remote => {
            const location = parseRemoteUrl(remote.fetchUrl ?? remote.pushUrl ?? '');
            return location?.host === host.toLowerCase() && wanted.has(location.path);
        }),
    );
}
