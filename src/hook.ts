// Entry point of the git commit-msg hook. Runs outside VS Code via ELECTRON_RUN_AS_NODE,
// so it must not import 'vscode'. It forwards the commit message to a running VS Code window.
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { Endpoint, IPC_DIR, NONCE_HEADER, ValidateResponse, isInside, isProcessAlive } from './ipc';

const PREFIX = '[devpilot]';

function readEndpoints(cwd: string): Endpoint[] {
    let files: string[];
    try {
        files = fs.readdirSync(IPC_DIR).filter(file => file.endsWith('.json'));
    } catch {
        return [];
    }
    const endpoints: Endpoint[] = [];
    for (const file of files) {
        try {
            const endpoint = JSON.parse(fs.readFileSync(path.join(IPC_DIR, file), 'utf8')) as Endpoint;
            if (isProcessAlive(endpoint.pid)) {
                endpoints.push(endpoint);
            }
        } catch {
            // Ignore unreadable or half-written endpoint files.
        }
    }
    // Prefer the window that has this repository open, so the dialog shows up there.
    const rank = (endpoint: Endpoint) =>
        endpoint.folders.some(folder => isInside(cwd, folder) || isInside(folder, cwd)) ? 0 : 1;
    return endpoints.sort((a, b) => rank(a) - rank(b));
}

function validate(endpoint: Endpoint, message: string): Promise<ValidateResponse> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ message });
        const req = http.request(
            {
                host: '127.0.0.1',
                port: endpoint.port,
                path: '/validate',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    [NONCE_HEADER]: endpoint.nonce,
                },
            },
            res => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(body) as ValidateResponse);
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );
        req.on('error', reject);
        req.end(data);
    });
}

async function main(): Promise<number> {
    const messageFile = process.argv[2];
    if (!messageFile) {
        return 0;
    }
    const message = fs.readFileSync(messageFile, 'utf8');
    for (const endpoint of readEndpoints(process.cwd())) {
        let result: ValidateResponse;
        try {
            result = await validate(endpoint, message);
        } catch {
            continue;
        }
        for (const line of result.messages) {
            console.error(`${PREFIX} ${line}`);
        }
        if (!result.allow) {
            console.error(`${PREFIX} Commit aborted.`);
        }
        return result.allow ? 0 : 1;
    }
    console.error(`${PREFIX} VS Code is not running; the commit message was not checked.`);
    return 0;
}

main().then(
    code => process.exit(code),
    error => {
        console.error(`${PREFIX} ${error}`);
        process.exit(0);
    },
);
