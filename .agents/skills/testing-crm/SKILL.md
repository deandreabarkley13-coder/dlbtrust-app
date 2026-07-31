---
name: testing-crm
description: Test the CRM Contacts & CRM feature end-to-end on dlbtrust-app. Use when verifying contact management, payment methods, filtering, or deactivation.
---

# Testing the CRM Feature

## App URL

Production: https://dlbtrust-app.fly.dev

The app uses Basic Auth. No login page — credentials are sent via HTTP header automatically by the browser after first prompt.

## What to Test

The CRM lives under the **Contacts** nav item. Key flows:

1. **Contacts view** — metrics cards (Total, Trustees, Beneficiaries, Vendors, Pending KYC, Payment Methods) + contacts table
2. **Create contact** — "+ New Contact" button opens modal. Type dropdown (trustee/beneficiary/vendor) toggles type-specific fields via CSS `hidden` class
3. **Contact detail panel** — Click a row's "View" button. Shows 5 sections: basic info, Payment Methods, Account Relationships, Documents, Recent Notes
4. **Payment methods** — "+ Add Payment Method" in detail panel. Supports ACH, wire, check, Zelle. Account numbers are masked (e.g. `****3210`)
5. **Type filtering** — dropdown at top right filters table by contact type. Metrics stay global (don't change with filter)
6. **Deactivation** — "Deactivate" button on each row. Triggers browser `confirm()`. Sets status to inactive, removes Deactivate button, updates metrics

## Known Issues

- **Routing number regex pattern**: The routing number input in the Add Payment Method form might have a double-escaped regex pattern (`\\d{9}` instead of `\d{9}`). This blocks HTML5 form validation for valid 9-digit routing numbers. Workaround: remove the pattern attribute via browser console (`document.querySelector('input[name="routing_number"]').removeAttribute('pattern')`) before submitting. The backend validates correctly regardless.

## Test Data

Production has seed contacts:
- DeAndrea Barkley (trustee)
- James Barkley (beneficiary)
- Johnson & Associates Law (vendor)

When creating test contacts, use vendor type with a company name (e.g. "QA Testing LLC") — company_name takes precedence as display_name in the table.

## API Endpoints

- `GET /api/crm/contacts` — list contacts (optional `?type=vendor` filter)
- `GET /api/crm/contacts/:id` — detail with sub-resources
- `POST /api/crm/contacts` — create contact
- `POST /api/crm/contacts/:id/payment-methods` — add payment method
- `PATCH /api/crm/contacts/:id` — update (used for deactivation: `{"status": "inactive"}`)
- `GET /api/crm/dashboard` — metrics summary

## Tips

- The detail panel stays open when the contacts table reloads (e.g. after filter change). It shows stale data — click View again to refresh.
- The filter dropdown uses `onchange="loadContacts()"` — if programmatically changing the value, dispatch a `change` event.
- Deactivation is a soft delete — contact remains in the table with status=inactive.
- Payment Methods count in metrics reflects all payment methods across all active contacts.
- Type-specific fields in the create modal: beneficiary gets distribution_percentage/beneficiary_class, trustee gets trustee_role/appointment_date, vendor gets category/payment_terms.

## Devin Secrets Needed

No additional secrets needed — the app uses Basic Auth with credentials embedded in the deployment.
