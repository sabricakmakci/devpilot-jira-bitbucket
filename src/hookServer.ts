import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { Endpoint, IPC_DIR, NONCE_HEADER, ValidateResponse, isProcessAlive } from './ipc';

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Localhost-only server the commit-msg hook talks to. Jira credentials never leave
 * VS Code's SecretStorage; the hook only sends the commit message and gets a verdict.
 */
export class HookServer implements vscode.Disposable {
    private readonly nonce = crypto.randomBytes(32).toString('hex');
    private readonly endpointFile = path.join(IPC_DIR, `${process.pid}.json`);
    private readonly server = http.createServer((req, res) => void this.handle(req, res));
    private readonly folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => this.writeEndpoint());

    constructor(private readonly validate: (message: string) => Promise<ValidateResponse>) { }

    async start(): Promise<void> {
        fs.mkdirSync(IPC_DIR, { recursive: true, mode: 0o700 });
        removeStaleEndpoints();
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', resolve);
        });
        this.writeEndpoint();
    }

    private writeEndpoint(): void {
        const address = this.server.address() as AddressInfo | null;
        if (!address) {
            return;
        }
        const endpoint: Endpoint = {
            pid: process.pid,
            port: address.port,
            nonce: this.nonce,
            folders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
        };
        fs.writeFileSync(this.endpointFile, JSON.stringify(endpoint), { mode: 0o600 });
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const reply = (status: number, body?: ValidateResponse) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(body && JSON.stringify(body));
        };
        if (req.method !== 'POST' || req.url !== '/validate' || !this.isAuthorized(req.headers[NONCE_HEADER])) {
            reply(403);
            return;
        }
        let message: unknown;
        try {
            message = JSON.parse(await readBody(req)).message;
        } catch {
            reply(400);
            return;
        }
        if (typeof message !== 'string') {
            reply(400);
            return;
        }
        try {
            reply(200, await this.validate(message));
        } catch {
            reply(500);
        }
    }

    private isAuthorized(header: string | string[] | undefined): boolean {
        if (typeof header !== 'string') {
            return false;
        }
        const expected = Buffer.from(this.nonce);
        const actual = Buffer.from(header);
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }

    dispose(): void {
        this.folderListener.dispose();
        this.server.close();
        fs.rmSync(this.endpointFile, { force: true });
    }
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function removeStaleEndpoints(): void {
    for (const file of fs.readdirSync(IPC_DIR)) {
        const pid = Number.parseInt(file, 10);
        if (Number.isInteger(pid) && !isProcessAlive(pid)) {
            fs.rmSync(path.join(IPC_DIR, file), { force: true });
        }
    }
}
