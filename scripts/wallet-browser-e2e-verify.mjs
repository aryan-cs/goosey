/** Actual funded browser journey. Run only through wallet-browser-e2e.mjs.
 * An ephemeral real Ed25519 Wallet Standard provider signs exact app bytes.
 * RPC responses are never synthesized. The uncertainty test forwards one real
 * transfer then drops its response and temporarily blocks status reads.
 */
import { chromium } from '@playwright/test';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { address as solanaAddress, getAddressDecoder, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
if (process.env.QA_ISOLATED_CHAIN !== 'owned-validator' || !process.env.QA_PASSWORD || !process.env.BASE_URL)
    throw Error('Owned isolated runner and real login required');
const base = new URL(process.env.BASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    throw Error('Only a local QA app is allowed');
const dir = new URL('../output/playwright/wallet-funded/', import.meta.url);
await mkdir(dir, { recursive: true });
const status = await fetch(new URL('/api/solana/status', base), { signal: AbortSignal.timeout(15000) }).then(r => r.json());
const runtime = status.browserRuntime;
if (status.status !== 'foundation_verified' || runtime?.enabled !== true || runtime.cluster !== 'localnet')
    throw Error('Verified localnet browser runtime is required; start the configured server first');
if (runtime.publicRpcUrl !== process.env.QA_EXPECTED_RPC || runtime.genesisHash !== process.env.QA_EXPECTED_GENESIS || runtime.programAddress !== process.env.QA_EXPECTED_PROGRAM)
    throw Error('Runtime differs from owned chain');
const rpcURL = new URL(runtime.publicRpcUrl);
if (!['localhost', '127.0.0.1', '[::1]'].includes(rpcURL.hostname))
    throw Error('RPC must be local');
async function rpc(method, params = []) {
    const r = await fetch(rpcURL, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(r => r.json());
    if (r.error)
        throw Error(JSON.stringify(r.error));
    return r.result;
}
if (await rpc('getGenesisHash') !== runtime.genesisHash)
    throw Error('Genesis mismatch');
const privateKey = createPrivateKey({ key: Buffer.from(process.env.QA_KEY_DER_BASE64, 'base64'), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey);
const bytes = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const address = getAddressDecoder().decode(bytes);
const initial = await rpc('getBalance', [address, { commitment: 'finalized' }]);
if (initial.value <= 0)
    throw Error('Isolated wallet was not funded by bootstrap');
const proof = Buffer.from('Goosey localnet browser QA cryptographic self-check');
if (!verify(null, proof, publicKey, sign(null, proof, privateKey)))
    throw Error('Signing self-check failed');
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const stopBrowser = () => { void browser.close().finally(() => process.exit(130)); };
process.once('SIGINT', stopBrowser);
process.once('SIGTERM', stopBrowser);
const events = [];
let totalSendRequests = 0;
const errors = [];
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.on('request', request => { if (request.url() === runtime.publicRpcUrl && request.method() === 'POST' && request.postDataJSON()?.method === 'sendTransaction')
        totalSendRequests++; });
    await context.exposeBinding('__gooseyQaSign', async ({ frame }, kind, values) => {
        if (new URL(frame.url()).origin !== base.origin)
            throw Error('Signing origin mismatch');
        const data = new Uint8Array(values);
        events.push({ kind, bytes: data.length });
        if (kind === 'message')
            return Array.from(sign(null, data, privateKey));
        if (kind !== 'transaction')
            throw Error('Unknown signing operation');
        const tx = getTransactionDecoder().decode(data);
        if (tx.messageBytes[0] !== 128 || Object.keys(tx.signatures).length !== 1 || !(address in tx.signatures))
            throw Error('Only single-signer v0 transactions supported');
        return Array.from(getTransactionEncoder().encode({ ...tx, signatures: { [address]: new Uint8Array(sign(null, tx.messageBytes, privateKey)) } }));
    });
    await context.addInitScript(({ address, bytes }) => {
        const chain = 'solana:localnet';
        const handlers = new Set();
        let connected = false;
        const account = Object.freeze({ address, publicKey: new Uint8Array(bytes), chains: [chain], features: ['solana:signMessage', 'solana:signTransaction'], label: 'Ephemeral isolated QA wallet' });
        const emit = () => handlers.forEach(fn => fn({ accounts: connected ? [account] : [] }));
        const wallet = { version: '1.0.0', name: 'Goosey Localnet QA', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', chains: [chain], get accounts() { return connected ? [account] : []; }, features: {
                'standard:connect': { version: '1.0.0', connect: async () => { connected = true; emit(); return { accounts: [account] }; } },
                'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = false; emit(); } },
                'standard:events': { version: '1.0.0', on: (event, fn) => {
                        if (event === 'change')
                            handlers.add(fn);
                        return () => handlers.delete(fn);
                    } },
                'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => Promise.all(inputs.map(async (input) => {
                        if (!connected || input.account.address !== address)
                            throw Error('Account mismatch');
                        return { signedMessage: new Uint8Array(input.message), signature: new Uint8Array(await window.__gooseyQaSign('message', Array.from(input.message))), signatureType: 'ed25519' };
                    })) },
                'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: [0], signTransaction: async (...inputs) => Promise.all(inputs.map(async (input) => {
                        if (!connected || input.account.address !== address || input.chain !== chain)
                            throw Error('Account or chain mismatch');
                        return { signedTransaction: new Uint8Array(await window.__gooseyQaSign('transaction', Array.from(input.transaction))) };
                    })) }
            } };
        Object.defineProperty(window, '__gooseyQaConnected', { get: () => connected });
        const register = api => api.register(wallet);
        window.addEventListener('wallet-standard:app-ready', event => register(event.detail));
        window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
    }, { address, bytes: Array.from(bytes) });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    if (process.env.QA_EMAIL && process.env.QA_PASSWORD) {
        await page.goto(new URL('/login?next=%2Fwallet', base).href);
        await page.locator('[name=email]').fill(process.env.QA_EMAIL);
        await page.locator('[name=password]').fill(process.env.QA_PASSWORD);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL(url => url.pathname === '/wallet' || url.pathname === '/verify-email');
    }
    else
        await page.goto(new URL('/wallet', base).href);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: new URL('wallet-initial.png', dir).pathname, fullPage: true });
    await writeFile(new URL('initial-text.txt', dir), await page.locator('body').innerText());
    const connect = page.getByRole('button', { name: process.env.QA_CONNECT_LABEL || 'Connect Goosey Localnet QA', exact: true });
    const connectControlFound = await connect.count() > 0;
    if (connectControlFound) {
        await connect.click();
        await page.waitForTimeout(1200);
    }
    else
        throw Error('Wallet connect control unavailable');
    if (connectControlFound) {
        await page.getByLabel('Wallet account').selectOption(address);
        await page.getByText('No feather token account exists yet.', { exact: false }).waitFor();
        if (process.env.QA_PASSWORD) {
            await page.getByLabel('Current Goosey password').fill(process.env.QA_PASSWORD);
            await page.getByRole('button', { name: 'Verify and link wallet', exact: true }).click();
            await page.getByRole('heading', { name: 'Wallet linked', exact: true }).waitFor();
            const tokenBalance = async (owner) => {
                const result = await rpc('getTokenAccountsByOwner', [owner, { mint: status.featherMint }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
                return result.value.reduce((n, item) => n + BigInt(item.account.data.parsed.info.tokenAmount.amount), 0n);
            };
            const recipient = process.env.QA_RECIPIENT;
            if (await tokenBalance(recipient) !== 0n)
                throw Error('Recipient not empty');
            const recipientBefore = await rpc('getTokenAccountsByOwner', [recipient, { mint: status.featherMint }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
            if (recipientBefore.value.length)
                throw Error('Recipient ATA must be absent before transfer');
            await page.getByRole('button', { name: 'Check and review claim', exact: true }).click();
            await page.getByRole('button', { name: 'Approve and claim', exact: true }).click();
            await page.getByText('Transaction finalized. Refreshing the on-chain balance.', { exact: true }).waitFor({ timeout: 90000 });
            const allowance = BigInt(process.env.QA_ALLOWANCE);
            if (await tokenBalance(address) !== allowance)
                throw Error('Claim final balance mismatch');
            const supplyBefore = (await rpc('getTokenSupply', [status.featherMint, { commitment: 'finalized' }])).value.amount;
            await page.getByLabel('Recipient wallet address').fill(recipient);
            await page.getByLabel('Feathers', { exact: true }).fill('1.25');
            await page.getByRole('button', { name: 'Review send', exact: true }).click();
            let sendCount = 0;
            let delivered = false;
            await page.route(runtime.publicRpcUrl, async (route) => {
                const data = route.request().postDataJSON();
                if (data?.method === 'sendTransaction') {
                    sendCount++;
                    const result = await route.fetch();
                    const body = await result.json();
                    if (body.error)
                        throw Error('Actual RPC rejected uncertain-send transaction');
                    delivered = true;
                    await route.abort('failed');
                }
                else if (delivered && ['getSignatureStatuses', 'getBlockHeight'].includes(data?.method))
                    await route.abort('failed');
                else
                    await route.continue();
            });
            const review = page.locator('section').filter({ has: page.getByRole('button', { name: 'Approve and send', exact: true }) });
            const reviewText = await review.innerText();
            for (const value of ['1.25', recipient, 'Network fee estimate', 'Token account deposit estimate'])
                if (!reviewText.includes(value))
                    throw Error('Incomplete exact transfer review: ' + value);
            await review.screenshot({ path: new URL('transfer-review.png', dir).pathname });
            await page.getByRole('button', { name: 'Approve and send', exact: true }).click();
            for (let i = 0; i < 100 && !delivered; i++)
                await page.waitForTimeout(100);
            if (!delivered)
                throw Error('Transaction was not forwarded to actual validator');
            await page.waitForTimeout(500);
            const signedCount = events.filter(e => e.kind === 'transaction').length;
            if (signedCount !== 2 || sendCount !== 1)
                throw Error('Expected exactly claim and transfer signatures, one transfer RPC send');
            const journalBefore = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('goosey:transfer:v1:')));
            if (journalBefore.length !== 2)
                throw Error('Expected claim and transfer receipts');
            const receiptSignatures = journalBefore.map(([, value]) => JSON.parse(value).signature).sort();
            if (new Set(receiptSignatures).size !== 2)
                throw Error('Expected distinct claim and transfer signatures');
            const reviewButton = page.getByRole('button', { name: 'Review send', exact: true });
            if (await reviewButton.isEnabled())
                throw Error('New send enabled while receipt uncertain');
            await page.screenshot({ path: new URL('uncertain.png', dir).pathname, fullPage: true });
            await page.unroute(runtime.publicRpcUrl);
            await page.reload();
            await page.getByRole('button', { name: 'Connect Goosey Localnet QA', exact: true }).click();
            await page.getByLabel('Wallet account').selectOption(address);
            await page.getByRole('heading', { name: 'Wallet linked', exact: true }).waitFor();
            for (let i = 0; i < 180; i++) {
                if (await tokenBalance(recipient) === 1250n)
                    break;
                await page.waitForTimeout(500);
            }
            if (await tokenBalance(recipient) !== 1250n || await tokenBalance(address) !== allowance - 1250n)
                throw Error('Finalized transfer balances differ');
            const [expectedAta] = await findAssociatedTokenPda({ mint: solanaAddress(status.featherMint), owner: solanaAddress(recipient), tokenProgram: TOKEN_PROGRAM_ADDRESS });
            const recipientAccounts = await rpc('getTokenAccountsByOwner', [recipient, { mint: status.featherMint }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
            if (recipientAccounts.value.length !== 1 || recipientAccounts.value[0].pubkey !== expectedAta)
                throw Error('Transfer did not create the canonical recipient ATA');
            if ((await rpc('getTokenSupply', [status.featherMint, { commitment: 'finalized' }])).value.amount !== supplyBefore)
                throw Error('Transfer changed mint supply');
            await page.getByRole('region', { name: 'Saved transaction receipts' }).getByText('Finalized', { exact: true }).nth(1).waitFor({ timeout: 90000 });
            const remaining = allowance - 1250n;
            const expectedDisplay = `${remaining / 1000n}.${String(remaining % 1000n).padStart(3, '0')}`.replace(/\.?0+$/, '');
            await page.locator(`strong[title="${expectedDisplay} feathers"]`).waitFor({ timeout: 15000 });
            const roundedDisplay = await page.locator(`strong[title="${expectedDisplay} feathers"]`).innerText();
            if (roundedDisplay !== ((remaining + 500n) / 1000n).toLocaleString('en-CA'))
                throw Error('Rounded UI balance incorrect');
            const journalAfter = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('goosey:transfer:v1:')));
            if (JSON.stringify(journalAfter.map(([, value]) => JSON.parse(value).signature).sort()) !== JSON.stringify(receiptSignatures))
                throw Error('Receipt set changed after reload');
            if (events.filter(e => e.kind === 'transaction').length !== signedCount || sendCount !== 1 || totalSendRequests !== 2)
                throw Error('Reload caused duplicate signing/submission');
            await writeFile(new URL('chain-proof.json', dir), JSON.stringify({ sender: address, recipient, allowanceBaseUnits: String(allowance), senderFinal: String(await tokenBalance(address)), recipientFinal: String(await tokenBalance(recipient)), mintSupply: supplyBefore, receiptSignatures, transactionSignatures: signedCount, transferSendRequests: sendCount, totalSendRequests, recipientAtaCreated: true, recipientAta: expectedAta, receiptsRecovered: true, exactDisplayedBalance: expectedDisplay, roundedDisplayedBalance: roundedDisplay }, null, 2));
        }
        for (const [name, width, theme] of [['desktop-light', 1280, 'light'], ['mobile-light', 390, 'light'], ['mobile-dark', 390, 'dark']]) {
            await page.setViewportSize({ width, height: 844 });
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark'); document.activeElement?.blur(); window.scrollTo(0, 0); }, theme);
            await page.waitForTimeout(500);
            if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
                throw Error('Horizontal overflow: ' + name);
            await page.screenshot({ path: new URL('wallet-' + name + '.png', dir).pathname, fullPage: true });
        }
    }
    await page.screenshot({ path: new URL('wallet-connected.png', dir).pathname, fullPage: true });
    const text = await page.locator('body').innerText();
    await writeFile(new URL('connected-text.txt', dir), text);
    const final = await rpc('getBalance', [address, { commitment: 'finalized' }]);
    const connected = await page.evaluate(() => window.__gooseyQaConnected === true);
    const report = { connected, url: page.url(), address, genesisHash: runtime.genesisHash, initialLamports: initial.value, finalLamports: final.value, connectControlFound, signaturesRequested: events, errors, text };
    await writeFile(new URL('report.json', dir), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, text: undefined }, null, 2));
    if (errors.length)
        throw Error('Unexpected browser errors');
    if (!connected)
        throw Error('Wallet not connected: authentication/UI prerequisite prevented the connected-wallet verification');
}
catch (error) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
        await page.screenshot({ path: new URL('failure.png', dir).pathname, fullPage: true }).catch(() => { });
        await writeFile(new URL('failure-text.txt', dir), await page.locator('body').innerText()).catch(() => { });
    }
    throw error;
}
finally {
    process.removeListener('SIGINT', stopBrowser);
    process.removeListener('SIGTERM', stopBrowser);
    await browser.close();
}
