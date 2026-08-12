# Stripe Treasury Partner Due Diligence & Compliance Package

**Prepared for:** Stripe, Inc.  
**Submitted by:** DEANDREA LAVAR BARKLEY FAMILY TRUST Private Trust Company (PTC)  
**Jurisdiction:** State of Ohio, United States  
**Governing authority:** Ohio Revised Code Chapters 1111 and 1112 (family private trust companies)  
**Platform:** DLB Trust Wealth Management Application  
**Contact:** compliance@dlbtrust.fly.dev

---

## 1. Executive Summary

The DEANDREA LAVAR BARKLEY FAMILY TRUST Private Trust Company ("the PTC") is a non-depository family private trust company organized under Ohio law. The PTC acts as custodian and issuer for the Barkley Family Trust and does not accept deposits from the public, engage in commercial banking, or hold third-party funds other than in its fiduciary capacity for the trust and its named beneficiaries.

This document describes the policies, operational controls, compliance program, and security posture of the DLB Trust Wealth Management Application ("the Platform") as it integrates with Stripe Treasury. The Platform uses Stripe Treasury as the custodial settlement account and payment rail for authorized distributions, disbursements, vendor/merchant payouts, and beneficiary support payments. All movement of fiat is originated from the Platform, executed by Stripe's bank partners, and reconciled against the PTC's internal trust-accounting ledger.

The Platform is designed to:

- originate payments only from approved trust ledger balances;
- enforce two-trustee (maker/checker) approval for every distribution;
- screen counterparties for KYC, AML, sanctions, and fraud before payout;
- maintain immutable audit logs of every instruction, approval, and settlement;
- protect sensitive data in transit and at rest; and
- retain records for the periods required by law and Stripe program rules.

No sensitive credentials, account numbers, API keys, or personally identifying government ID numbers are included in this document.

---

## 2. Entity Overview and Business Model

### 2.1 PTC Legal Structure

- **Entity type:** Family Private Trust Company (non-depository, non-FDIC insured)
- **Regulatory framework:** Ohio Revised Code Chapters 1111 and 1112
- **Role:** Custodian, issuer, and administrator of the Barkley Family Trust
- **Activities:** Investment income tracking, principal/coupon accounting, beneficiary support distributions, vendor/merchant payouts, disbursements
- **Customers served:** Two (2) trustees and three (3) beneficiaries of the family trust

### 2.2 Permitted Use of Stripe Treasury

The PTC uses Stripe Treasury solely for:

1. Receiving investment income, corpus contributions, and other trust deposits into a Treasury Financial Account.
2. Originating ACH and US domestic wire payments to beneficiaries, vendors, merchants, and third-party service providers.
3. Reconciling Treasury-settled funds to the PTC's internal ledger.

The PTC does not use Treasury for consumer deposit accounts, retail payments, peer-to-peer transfers, or any activity outside the express purposes of the trust.

### 2.3 User Base

| Role | Count | Function | Onboarding Requirement |
|------|-------|----------|------------------------|
| Maker Trustee | 1 | Initiates distributions and disbursements | CIP, background check, sanctions screening |
| Checker Trustee | 1 | Second approval required for every payout | CIP, background check, sanctions screening |
| Beneficiary | 3 | Receives support distributions and statements | CIP, sanctions screening |
| Vendors/Merchants | Variable | Receive bill/merchant payments | Business verification, sanctions screening |

All users are U.S. persons or U.S.-domiciled entities.

---

## 3. Funds Flows and Settlement

### 3.1 Inbound Flows

1. **Trust deposits.** Cash representing investment income, principal repayments, or corpus additions is deposited into the Stripe Treasury Financial Account by wire or ACH.
2. **Ledger credit.** The Platform records the deposit as a credit to the appropriate trust cash / income account and, if applicable, mints an internal ledger token representing the PTC's liability to the trust.
3. **Reconciliation.** Treasury balance is reconciled daily to the Platform ledger.

### 3.2 Outbound Flows

