---
name: testing-crm
description: Test CRM & Investors module end-to-end. Use when verifying CRM contact management, dashboard stats, KYC tracking, approval workflow, or bond subscription display.
---

# Testing CRM & Investors

## What to Test

The CRM module manages contacts (investors, trustees, beneficiaries, vendors), KYC/AML tracking, interaction logging, bond subscriptions, and contact approval workflow.

### Key UI Path
- Sidebar > Operations > "CRM & Investors"
- Page shows: summary cards (Total Contacts, Pending Approval, Approved, KYC Verified, Subscriptions, Total Subscribed), Contacts table with approval/KYC status and action buttons, "+ Add Contact" form, Bond Subscriptions table

### Key API Endpoints
- `GET /api/crm/dashboard` -- summary stats (includes `pending_approval`, `approved_count`)
- `GET /api/crm/contacts` -- list contacts (each has `approval_status`, `approved_by`, `approved_at`, `rejected_by`, `rejection_reason`)
- `POST /api/crm/contacts` -- create contact (accepts both snake_case and camelCase field names)
- `POST /api/crm/contacts/:id/approve` -- approve contact (body: `{ approvedBy }`, defaults to 'admin')
- `POST /api/crm/contacts/:id/reject` -- reject contact (body: `{ rejectedBy, reason }`)
- `POST /api/crm/contacts/:id/kyc` -- verify KYC
- `GET /api/crm/subscriptions` -- bond subscriptions with JOIN to contacts and bonds

### Common Pitfalls
- The frontend sends snake_case (`first_name`, `last_name`, `contact_type`) but the backend originally expected camelCase. The route now accepts both, but if new fields are added to the form, they may need similar normalization in `server/routes/crm.js`.
- Dashboard summary field names must match between `CrmEngine.getDashboard()` return object and `dashboard.html` template literals (`kyc_verified`, `total_subscriptions`, `total_subscription_amount`, `pending_approval`, `approved_count`).
- Bond subscription table uses `subscription_amount` (not `amount`), `bond_name` (not `bond_id`), and `settlement_date` (not `created_at`).
- The `createContact` function in `crmEngine.js` destructures camelCase fields -- the route normalizes the 3 required fields but optional fields must be sent in camelCase by API consumers.
- New contacts start with `approval_status: 'pending_approval'` by default (DB column default).

## Test Environment
- Live URL: https://dlbtrust-app.fly.dev/dashboard.html
- No special auth required for CRM endpoints (unlike admin endpoints that need x-admin-token)

## Devin Secrets Needed
- None for CRM testing. The app auto-authenticates on page load.

## Test Procedure

### Basic CRM Tests
1. Navigate to CRM & Investors page
2. Verify summary cards: Total Contacts, Pending Approval, Approved, KYC Verified, Subscriptions, Total Subscribed all show real numbers (not 0 or NaN)
3. Verify Contacts table shows rows with Name, Type badge, Email, Approval status badge, KYC status badge, Action buttons
4. Verify Bond Subscriptions table shows: Contact name (not raw ID), Bond name (not raw number), Amount in dollars (not "--"), Status badge, Date
5. Click "+ Add Contact", fill First Name, Last Name, select Type, click "Save Contact"
6. Verify success: form closes, contacts table refreshes with new entry, Total Contacts increments

### Approval Workflow Tests
7. Find a contact with `pending_approval` status (yellow badge)
8. Click "Approve" button -- confirm dialog should say "Approve contact {contactId}?"
9. Click OK -- alert should say "Contact approved"
10. Verify: badge changes to "APPROVED" (green), Approve button disappears, Reject + Verify KYC remain, Pending Approval count decrements, Approved count increments
11. Find another contact with `pending_approval` status
12. Click "Reject" button -- prompt should ask "Rejection reason (optional):"
13. Enter a reason (e.g. "Duplicate contact"), click OK -- alert should say "Contact rejected"
14. Verify: badge changes to "REJECTED" (red), Reject button disappears, Approve button remains (can re-approve), Pending Approval count decrements
15. Find a contact with KYC status "pending" and click "Verify KYC"
16. Verify: KYC badge changes to "VERIFIED" (green), Verify KYC button disappears

### Approval Badge CSS Classes
- `badge-active` (green) = approved
- `badge-danger` (red) = rejected
- `badge-pending` (yellow/orange) = pending_approval

## Key Files
- `public/dashboard.html` -- CRM UI (lines ~566-584 for HTML, ~2162-2329 for JS including approval functions)
- `server/routes/crm.js` -- API routes (approve at ~line 84, reject at ~line 95)
- `server/integrations/crm/crmEngine.js` -- business logic + SQL queries (approveContact, rejectContact methods)
- `server/server-3002.js` -- DB migration for approval columns (lines ~255-267)
