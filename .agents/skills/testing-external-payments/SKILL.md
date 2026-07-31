---
name: testing-external-payments
description: Test the External Payments feature end-to-end via browser. Use when verifying external transfer UI, approval workflows, fee calculations, or payment lifecycle changes.
---

# Testing External Payments

## Setup

1. Kill any existing server: `fuser -k 3001/tcp 2>/dev/null`
2. Delete the database for a fresh start: `rm -f /home/ubuntu/repos/dlbtrust-app/data/dlbtrust.db`
3. Start the server: `cd /home/ubuntu/repos/dlbtrust-app && node app.js`
4. The server seeds one account (DLB Trust Corpus, ~$10.5M), one CRM contact (Smith Legal Group, vendor), and one payment method (ACH at Chase Bank, ****3210)
5. Navigate to `localhost:3001` and click "Payments" in the left nav

## Key Business Rules

- **Approval thresholds** (in cents): auto (<100000 = <$1K), single ($1K-$50K), dual (>$50K)
- **Fee schedule**: ACH=$0, Wire=$25 (2500 cents), Check=$5 (500 cents), Zelle=$0
- **Auto-approved** payments go directly to `approved` status; others start as `draft`
- **State machine**: draft → pending_approval → approved → processing → sent → completed
- **Rejection path**: draft or pending_approval → cancelled (with optional reason via browser prompt)
- **Transfer number format**: EXT-YYYYMMDD-XXXX

## Test Scenarios

### 1. Empty State
- Verify all 6 metrics show zeros on fresh DB
- Verify empty state message and "+ New Payment" button

### 2. Auto-Approve (<$1K)
- Create payment with amount < $1000 (e.g., $500)
- Toast should contain "auto-approved" and transfer number
- Status should be "approved" immediately (not "draft")

### 3. Single Approval ($1K-$50K)
- Create payment with amount between $1000-$50000 (e.g., $5000)
- Toast should contain "single approval required"
- Status should be "draft" (NOT auto-approved)
- Approve and Reject buttons should appear

### 4. Fee Verification
- Wire payments: Fee column shows "$25.00"
- ACH payments: Fee column shows "—" (dash, not $0.00)
- Verify fee is added to metrics Total Fees after completion

### 5. Full Lifecycle
- On approved payment: click Process → verify "processing" status
- On processing payment: click Complete → verify "completed" status
- Verify Total Paid and Completed metrics update

### 6. Rejection
- Click Reject on a draft payment
- Browser `prompt()` dialog appears for rejection reason
- After OK: status → CANCELLED, action buttons → "—"
- Note: The `prompt()` dialog may cause tool timeouts — be patient with browser interactions

### 7. Status Filter
- Use the status dropdown to filter by specific status
- Verify server-side filtering (not just client-side hide/show)

## Pitfalls & Tips

- **Browser prompt dialogs**: The rejection flow uses a native JS `prompt()`. The computer tool may time out when interacting with it. Take a screenshot to check if the dialog appeared, then type and click OK.
- **Form state persistence**: The create payment modal may retain values from the previous submission (e.g., Send Via stays on "Wire" instead of resetting to "ACH"). Always verify the Send Via dropdown before submitting.
- **Account balance updates**: After completing a payment, the From Account dropdown will show the updated balance on the next modal open.
- **Port conflicts**: Always kill port 3001 before starting a fresh server instance.
- **Fresh DB**: Delete the SQLite file before each test run to ensure clean state.

## Devin Secrets Needed

No secrets required — all testing runs against localhost with seeded data.