1. **Request.** A beneficiary or trustee submits a support distribution or vendor disbursement request through the private portal.
2. **Maker/Checker Approval.** Two trustees must approve before execution.
3. **Source-of-Funds Check.** The Platform verifies that the requested amount is available in the appropriate bond/fixed-income/coupon or trust cash account.
4. **Compliance Screening.** The Platform runs KYC/AML/sanctions/fraud screening on the recipient.
5. **Prefunding.** If the Treasury Financial Account does not hold sufficient funds, the Platform prefunds it from the PTC source account before payout.
6. **Payout Instruction.** The Platform creates a Stripe `OutboundPayment` (ACH or US domestic wire).
7. **Settlement.** Stripe's banking partners debit the Treasury Financial Account and credit the recipient's bank.
8. **Ledger Reconciliation.** The Platform posts the debit to the trust ledger and updates the request to `completed`.

### 3.3 Key Controls

- No payout can exceed the available, approved ledger balance.
- No payout can proceed without two trustee approvals.
- No payout can proceed if compliance screening returns `blocked` or `review`.
- All instructions are immutable and logged.
- Every Stripe `OutboundPayment` is correlated to a request ID and ledger journal entry.

---

## 4. Customer Identification Program (CIP)

### 4.1 Policy

The PTC maintains a written Customer Identification Program that satisfies the requirements of 31 U.S.C. 5318(l) and 31 CFR 1030.220. The CIP is applied to all trustees, beneficiaries, authorized signers, and vendors before the first payout or account activity.

### 4.2 Required Information

For natural persons:

- Full legal name
- Date of birth
- Residential street address
- Country of residence
- Taxpayer identification number (last four digits stored; full number verified externally)
- Government-issued ID type, issuing state, and expiry date
- Verification provider and reference/session ID

For entities/vendors:

- Legal business name
- Employer Identification Number (verified externally)
- Address of principal place of business
- Beneficial ownership information (all individuals owning 25% or more)
- Authorized signers and control persons

### 4.3 Verification Methods

- Identity documents are verified through Stripe Identity or another qualified third-party verification provider.
- Document images and full ID numbers are not stored on the Platform. Only masked values and provider reference IDs are retained.
- Beneficial ownership and PEP/sanctions screening are performed via the Compliance Engine at onboarding and refreshed periodically.

### 4.4 Record Keeping

CIP records are stored in a dedicated database table with restricted access, encryption at rest, and immutable audit logging. Records are retained for at least five (5) years after the relationship ends.

---

## 5. Anti-Money Laundering (AML) and Bank Secrecy Act (BSA) Program

### 5.1 AML Officer

The PTC has designated an AML/BSA Compliance Officer responsible for:

- overseeing the AML program;
- reviewing high-risk and `review` screening results;
- filing Suspicious Activity Reports (SARs) as required; and
- liaising with Stripe and law enforcement.

### 5.2 Risk-Based Approach

The Platform assigns a risk score to every counterparty based on:

- geography (high-risk jurisdictions);
- transaction amount and velocity;
- name/sanctions/PEP matching;
- business type and source of funds;
- politically exposed person status; and
- adverse media or fraud indicators.

### 5.3 Ongoing Monitoring

- Counterparties are re-screened before every payout.
- Transaction patterns are reviewed for unusual velocity, structuring, or unusual destinations.
- High-risk counterparties are subject to enhanced due diligence (EDD) and periodic re-verification.

---

## 6. Sanctions and Politically Exposed Persons (PEP) Screening

### 6.1 Screening Scope

The Platform screens all trustees, beneficiaries, vendors, and payout recipients against:

- U.S. Department of the Treasury OFAC Specially Designated Nationals (SDN) List
- UN, EU, and HMT consolidated sanctions lists
- Domestic high-risk jurisdiction designations
- Politically Exposed Persons (PEP) databases (via third-party provider)

### 6.2 Screening Execution

Screening is performed automatically:

- at onboarding (CIP);
- before every payout; and
- on a periodic refresh schedule.

### 6.3 Matches and Escalation

- A `blocked` screening result immediately prevents the payout and triggers an AML review.
- A `review` result holds the payout pending human review by the AML Officer or a designated trustee.
- Fuzzy name matching and alias checks are used; all near-matches are reviewed before release.

---

## 7. Fraud Prevention

### 7.1 Controls

- Multi-factor approval: two trustees must approve every payout.
- Role-based access control (RBAC) with separate portal and operator credentials.
- Rate limiting on authentication, write operations, and payment endpoints.
- Session expiration and token revocation.
- Recipient bank account change verification (new or changed recipient details require re-approval and re-screening).
- IP and device logging for audit and anomaly detection.

### 7.2 Suspicious Activity Indicators

The Platform flags transactions for review when they exhibit:

