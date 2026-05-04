import 'dotenv/config';
import { spawn } from 'child_process';

const HOST = process.env.HOST;
if (!HOST) throw new Error("HOST env var is required");

const tokens = Object.entries(process.env)
    .filter(([k]) => /^TOKEN_\d+$/.test(k))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, v]) => v);

if (tokens.length === 0) {
    console.error("No TOKEN_N variables found in .env — add TOKEN_1, TOKEN_2, … to run baseline instances.");
    process.exit(1);
}

console.log(`Launching ${tokens.length} baseline agent(s)…`);

for (const [i, token] of tokens.entries()) {
    const label = `baseline-${i + 1}`;
    const child = spawn('node', ['src_baseline/index.js'], {
        env: { ...process.env, TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`));
    child.on('exit', code => console.log(`[${label}] exited with code ${code}`));

    console.log(`[${label}] started (pid ${child.pid})`);
}
