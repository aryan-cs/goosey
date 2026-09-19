/** Actual market browser journey. Run only through chain-market-browser-e2e.mjs.
 * An ephemeral real Ed25519 Wallet Standard provider signs exact app bytes.
 * RPC responses are never synthesized. The uncertainty test forwards one real
 * cancellation then drops its response and temporarily blocks status reads.
 */
import assert from 'node:assert/strict';
import { readGooseyEscrow } from '../src/lib/solana/escrow-read.ts';
import { resolveSolanaRuntime } from '../src/lib/solana/runtime.ts';
import { chromium, expect } from '@playwright/test';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { address as solanaAddress, getAddressDecoder, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
if (process.env.QA_ISOLATED_CHAIN !== 'owned-validator' || !process.env.QA_PASSWORD || !process.env.BASE_URL)
    throw Error('Owned isolated runner and real login required');
if (!/^(0|[1-9][0-9]*)$/.test(process.env.QA_MARKET_ID ?? ''))
    throw Error('Explicit isolated published market ID required');
const base = new URL(process.env.BASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    throw Error('Only a local QA app is allowed');
const dir = new URL('../output/playwright/chain-market/', import.meta.url);
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
async function publicJson(pathname) {
    const response = await fetch(new URL(pathname, base), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, `${pathname} did not return a verified public response`);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i, `${pathname} was not JSON`);
    assert((response.headers.get('cache-control') ?? '').split(',').some(value => value.trim().toLowerCase() === 'no-store'),
        `${pathname} allowed operational state to be cached`);
    return response.json();
}
// These are real app-service reads from the isolated run's untouched indexer
// tables. Missing ingestion is a verified state and must not be represented as
// an empty complete history or populated with test-only financial rows.
const initialTradeTape = await publicJson(`/api/solana/markets/${process.env.QA_MARKET_ID}/trades?limit=25`);
assert.deepEqual(initialTradeTape, {
    items: [], nextCursor: null,
    ordering: { direction: 'desc', keys: ['slot', 'signature', 'logIndex'], semantics: 'deterministic_journal_display_only' },
    coverage: { status: 'unavailable', coverageStartSignature: null, headSignature: null,
        backfillComplete: false, revision: null, updatedAt: null, fullHistory: false },
});
const initialIndexerStatus = await publicJson('/api/solana/indexer/status');
assert.deepEqual(initialIndexerStatus, {
    worker: { state: 'missing', updatedAt: null, cycleCount: '0', successCount: '0', failureCount: '0', consecutiveFailures: 0 },
    coverage: { status: 'unavailable', revision: null, updatedAt: null, fullHistory: false },
});
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
    await connect.waitFor();
    const connectControlFound = true;
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
            const chainRuntime = resolveSolanaRuntime({
                GOOSEY_SOLANA_CLUSTER: 'localnet', GOOSEY_SOLANA_RPC_URL: runtime.publicRpcUrl,
                GOOSEY_SOLANA_PROGRAM_ID: runtime.programAddress, GOOSEY_SOLANA_GENESIS_HASH: runtime.genesisHash,
            });
            const marketId = BigInt(process.env.QA_MARKET_ID);
            const read = () => readGooseyEscrow(chainRuntime, { marketId, wallet: solanaAddress(address) },
                { includeMarketTerms: true, signal: AbortSignal.timeout(15000) });
            const evidence = [];
            async function check(name, predicate) {
                let state;
                for (let i = 0; i < 180; i++) {
                    state = await read();
                    if (predicate(state)) {
                        evidence.push({ name, state });
                        return state;
                    }
                    await page.waitForTimeout(500);
                }
                throw Error('Finalized chain assertion failed: ' + name);
            }
            async function displayedCash(available, reserved) {
                const formatted = value => `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`.replace(/\.?0+$/, '');
                for (const [label, value] of [['Available feathers', available], ['Reserved feathers', reserved]]) {
                    const metric = page.locator('span').filter({ hasText: new RegExp(`^${label}$`) }).locator('..').locator('strong');
                    await expect(metric).toHaveText(value === 0n ? '0' : formatted(value), { timeout: 30000 });
                }
            }
            async function reconnect() {
                const button = page.getByRole('button', { name: 'Connect Goosey Localnet QA', exact: true });
                await button.waitFor();
                await button.click();
                await page.getByLabel('Wallet account').selectOption(address);
            }
            async function ready(button) {
                await button.waitFor();
                for (let i = 0; i < 180; i++) {
                    if (await button.isEnabled()) return;
                    await page.waitForTimeout(500);
                }
                throw Error('Action never became ready: ' + await button.innerText());
            }
            async function approve(expectedFact) {
                const review = page.getByRole('region', { name: 'Transaction review', exact: true });
                await review.waitFor();
                const text = await review.innerText();
                for (const fact of [expectedFact, address, String(marketId), 'Network fee estimate', 'Account deposit estimate'])
                    assert(text.includes(fact), 'Missing reviewed fact: ' + fact);
                if (expectedFact === 'BUY 2 YES') {
                    for (const fact of ['0.4 feathers / contract', '0.8 feathers', '0.808 feathers', 'Maximum cash reserve', '1%'])
                        assert(text.includes(fact), 'Missing exact order economics: ' + fact);
                    await review.screenshot({ path: new URL('limit-order-review.png', dir).pathname });
                }
                await review.getByRole('button', { name: 'Approve transaction', exact: true }).click();
            }
            await page.goto(new URL(`/chain/markets/${marketId}`, base).href);
            await reconnect();
            await page.getByText('No market seat registered for this wallet.', { exact: true }).waitFor();
            const tradeTape = page.locator('section').filter({ has: page.getByRole('heading', { name: 'On-chain trade tape', exact: true }) });
            await expect(tradeTape).toContainText('unavailable', { timeout: 30000 });
            await expect(tradeTape).toContainText('fullHistory: false');
            await expect(tradeTape).toContainText('No verified finalized trades are present in the available indexed window. This does not prove that no trades occurred.');
            assert.equal(await tradeTape.getByRole('table').count(), 0, 'Unavailable trade coverage rendered fabricated rows');
            const absent = await read();
            assert.equal(absent.seat, null);
            assert.equal(absent.marketTerms.sealed, true);
            assert.equal(absent.marketTerms.acceptanceBits, 3);
            await page.screenshot({ path: new URL('market-no-seat.png', dir).pathname, fullPage: true });
            assert.equal(await page.getByRole('button', { name: 'Review buy', exact: true }).count(), 0);
            const register = page.getByRole('button', { name: 'Review registration', exact: true });
            await ready(register); await register.click(); await approve('Permanent market seat');
            await check('registered', state => state.seat !== null && state.seat.availableCash === 0n);
            const collateral = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Market collateral', exact: true }) });
            await collateral.waitFor();
            const deposit = collateral.getByRole('button', { name: 'Deposit', exact: true });
            await ready(deposit); await collateral.getByLabel('Feathers', { exact: true }).fill('20');
            await deposit.click(); await approve('20 feathers');
            await check('deposited', state => state.seat.availableCash === 20000n && state.walletTokenAmount === allowance - 20000n && state.vaultAmount === 20000n);
            await displayedCash(20000n, 0n);
            const buy = page.getByRole('button', { name: 'Review buy', exact: true });
            await ready(buy);
            await page.getByLabel('Limit price (feathers)', { exact: true }).fill('0.4');
            await page.getByLabel('Contracts', { exact: true }).fill('2');
            await buy.click(); await approve('BUY 2 YES');
            const resting = await check('resting order', state => state.orderBook.orders.length === 1 && state.seat.reservedCash > 0n);
            assert.equal(resting.orderBook.orders[0].wallet, address);
            assert.equal(resting.orderBook.orders[0].limitPrice, 400n);
            assert.equal(resting.orderBook.orders[0].remaining, 2n);
            assert.equal(resting.seat.availableCash + resting.seat.reservedCash, 20000n);
            await displayedCash(resting.seat.availableCash, resting.seat.reservedCash);
            const openOrders = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Your open orders', exact: true }) });
            const cancel = openOrders.getByRole('button', { name: 'Cancel', exact: true });
            await ready(cancel);
            for (const [name, width, theme] of [['desktop-light', 1280, 'light'], ['mobile-light', 390, 'light'], ['mobile-dark', 390, 'dark']]) {
                await page.setViewportSize({ width, height: 844 });
                await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark'); document.activeElement?.blur(); window.scrollTo(0, 0); }, theme);
                await page.waitForTimeout(300);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Horizontal overflow: ' + name);
                await page.screenshot({ path: new URL('market-' + name + '.png', dir).pathname, fullPage: true });
            }
            await page.setViewportSize({ width: 1280, height: 800 });
            await cancel.click();
            let delivered = false;
            await page.route(runtime.publicRpcUrl, async route => {
                const data = route.request().postDataJSON();
                if (data?.method === 'sendTransaction') {
                    const actual = await (await route.fetch()).json();
                    assert(!actual.error, 'Actual cancellation rejected');
                    delivered = true;
                    await route.abort('failed');
                } else if (delivered && ['getSignatureStatuses', 'getBlockHeight'].includes(data?.method)) await route.abort('failed');
                else await route.continue();
            });
            await approve('cancel');
            for (let i = 0; i < 150 && !delivered; i++) await page.waitForTimeout(100);
            assert(delivered, 'Actual cancel must reach validator');
            assert.equal(events.filter(event => event.kind === 'transaction').length, 5);
            assert.equal(totalSendRequests, 5);
            assert.equal(await deposit.isEnabled(), false, 'Unknown cancellation must block new writes');
            const savedBefore = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('goosey:transfer:v1:')).map(([, value]) => JSON.parse(value).signature).sort());
            assert.equal(savedBefore.length, 5);
            await page.screenshot({ path: new URL('cancel-uncertain.png', dir).pathname, fullPage: true });
            await page.unroute(runtime.publicRpcUrl);
            await page.reload(); await reconnect();
            await check('cancel finalized after response loss', state => state.orderBook.orders.length === 0 && state.seat.reservedCash === 0n && state.seat.availableCash === 20000n);
            const withdraw = collateral.getByRole('button', { name: 'Withdraw', exact: true });
            await ready(withdraw);
            await displayedCash(20000n, 0n);
            const savedAfter = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('goosey:transfer:v1:')).map(([, value]) => JSON.parse(value).signature).sort());
            assert.deepEqual(savedAfter, savedBefore);
            assert.equal(totalSendRequests, 5, 'Recovery must not resubmit');
            assert.equal(events.filter(event => event.kind === 'transaction').length, 5, 'Recovery must not resign');
            await collateral.getByLabel('Feathers', { exact: true }).fill('20');
            await withdraw.click(); await approve('20 feathers');
            await check('withdrawn', state => state.seat.availableCash === 0n && state.seat.reservedCash === 0n && state.vaultAmount === 0n && state.walletTokenAmount === allowance);
            await ready(withdraw);
            await displayedCash(0n, 0n);
            await expect(collateral).toContainText('Wallet feathers: 100');
            assert.equal(events.filter(event => event.kind === 'transaction').length, 6);
            assert.equal(totalSendRequests, 6);
            assert.equal(errors.length, 0, errors.join('\n'));
            const receipts = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('goosey:transfer:v1:')).map(([, value]) => JSON.parse(value)));
            assert.equal(receipts.length, 6);
            for (const receipt of receipts) {
                const actual = await rpc('getSignatureStatuses', [[receipt.signature], { searchTransactionHistory: true }]);
                assert.equal(actual.value[0]?.confirmationStatus, 'finalized');
                assert.equal(actual.value[0]?.err, null);
            }
            const proof = { marketId, address, runtime, events, totalSendRequests, receipts, evidence,
                transactionsFinalized: 6, cancellationRecoveredWithoutResubmit: true, errors };
            // Retain the completed economic journey before optional negative checks. A
            // later UI assertion must never hide six already-finalized transactions.
            await writeFile(new URL('six-transaction-checkpoint.json', dir), JSON.stringify(proof,
                (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));

            // The newly exposed governance route must derive its role and
            // lifecycle from the same finalized chain. This wallet is not a
            // designated reviewer, so only the permissionless keeper surface
            // may appear. Before closesAt, preparation must fail before the
            // wallet signs or the validator sees a transaction.
            const signaturesBeforeKeeper = events.length;
            const sendsBeforeKeeper = totalSendRequests;
            await page.goto(new URL(`/chain/markets/${marketId}/review`, base).href);
            await reconnect();
            const governance = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Reviewer and keeper', exact: true }) });
            await expect(governance).toContainText('Keeper', { timeout: 45000 });
            await expect(governance).toContainText('Sealed');
            await expect(governance).toContainText('Open');
            const keeperPanel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Permissionless keeper', exact: true }) });
            const closeMarket = keeperPanel.getByRole('button', { name: 'Review market close', exact: true });
            await ready(closeMarket);
            await closeMarket.click();
            await expect(governance.getByRole('alert')).toHaveText('Resolution cannot close before the finalized on-chain close time', { timeout: 45000 });
            assert.equal(await page.getByRole('button', { name: 'Recheck and approve in wallet', exact: true }).count(), 0,
                'Premature keeper close reached a wallet approval review');
            assert.equal(events.length, signaturesBeforeKeeper, 'Premature keeper close reached wallet signing');
            assert.equal(totalSendRequests, sendsBeforeKeeper, 'Premature keeper close reached the validator');
            await page.screenshot({ path: new URL('reviewer-keeper-open.png', dir).pathname, fullPage: true });

            // The chain directory renders the same real status endpoint. With
            // no worker/cursor in this isolated database it must disclose both
            // missing operations and unavailable bounded coverage.
            await page.goto(new URL('/chain', base).href);
            const indexerHealth = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Solana indexer health', exact: true }) });
            await expect(indexerHealth).toContainText('Indexer not observed', { timeout: 30000 });
            await expect(indexerHealth).toContainText('Coverage unavailable');
            await expect(indexerHealth).toContainText('fullHistory: false');
            await expect(indexerHealth).toContainText('Cycles0');
            await expect(indexerHealth).toContainText('Succeeded0');
            await expect(indexerHealth).toContainText('Failed0');
            await page.screenshot({ path: new URL('indexer-status-unavailable.png', dir).pathname, fullPage: true });

            await page.goto(new URL(`/chain/markets/${marketId}`, base).href);
            await reconnect();
            await collateral.waitFor();

            // Deliberately corrupt only retained-manifest transport bytes, never financial state.
            const signaturesBeforeTamper = events.length;
            let tamperedTermsResponses = 0;
            let markTamperedTermsResponse;
            const tamperedTermsResponse = new Promise(resolve => { markTamperedTermsResponse = resolve; });
            await page.route('**/api/solana/markets/**', async route => {
                const url = new URL(route.request().url());
                if (url.pathname !== `/api/solana/markets/${marketId}` || url.searchParams.get('format') !== 'terms') return route.continue();
                const response = await route.fetch();
                const body = Buffer.from(await response.body());
                const question = Buffer.from('Will this isolated Goosey browser run finalize its full market journey?');
                const offset = body.indexOf(question);
                assert(offset >= 0 && body.indexOf(question, offset + 1) < 0, 'Expected one canonical question in terms response');
                body[offset] = 'V'.charCodeAt(0);
                await route.fulfill({ response, body });
                tamperedTermsResponses++;
                markTamperedTermsResponse();
            });
            await collateral.getByLabel('Feathers', { exact: true }).fill('1');
            await deposit.click();
            await Promise.race([tamperedTermsResponse, page.waitForTimeout(30000).then(() => { throw Error('Tampered terms response was not requested'); })]);
            assert.equal(tamperedTermsResponses, 1, 'Exactly one action terms response must be corrupted');
            const marketAlert = page.locator('#main-content').getByRole('alert');
            await expect(marketAlert).toHaveText('Market terms digest mismatch', { timeout: 45000 });
            await expect(marketAlert).toBeVisible();
            assert.equal(await page.getByRole('button', { name: 'Approve transaction', exact: true }).count(), 0);
            assert.equal(events.length, signaturesBeforeTamper, 'Tampered terms reached wallet signing');
            await page.screenshot({ path: new URL('tampered-terms-blocked.png', dir).pathname, fullPage: true });
            await page.unroute('**/api/solana/markets/**');
            await page.getByRole('button', { name: 'Try again', exact: true }).click();
            await ready(deposit);
            await page.goto(new URL('/chain/markets/2', base).href);
            await reconnect();
            const unavailableAlert = page.locator('#main-content').getByRole('alert');
            await expect(unavailableAlert).toHaveText('A verified chain-market snapshot is unavailable', { timeout: 45000 });
            await expect(unavailableAlert).toBeVisible();
            for (const name of ['Approve transaction', 'Review registration', 'Review buy'])
                assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, 'Absent market enabled ' + name);
            await page.screenshot({ path: new URL('market-absent.png', dir).pathname, fullPage: true });
            assert.equal(events.filter(event => event.kind === 'transaction').length, 6);
            assert.equal(totalSendRequests, 6);
            const report = { ...proof, absentMarketBlocked: true, tamperedTermsBlocked: true,
                prematureKeeperCloseBlocked: true, unavailableTradeCoverageVerified: true,
                missingIndexerStateVerified: true };
            await writeFile(new URL('chain-proof.json', dir), JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
            console.log(JSON.stringify({ marketId: String(marketId), transactions: 6, assertions: evidence.map(item => item.name),
                tamperedTermsBlocked: true, cancellationRecoveredWithoutResubmit: true,
                prematureKeeperCloseBlocked: true, unavailableTradeCoverageVerified: true,
                missingIndexerStateVerified: true }));
        }
    }
} catch (error) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
        await page.screenshot({ path: new URL('failure.png', dir).pathname, fullPage: true }).catch(() => {});
        await writeFile(new URL('failure-text.txt', dir), await page.locator('body').innerText()).catch(() => {});
    }
    throw error;
} finally {
    process.removeListener('SIGINT', stopBrowser);
    process.removeListener('SIGTERM', stopBrowser);
    await browser.close();
}