- rapid round-trip movement of funds;
- payouts to high-risk or newly created accounts;
- changes to stored recipient details;
- unusual amounts relative to historical patterns; or
- repeated failed authentication attempts.

---

## 8. Suspicious Activity Reporting (SAR)

The PTC will file SARs in accordance with 31 U.S.C. 5318(g) and 31 CFR 1030.320 when it knows, suspects, or has reason to suspect that a transaction:

- involves funds derived from illegal activity;
- is designed to evade BSA/AML requirements;
- has no business or apparent lawful purpose; or
- involves use of the Platform to facilitate criminal activity.

SARs are filed within thirty (30) calendar days of detection and retained for five (5) years.

---

## 9. Consumer Protection, Error Resolution, and Funds Availability

### 9.1 Error Resolution

The Platform maintains a written error-resolution process:

1. Users report errors through the trustee portal or by email.
2. The Compliance Officer investigates and reconciles the transaction against Stripe and ledger records.
3. Corrections are made through offsetting journal entries or reversal payments.
4. Written notice of the resolution is provided within the timeframes required by Regulation E, where applicable, or within ten (10) business days for trust-related disputes.

### 9.2 Funds Availability

Inbound deposits to the Treasury Financial Account are reflected in the Platform ledger upon receipt confirmation from Stripe. Outbound payments are posted as pending until Stripe confirms settlement.

### 9.3 Disclosures

Beneficiaries and trustees receive statements showing:

- available trust balances by source (principal, interest, corpus);
- pending and completed distributions;
- payout rails and reference numbers; and
- any fees or prefunding adjustments.

---

## 10. Information Security Policy

### 10.1 Data Classification

| Class | Examples | Handling |
|-------|----------|----------|
| Public | Marketing website, public trust bio | No restrictions |
| Internal | Policies, non-sensitive reports | Authenticated access |
| Confidential | Ledger data, payout records, audit logs | Encryption + RBAC |
| Restricted | API secrets, database credentials, full ID images | Secrets manager, never in code/logs |

### 10.2 Access Control

- Authentication: email/PIN or username/password with bcrypt-hashed credentials and JWT sessions.
- Authorization: role-based (`admin`, `operator`, `viewer`) with least-privilege enforcement.
- Two-trustee approval for all distributions.
- Operator tokens are scoped and rotated.

### 10.3 Encryption

- **In transit:** TLS 1.2+ for all web and API traffic.
- **At rest:** PostgreSQL encryption and platform-level disk encryption on Fly.io.
- **Secrets:** API keys, database passwords, and JWT secrets are stored as Fly secrets; never committed to source control.
- **PII:** Full government ID numbers and SSNs are not retained. Last-four digits and provider reference IDs are stored with restricted access.

### 10.4 Audit Logging

The Platform records:

- every login, logout, failed authentication, and role switch;
- every distribution request, approval, and execution;
- every payout, prefund, deposit, and reconciliation;
- every compliance screening and status change;
- every API error and operational event.

Logs are immutable, time-stamped, and retained for seven (7) years.

### 10.5 Vulnerability Management

- Dependency updates are reviewed and applied regularly.
- `npm audit` and static analysis are run before deployment.
- Rate limiting, input validation, and parameterized queries protect against injection and brute-force attacks.
- Webhooks and callbacks validate signatures where supported.

### 10.6 Incident Response

The PTC maintains an incident-response plan covering:

- detection and containment of security events;
- escalation to the AML Officer and trustees;
- notification to Stripe and affected users where required by law or contract;
- root-cause analysis and remediation; and
- documentation and record retention.

---

## 11. Operational Policies and Controls

### 11.1 Governance

- **Maker Trustee:** initiates requests and compliance records.
- **Checker Trustee:** provides the second approval required for execution.
- **Admin/Operator:** manages system configuration, secrets, and technical operations.
- **Beneficiary:** may request support and view statements.

No single individual can both initiate and execute a payout.

### 11.2 Transaction Limits and Velocity

| Control | Default | Override |
|---------|---------|----------|
| Per-transaction limit | Configured per source account | Two-trustee approval |
| Daily aggregate limit | Configured per source account | Two-trustee approval |
| Beneficiary monthly cap | Based on allocation percentage | Trustee board approval |
| High-risk country block | Block | Manual review only |

### 11.3 Reconciliation

