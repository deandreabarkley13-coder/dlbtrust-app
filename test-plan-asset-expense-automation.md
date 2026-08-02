# Test Plan — Asset / Expense & One-Click Automation

**App:** `https://dlbtrust-app.fly.dev/dapp`  
**Operator token:** `dlb-admin-2026-trust`  
**Branch/PR:** `devin/circle-mint-onramp` / PR #234  
**Safe used for execution attempts:** `SAFE-1785504557741-WW39EK` (threshold 1, Sepolia, status `deployed` with shadow deploy hash, known not on-chain / gas-blocked)  
**Destination address:** `0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16`  
**Test beneficiary email:** `test-ben-asset@example.com`

## Goal

End-to-end verify the new `Assets / Expenses` and `Automation` tabs and their backend integration on the deployed dApp.

## Observed constraints (used to design adversarial checks)

- The `Asset-Debt Proof` tab has no "Include hard assets" checkbox. Its `Compute Proof` handler (`public/dapp/index.html:2087`) calls `/api/dapp/asset-debt-proofs/compute` **without** `includeHardAssets`. The Automation tab is the only UI that currently passes `includeHardAssets`.
- Existing source-of-funds totals are ~$519M. The pre-existing hard asset (`2024 Tahoe`, $45,000) and liability (`Auto Loan`, $20,000) are detectable via `includeHardAssets:true`.
- Live Sepolia execution is expected to fail because the operator wallet has minimal gas and the existing Safe is not actually deployed on-chain.

## TC1 — Add a hard asset and verify it appears in the table and totals

1. Go to the **Assets / Expenses** tab.
2. In **Add Asset**:
   - Category: `Vehicle`
   - Name: `Test Delivery Van`
   - Identifier (VIN): `VIN-TEST-12345-ASSET`
   - Current Value USD: `15000`
   - Owner: `Test Beneficiary`
   - Linked Source Type: `cash`
   - Linked Source Account ID: `CA-OPERATING`
   - Description: `End-to-end test asset`
3. Click **Add Asset**.

**Pass criteria:**
- The status message reads `Asset added: AST-...` with a new `AST-...` ID.
- The **Assets** table gains a row with `Vehicle`, `Test Delivery Van`, `VIN-TEST-12345-ASSET`, `$15000.00`, `active`.
- The **Totals** line updates: `Assets` increases by `$15,000.00` compared to the value shown before the add.
- `GET /api/dapp/assets` returns the new asset with `amount_cents: 1500000`.

**Fail criteria:**
- No new ID is returned, a 4xx/5xx response appears, the table does not update, or the totals line does not increase.

## TC2 — Add a liability and verify totals update

1. In **Add Liability**:
   - Category: `Loan`
   - Name: `Test Liability Loan`
   - Identifier: `LOAN-TEST-67890`
   - Amount Owed USD: `7500`
   - Owner / Payee: `Test Lender`
   - Description: `End-to-end test liability`
2. Click **Add Liability**.

**Pass criteria:**
- Status message reads `Liability added: LIA-...`.
- **Liabilities** table gains a row with `loan`, `Test Liability Loan`, `LOAN-TEST-67890`, `$7500.00`, `active`.
- **Totals** line: `Liabilities` increases by `$7,500.00` and `Net Worth` decreases by `$7,500.00`.
- `GET /api/dapp/liabilities` returns the new liability with `amount_cents: 750000`.

**Fail criteria:**
- No new ID, table/totals unchanged, or error message.

## TC3 — Add an expense against the asset, approve it, and pay to create a distribution request

1. In **Add Expense**:
   - Expense Type: `maintenance`
   - Amount USD: `0.01`
   - Payee: `test-ben-asset@example.com` (same as the automation beneficiary email)
   - Payer: `Trust CA-OPERATING`
   - Linked Asset/Liability ID: the `AST-...` ID from TC1
   - Description: `Test maintenance expense for asset`
