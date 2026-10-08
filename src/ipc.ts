// Shared between the extension and the standalone hook script (must not import 'vscode').
import * as os from 'os';
import * as path from 'path';

export const IPC_DIR = path.join(os.homedir(), '.jira-bitbucket-flow', 'ipc');
export const NONCE_HEADER = 'x-jira-bitbucket-flow-nonce';

/** Written by each VS Code window so the hook can find a running extension. */
export interface Endpoint {
    pid: number;
    port: number;
    nonce: string;
    folders: string[];
}

export interface ValidateResponse {
    allow: boolean;
    messages: string[];
}

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export function isInside(child: string, parent: string): boolean {
    const normalize = (value: string) => {
        const resolved = path.resolve(value);
        return process.platform === 'linux' ? resolved : resolved.toLowerCase();
    };
    const relative = path.relative(normalize(parent), normalize(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