- The Platform reconciles Stripe Treasury balances to internal ledger accounts daily.
- Discrepancies trigger alerts and manual review.
- Month-end statements tie the PTC ledger, Stripe settlement reports, and bank statements.

### 11.4 Customer Support and Disputes

- Support requests are tracked through the portal messaging system.
- Trustees can freeze a member account or halt pending payouts.
- Dispute resolution includes transaction lookup, ledger review, and, if necessary, recall/request for return of funds through Stripe.

---

## 12. Business Continuity and Disaster Recovery

### 12.1 Objectives

- Recovery Time Objective (RTO): 4 hours
- Recovery Point Objective (RPO): 1 hour

### 12.2 Controls

- PostgreSQL backups are automated and encrypted.
- Application is containerized and deployable to Fly.io regions.
- Secrets and configuration are stored outside the application image.
- Critical payout operations can be suspended and resumed safely without double-paying.
- Idempotency keys prevent duplicate Stripe `OutboundPayment` creation on retry.

---

## 13. Third-Party Risk Management

### 13.1 Stripe

Stripe provides Treasury, payment processing, and identity-verification services. The PTC relies on Stripe for:

- holding Treasury Financial Account balances;
- originating ACH and wire payments;
- identity verification (Stripe Identity); and
- sanctions/AML screening augmentation (where enabled).

### 13.2 Other Providers

The Platform integrates with additional rails for non-fiat or specialized flows. Each integration is evaluated for security, regulatory compliance, and data-handling practices before use.

### 13.3 Contracts and Due Diligence

- A written service agreement or terms of use is in place or will be in place with each material provider.
- Providers are reviewed annually and after any security incident.
- No provider is permitted to access PII or ledger data beyond the scope of the service.

---

## 14. Record Retention

The Platform retains records as follows:

| Record Type | Retention Period |
|-------------|------------------|
| CIP/KYC records | 5 years after relationship ends |
| AML/sanctions screening | 5 years |
| Transaction and ledger records | 7 years |
| Audit logs | 7 years |
| SARs and supporting documents | 5 years |
| Error-resolution records | 4 years |

---

## 15. Risk Disclosures

- The PTC is not a depository bank and does not hold FDIC-insured deposits.
- Stripe Treasury balances are held by Stripe's partner bank; the PTC records these as trust cash.
- Investment income and principal are subject to market, credit, and liquidity risks as described in the trust instrument.
- The Platform does not move real fiat unless the Treasury Financial Account contains sufficient settled funds.

---

## 16. System Architecture Summary

### 16.1 Components

- **Frontend:** Private trust portal (`/trust-portal`) for trustees and beneficiaries.
- **Backend:** Node.js/Express API (`server/server-3002.js`).
- **Database:** PostgreSQL for ledger, compliance, audit, and application state.
- **Payment Rail:** Stripe Treasury `OutboundPayment` for ACH and US domestic wire.
- **Compliance:** ComplianceEngine (sanctions/high-risk scoring) + CustomerIdentificationEngine (CIP records).
- **Ledger:** TrustAccountingEngine, CashEngine, and PtcPortalEngine for double-entry bookkeeping.

### 16.2 Security Layers

- Fly.io edge TLS and application-level rate limiting.
- Helmet security headers and CORS restrictions.
- JWT authentication with role-based middleware.
- Parameterized SQL and input validation.
- Secrets injected via environment variables; not in source code or logs.

### 16.3 Data Handling

- PII is minimized and, where possible, replaced by provider reference IDs.
- Full ID images and full SSN/TIN are not stored in the application database.
- Audit logs redact sensitive account numbers and API keys.

---

## 17. Appendices

### Appendix A — Governing Documents

- Ohio Revised Code Chapter 1111 (Private Trust Companies)
- Ohio Revised Code Chapter 1112 (Family Private Trust Companies)
- Barkley Family Trust instrument and any amendments

### Appendix B — Stripe Environment and Key Handling

- Stripe API keys are stored as Fly secrets (`STRIPE_SECRET_KEY`, `STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID`, etc.).
- Test keys are used in the sandbox environment; live keys are used only after activation and KYC.
- Live Treasury Financial Account ID begins with `fa_live_` and is verified with real KYC before use.

### Appendix C — Operational Contacts

- **AML/BSA Compliance Officer:** compliance@dlbtrust.fly.dev
- **Technical Operations:** support@dlbtrust.fly.dev
- **Trustee Inquiries:** Through the private trust portal

---

**End of Document**
