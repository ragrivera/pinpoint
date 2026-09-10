# Demo meeting — Acme Messaging / Northwind Retail (synthetic eval fixture)

Date: 2026-08-25 · Attendees: Dev lead, Account manager, three Northwind stakeholders

## Summary
The team demoed the admin portal (SKU packages, dashboard stats, referral codes), the customer
portal (message blasts with scheduling, wallet top-ups) and the sandbox (test API keys, verified
test recipients).

## Decisions
- Customers will be able to configure their own pricing rates through the admin portal.

## Next steps
- [Dev lead] Redeploy the application on the client's infrastructure right after the demo.
- [The group] Build rate settings in the admin portal so customers can pick their service rates.
- [The group] Finalize the feature specification and applicable use cases.

## Details
- 160 characters = 1 credit; the account manager quoted a 30-peso markup on the admin side.
- Top-up SKUs: 300, 500, 1,000, 1,500, 2,000, 5,000 — all visible on the customer portal.
- Email templates are still work-in-progress.
- API key generation "takes two to three minutes" in the sandbox.