2. Click **Add Expense**.
3. In the **Expenses** table, click **Approve** on the new expense.
4. Click **Pay** on the approved expense. In the prompts enter:
   - Destination address: `0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16`
   - Safe ID: `SAFE-1785504557741-WW39EK`
   - Source type: `cash`
   - Source account ID: `CA-OPERATING`
5. A toast appears with the created `request_id`.

**Pass criteria:**
- `Add Expense` returns `Expense added: EXP-...`.
- After Approve, the expense row shows `approved`.
- After Pay, the expense row shows `paid` and has a non-null `request_id`.
- `GET /api/dapp/expenses` shows `status: paid` and `request_id: REQ-...`.
- `GET /api/dapp/distribution-requests` includes `REQ-...` with `status: requested` or `under_review`, `type: disbursement`, `beneficiary_email: test-ben-asset@example.com`, `amount_cents: 1`, `safe_id: SAFE-1785504557741-WW39EK`.

**Fail criteria:**
- Expense approval/pay returns an error, the request is not created, or the status does not transition.

## TC4 — Asset-debt proof includes hard assets / liabilities

Because the `Asset-Debt Proof` tab does not expose `includeHardAssets`, verify the backend behavior directly and then confirm through the Automation tab's checkbox.

### TC4a — API proof without hard assets
1. `POST /api/dapp/asset-debt-proofs/compute` with body `{"memo":"no hard","includeHardAssets":false}`.

**Pass criteria:**
- Response `success: true`.
- `total_assets_cents` equals the source-of-funds total only (baseline before adding the new asset/liability).
- `total_liabilities_cents` is `0`.
- No asset entry has `record_type: hard_asset` and no liability entry has `record_type: hard_liability`.

### TC4b — API proof with hard assets
1. `POST /api/dapp/asset-debt-proofs/compute` with body `{"memo":"with hard","includeHardAssets":true}`.

**Pass criteria:**
- Response `total_assets_cents` is at least `15,00,000` cents higher than TC4a (the new asset).
- Response `total_liabilities_cents` is at least `750,000` cents higher than TC4a (the new liability).
- The `assets` array contains an entry with `record_type: hard_asset`, `name: Test Delivery Van`, `identifier: VIN-TEST-12345-ASSET`.
- The `liabilities` array contains an entry with `record_type: hard_liability`, `name: Test Liability Loan`, `identifier: LOAN-TEST-67890`.

### TC4c — Automation tab "Include hard assets" checkbox is wired
1. Go to the **Automation** tab.
2. Verify the checkbox **"Include hard assets/liabilities in proof"** is checked by default.
3. Run a one-click distribution (TC5) with the box checked and inspect the returned proof object.

**Pass criteria:**
- The proof returned by the automation run has `total_liabilities_cents > 0` and contains `hard_liability` entries.
- Unchecking the box and running a second small automation produces a proof with `total_liabilities_cents` equal to the baseline (no hard liabilities).

**Fail criteria:**
- Checking/unchecking the box produces identical proof content, or the proof never includes hard assets.

## TC5 — One-Click Distribution creates a Run + Proof + Request with no signatures

1. In the **Automation** tab, clear the **Trustee Signatures JSON** field and leave **Auto-execute after approval** unchecked.
2. Fill:
   - Template Name: `Test Asset Automation Run`
   - Type: `distribution`
   - Source Type: `cash`
   - Source Account ID: `CA-OPERATING`
   - Safe ID: `SAFE-1785504557741-WW39EK`
   - Amount USD: `0.01`
   - Beneficiary Email: `test-ben-asset@example.com`
   - Beneficiary Name: `Test Automation Beneficiary`
   - Destination Address: `0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16`
   - Memo: `One-click distribution test`
   - Include hard assets/liabilities in proof: **checked**
3. Click **Run One-Click Distribution**.

**Pass criteria:**
- Status message shows `Run RUN-...`, `Status: created` or `proof_ready`, a non-empty `Proof:` ID, and a non-empty `Requests:` ID.
- `Errors:` is `none`.
- **Runs** table refreshes and shows the new run with status `created` and the proof/request IDs.
- `GET /api/dapp/automations/runs/<id>` returns the run with `proof_id` and `request_ids` populated.
- `GET /api/dapp/distribution-requests` includes a new `REQ-...` with `status: under_review` (because the proof is not certified) or `requested`, linked to `test-ben-asset@example.com` and `amount_cents: 1`.

