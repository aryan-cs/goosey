/** Fresh validator + SQLite + browser journey. Never uses an existing chain. */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { getAddressDecoder } from '@solana/kit';
import { startChainMarketBrowserChain } from './lib/chain-market-browser-localnet.ts';
const root = process.cwd();
mkdirSync(`${root}/output/playwright/chain-market`, { recursive: true });
const db = `${root}/output/playwright/chain-market/qa-${Date.now()}.db`;
if (existsSync(`${root}/.next-sandbox/dev/lock`))
    throw Error('An existing sandbox server owns the build directory');
const pair = generateKeyPairSync('ed25519');
const addressOf = key => getAddressDecoder().decode(key.export({ type: 'spki', format: 'der' }).subarray(-32));
const sender = addressOf(pair.publicKey);
const recipient = addressOf(generateKeyPairSync('ed25519').publicKey);
let chain, server, browserProcess, reservation;
let interrupted = false;
const stopped = child => !child || child.exitCode !== null || child.signalCode !== null;
async function stopChild(child) {
    if (stopped(child))
        return;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM');
    const force = setTimeout(() => { if (!stopped(child))
        child.kill('SIGKILL'); }, 5000);
    await closed;
    clearTimeout(force);
}
const interrupt = () => {
    interrupted = true;
    void stopChild(browserProcess);
    void stopChild(server);
};
const deadline = setTimeout(interrupt, 1200000);
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
    chain = await startChainMarketBrowserChain({ walletAddress: sender, recipientAddress: recipient });
    if (interrupted)
        throw Error('Interrupted');
    reservation = createServer();
    await new Promise((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = reservation.address().port;
    const base = `http://127.0.0.1:${port}`;
    const env = {
        ...process.env, ...chain.env,
        QA_KEY_DER_BASE64: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        QA_ISOLATED_CHAIN: 'owned-validator', QA_EXPECTED_RPC: chain.runtime.rpcUrl,
        QA_EXPECTED_GENESIS: chain.runtime.genesisHash, QA_EXPECTED_PROGRAM: chain.runtime.programAddress,
        QA_RECIPIENT: recipient, QA_ALLOWANCE: String(chain.allowanceBaseUnits), QA_MARKET_ID: String(chain.marketId),
        DATABASE_PROVIDER: 'sqlite', DATABASE_URL: `file:${db}`,
        POSTGRES_DATABASE_URL: '', POSTGRES_DIRECT_DATABASE_URL: '', NEON_DATABASE_URL: '',
        APP_URL: base, NEXT_PUBLIC_APP_URL: base, BASE_URL: base,
        REQUIRE_EMAIL_VERIFICATION: 'true', GOOSEY_DEVELOPMENT_SANDBOX: '1',
        AUTH_SECRET: randomBytes(32).toString('hex'),
        RATE_LIMIT_KEY_SECRET: randomBytes(32).toString('hex'),
        GOOSEY_TOKEN_SECRET: randomBytes(32).toString('hex'),
        GOOSEY_SOLANA_BROWSER_ENABLED: 'true',
        GOOSEY_SOLANA_PUBLIC_RPC_URL: chain.runtime.rpcUrl,
        // Exercise the real public indexer/trade surfaces against this run's
        // isolated database. An empty journal is an explicit unavailable
        // coverage state, never synthetic market activity.
        GOOSEY_SOLANA_CATALOG_ENABLED: 'true',
        WATCHPACK_POLLING: 'true',
        QA_EMAIL: 'wallet-browser@qa.invalid',
        QA_PASSWORD: randomBytes(24).toString('base64url') + 'Aa1!',
    };
    writeFileSync(db, '');
    const schema = spawnSync('node', ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env, stdio: 'inherit' });
    if (schema.status !== 0)
        throw Error('Schema initialization failed');
    const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    try {
        await prisma.user.create({ data: {
                email: env.QA_EMAIL, username: 'wallet_browser_qa', displayName: 'Wallet browser QA',
                passwordHash: await bcrypt.hash(env.QA_PASSWORD, 12), emailVerifiedAt: new Date(),
            } });
    }
    finally {
        await prisma.$disconnect();
    }
    await new Promise(resolve => reservation.close(resolve));
    reservation = undefined;
    if (interrupted)
        throw Error('Interrupted');
    server = spawn('node', ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { env, stdio: 'inherit' });
    let ready = false;
    for (let i = 0; i < 90; i++) {
        if (interrupted || stopped(server))
            throw Error('Owned QA server stopped before readiness');
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
            const response = await fetch(base + '/api/solana/status', { signal: AbortSignal.timeout(2000) });
            const status = await response.json();
            if (response.ok && status.status === 'foundation_verified' && status.genesisHash === chain.runtime.genesisHash
                && status.programAddress === chain.runtime.programAddress && status.browserRuntime?.publicRpcUrl === chain.runtime.rpcUrl) {
                ready = true;
                break;
            }
        }
        catch { /* Bounded startup polling only. */ }
    }
    if (!ready || stopped(server))
        throw Error('Owned QA runtime did not match fresh validator');
    browserProcess = spawn('node', ['--import', 'tsx', 'scripts/chain-market-browser-e2e-verify.mjs'], { env, stdio: 'inherit' });
    const code = await new Promise(resolve => browserProcess.once('close', resolve));
    if (code !== 0)
        throw Error('Browser journey failed');
    const audit = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    try {
        const user = await audit.user.findUniqueOrThrow({ where: { email: env.QA_EMAIL } });
        const ledgerPostingCount = await audit.ledgerPosting.count();
        if (user.balanceMilli !== 0n || ledgerPostingCount !== 0)
            throw Error('On-chain journey changed database economics');
        writeFileSync(`${root}/output/playwright/chain-market/database-audit.json`, JSON.stringify({
            database: 'isolated ephemeral sqlite', balanceMilli: user.balanceMilli.toString(), ledgerPostingCount,
            unchanged: true,
        }, null, 2));
    }
    finally {
        await audit.$disconnect();
    }
}
finally {
    await stopChild(browserProcess);
    await stopChild(server);
    if (reservation)
        await new Promise(resolve => reservation.close(resolve));
    if (chain)
        await chain.stop();
    for (const suffix of ['', '-wal', '-shm'])
        rmSync(db + suffix, { force: true });
    clearTimeout(deadline);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
}
