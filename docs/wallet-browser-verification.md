# Wallet browser verification

Run the real wallet flow against a fresh local validator and an isolated SQLite database:

```sh
GOOSEY_SOLANA_VALIDATOR_BIN=/absolute/path/to/solana-test-validator npm run test:browser:wallet
```

Requires installed dependencies, Playwright Chromium, and the compiled Goosey program at `chain/target/deploy/goosey_exchange.so` (or `GOOSEY_SOLANA_PROGRAM_ARTIFACT`). The validator must support upgradeable programs at genesis. Close any other development sandbox before running.

The runner creates fresh signing keys, a separate ledger, a verified test account, and its own app server. It enrolls only the test wallet on that new ledger. Existing app users, database balances, and retained validators are not changed.

The browser uses Wallet Standard with real Ed25519 signatures. The journey checks:

- Password login, wallet selection, and signed account linking.
- Review and approval of an authorized claim; finalized mint and wallet balances.
- A transfer to a new recipient, including creation of its token account.
- A real submission whose response is deliberately dropped after forwarding it to the validator.
- Recovery from the saved signed receipt after reload, without another signature or duplicate transfer.
- Exact final balances, conserved supply, desktop/mobile layout, and browser errors.

RPC faults only interrupt delivery; successful responses, balances, signatures, and transactions are never fabricated. Test evidence and screenshots are written under `output/playwright/wallet-funded`. Temporary validator artifacts contain disposable local test keys; never fund those keys on a public network.

This verifies the application against the test Wallet Standard implementation. It does not establish compatibility with every browser wallet extension or enable onchain market trading.
