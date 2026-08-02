# FinOps AI Agent, Calendar, Messaging, Document Vault — dApp End-to-End Test Plan

**Target:** `https://dlbtrust-app.fly.dev/dapp` (`devin/circle-mint-onramp`, PR #234)  
**Auth:** `x-admin-token: dlb-admin-2026-trust`  
**Mode:** live Sepolia (`/api/dapp/dex/readiness` returns `mode: live`; `/api/dapp/stablecoin-dex/readiness` also live)

## What changed

- New backend `server/integrations/agents/finOpsAgent.js` parses natural-language prompts, creates `finops_tasks`, and requires two trustee approvals (`administration`, `distribution`).
- `server/routes/dapp.js` adds `/api/dapp/finops-ai/*`, `/api/dapp/calendar/*`, `/api/dapp/messaging/*`, `/api/dapp/documents/*`.
- `public/dapp/index.html` adds nav tabs **FinOps AI**, **Calendar**, **Messaging**, **Documents** and UI handlers: `submitFinOpsPrompt()`, `approveFinOpsTask()`, `createCalendarEvent()`, `loadMessageThreads()`, `openThread()`, `createDocument()`, `loadDocuments()`.
- FinOps `payment` action executes via `StablecoinDexEngine.depositAndSwap`:
  1. Mints DLBUSD from the chosen source ledger (`cash CA-OPERATING`).
  2. Swaps DLBUSD → USDC on the live `BondDex` pool.
  3. Transfers USDC to the destination `0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16`.
  4. `tx_hash` stored on the `finops_tasks` row is the final USDC transfer hash and must be a real, successful Sepolia transaction.
- `CalendarEngine.scheduleFromTask` creates an event linked to the FinOps task.
- `MessagingEngine.notify` creates threads on task creation, each approval, and execution.
- `DocumentEngine` must list a FinOps payment confirmation and any existing receipts.

## Preconditions

- Operator token `dlb-admin-2026-trust` is saved in the dApp UI.
- `CA-OPERATING` cash account has sufficient USD balance (currently $5,999,963.93). A $0.01 payment is well within balance.
- Operator hot wallet `0x3e53028cf69949f3B961ce786Baf2D4D75166562` has Sepolia ETH for gas (currently ~0.00068 ETH). If a write fails due to gas, request a top-up before continuing.
- Live BondDex pool `0x29163502317276cb89c3774b411c695e2b4b8426` has enough USDC reserve (`~0.0589 USDC`) to swap $0.01 DLBUSD into USDC.

## Step 1: Load dApp and open FinOps AI tab

**UI action:**
1. Open `https://dlbtrust-app.fly.dev/dapp`.
2. If needed, click **Operator Token** card, enter `dlb-admin-2026-trust`, and click **Save Token**.
3. Click the **FinOps AI** tab in the nav.

**Pass criteria:**
- The **FinOps AI** tab content appears: prompt textarea, requester email input, **Submit Prompt** and **Refresh Tasks** buttons, Trustees card, Approve Task card, and tasks table.
- `loadFinOpsTrustees()` populates the Trustees card with `DeAndrea Lavar Barkley` and `Malissa Ann Robinson`.
- No `401`/`403`/5xx errors in the browser console for `/api/dapp/*`.

## Step 2: Submit a payment prompt

**UI action:**
1. In the prompt textarea, enter exactly: `Pay $0.01 USDC to 0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16 from cash CA-OPERATING`.
2. Ensure **Requester email** is `deandreabarkley13@gmail.com`.
3. Click **Submit Prompt**.

**Pass criteria:**
- `finops-prompt-result` shows `Task created: FINOPS-... — status pending_approval`.
- API `POST /api/dapp/finops-ai/prompt` returns `success: true` with a task id starting with `FINOPS-`.
- The tasks table refreshes and the new task row shows `pending_approval` and approvals for `administration` and `distribution` both as `pending`.
- `CalendarEngine.scheduleFromTask` creates an event titled `FinOps task: payment <taskId>` with `event_type='payment'`, `related_module='finops'`, `reference_id=<taskId>`; `GET /api/dapp/calendar/events` includes it.
- `MessagingEngine.notify` creates a thread with subject `FinOps task <taskId> requires approval`; `GET /api/dapp/messaging/threads` includes it.

## Step 3: Approve with the administration trustee

**UI action:**
1. In the **Approve Task** card:
   - Task ID: the `FINOPS-...` id from Step 2.
   - Role: `administration`
   - Email: `deandreabarkley13@gmail.com`
   - Signature: any non-empty string (e.g., `admin-sig-1`)
   - Signer name: `DeAndrea Lavar Barkley`
2. Click **Approve**.

**Pass criteria:**
- `finops-approve-result` shows `Task <id> is pending_approval` (or `approved` if execution is async).
- API `POST /api/dapp/finops-ai/tasks/<id>/approve` returns `success: true` and `data.approvals` shows `administration` status `approved`.
- The tasks table updates the approvals column to `administration:approved, distribution:pending`.
- A new messaging thread is created: `FinOps task <id> — administration approved`.

## Step 4: Approve with the distribution trustee

**UI action:**
1. Keep the same Task ID.
2. Change Role to `distribution`.
3. Email: `annrobinson9800@yahoo.com`
4. Signature: `dist-sig-1`
5. Signer name: `Malissa Ann Robinson`
6. Click **Approve**.

**Pass criteria:**
- After both roles approve, `FinOpsAgent` automatically triggers `executeTask`.
- API returns `success: true`, `data.status` is `executed` (or `executing` and then `executed` on refresh).
- `data.tx_hash` exists and starts with `0x` (not `shadow-` or `null`).
- `data.result.mode` is `live` and `data.result.swap.status` is `executed`.
- `data.result.mintTxHash`, `data.result.swap.txHash`, and `data.tx_hash` are all non-empty `0x...` hashes.
- A new messaging thread is created: `FinOps task <id> — executed`.
- `CalendarEngine.scheduleFromTask` event (or an updated/created confirmation event) still exists with the FinOps reference.

## Step 5: Verify the real Sepolia transaction

**UI/API action:**
1. Copy the final `tx_hash` from the FinOps task.
2. Open `https://eth-sepolia.blockscout.com/tx/<tx_hash>` in the browser.
3. Confirm the transaction:
   - Status: `success`
   - Method: `transfer`
   - To: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (USDC contract on Sepolia)
   - Token transfer: to `0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16` with a small USDC value.

**Pass criteria:**
- Blockscout returns `result: success` and the token transfer shows USDC moved to the destination address.

## Step 6: Calendar tab shows the FinOps payment event and can create a new event

**UI action:**
1. Click the **Calendar** tab.
2. Observe the auto-created FinOps event in the table.
3. Fill the create-event form:
   - Title: `FinOps payment review`
   - Description: `Review automated payment`
   - Start: a future datetime-local (e.g., `2026-08-05T10:00`)
   - End: an hour later
   - Type: `meeting`
   - Reference ID: the `FINOPS-...` id
4. Click **Add Event**.

**Pass criteria:**
- The calendar table lists the auto-created `FinOps task: payment <id>` event with `event_type=payment`, `related_module=finops`, and `reference_id=<id>`.
- After adding, the table also shows the new `FinOps payment review` event with `event_type=meeting` and the same `reference_id`.

## Step 7: Messaging tab shows auto-created threads and can open one

**UI action:**
1. Click the **Messaging** tab.
2. Observe the threads list: should include `requires approval`, `administration approved`, `distribution approved`, and `executed` (or `— executed`) threads for the FinOps task.
3. Click the **Open** button on the `executed` thread (or any thread).
4. View the messages panel.

**Pass criteria:**
- At least four threads related to the `FINOPS-...` task are listed.
- Opening a thread displays its messages, including sender and timestamp.
- No errors appear in `msg-thread-result`.

## Step 8: Documents tab lists the FinOps payment confirmation and existing receipts

**UI action:**
1. Click the **Documents** tab.
2. Observe the documents table.
3. If no row named like `FinOps Payment Confirmation` for this `FINOPS-...` task exists, create one:
   - Document name: `FinOps Payment Confirmation`
   - Type: `payment_confirmation`
   - Category: `financial`
   - Reference ID: the `FINOPS-...` id
   - Content: `Payment of $0.01 USDC to 0x8616... for task <id> tx <tx_hash>`
   - Click **Create Document**.

**Pass criteria:**
- The documents table lists at least one row with `document_type=payment_confirmation` and `reference_type=finops_task` / `reference_id=<taskId>`.
- Existing `receipt` documents (`Stablecoin Receipt ...`) are also visible.
- Creating a new document succeeds and appears in the refreshed table.

## Fallback if gas is insufficient

If any live on-chain step (mint, swap, transfer) fails with an out-of-gas error:
1. Record the exact API error and current operator ETH balance.
2. Request a Sepolia ETH top-up from the lead (or use `COINBASE_CDP_KEY_NAME` + `COINBASE_CDP_PRIVATE_KEY` if available).
3. After top-up, re-approve the existing task (or submit a new prompt) and continue from Step 2.

## What distinguishes working from broken

- Broken FinOps parser returns wrong `action`, `amount`, `asset`, or `sourceAccountId` (e.g., `sourceType` not `cash`, `sourceAccountId` not `CA-OPERATING`).
- Broken approval logic does not require both trustee roles, accepts wrong emails, or executes before both approve.
- Broken execution returns `shadow-` hashes, `mode: shadow`, or `tx_hash` not found on Sepolia explorer.
- Broken Calendar/Messaging integration does not create events/threads tied to the FinOps task.
- Broken Documents tab does not list or create `payment_confirmation` / `receipt` documents.