**Fail criteria:**
- The run fails, returns no run/proof/request IDs, or the request is not created.

## TC6 — Approve & Execute the automation run with trustee signatures

1. Copy the **Run ID** from TC5 into the **Approve / Execute Run** section.
2. Fill **Trustee Signatures JSON**:
   ```json
   [
     {"role":"administration","trusteeEmail":"deandreabarkley13@gmail.com","signature":"0xadmin"},
     {"role":"distribution","trusteeEmail":"annrobinson9800@yahoo.com","signature":"0xdist"}
   ]
   ```
3. Click **Approve & Execute Run**.

**Pass criteria:**
- `auto-run-result` shows at least 2 approvals processed.
- The request status in the **Requests** tab moves from `under_review` / `requested` to `approved`.
- `GET /api/dapp/distribution-requests/<id>` shows `status: approved` with both `administration` and `distribution` approvals in the `approvals` array.
- Execution is attempted. Because the Safe has no real on-chain deployment / the operator has no gas, it is expected to fail with a gas/deployment error (e.g. `Safe is not deployed yet` or `insufficient funds`). The request status should become `payout_created` or `failed` and the error is captured in the response / request metadata.
- If execution unexpectedly succeeds, a real Sepolia `tx_hash` is returned and verifiable on `https://eth-sepolia.blockscout.com/tx/<txHash>`.

**Fail criteria (unexpected):**
- The request never reaches `approved` after both signatures.
- The UI returns a 500 with no useful error, or the run/status disappears.

## TC7 — Beneficiary / Trustee portal shows the request and activity

1. Go to the **Requests** tab.
2. In the **Trustee Portal — Approve / Execute** table, locate the `REQ-...` created by the automation run or the expense payment.
3. Verify the row has **Approve / Reject / Execute** buttons and the correct `amount` and `status`.
4. Scroll to **Beneficiary View-Only Portal**.
5. Enter `test-ben-asset@example.com` and click **Load Activity**.

**Pass criteria:**
- Trustee table row(s) for `test-ben-asset@example.com` are visible with `amount: $0.01`.
- Beneficiary activity loads and shows `Requests: >= 1` and at least one request row matching the `REQ-...` ID.
- `GET /api/dapp/beneficiary/activity?email=test-ben-asset@example.com` returns `beneficiaryEmail: test-ben-asset@example.com`, a non-empty `requests` array, and matching payout/transaction rows if any.

**Fail criteria:**
- The request does not appear in the trustee table, beneficiary activity returns empty, or the portal errors.

## TC8 — Calendar and Messaging artifacts (optional but recommended)

1. Open the **Calendar** tab.
2. Verify a new event titled like `Approve distribution request REQ-...` or `distribution run RUN-...` appears near the top.
3. Open the **Messaging** tab.
4. Verify a new thread titled like `distribution request REQ-... requires trustee approval` or `Distribution request REQ-... approved` appears and opens without error.

**Pass criteria:**
- At least one new Calendar event and one new Messaging thread reference the automation run / distribution request.

## TC9 — Local regression checks (optional)

If a local checkout of `devin/circle-mint-onramp` is available:

1. Run `npm run typecheck` — must exit 0.
2. Run `npm test` — must pass all tests (previously 45/45).

**Pass criteria:**
- `typecheck` and `npm test` complete with no new failures.

---

## What success looks like

- All CRUD operations in **Assets / Expenses** work and update totals visibly.
- An approved expense can be paid and produces a distribution request.
- `includeHardAssets:true` materially changes the asset-debt proof by adding hard asset/liability entries; the Automation checkbox controls it.
- One-click automation creates a `Run`, a `Proof`, and a `Request` in a single action.
- Trustee signatures move the request to `approved`.
- Execution is attempted and the gas/Safe error is captured as expected on Sepolia.
- The beneficiary/trustee portals display the request and activity.
