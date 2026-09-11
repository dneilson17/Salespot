# SaleSpot Production Starter

This project converts the SaleSpot click-through into a functioning full-stack marketplace application while preserving the approved screenshot as the exact desktop homepage.

## Included

- Persistent user accounts with bcrypt password hashing and HTTP-only JWT session cookie
- Seller profiles and verification fields
- Marketplace, auction, yard-sale and estate-sale listings
- Up to 8 image uploads per listing
- GPS capture in the browser
- Real OpenStreetMap/Leaflet discovery map with radius filtering
- Real-time auction bid broadcasts using Socket.IO and transaction-safe bid writes
- Watchlists
- Buyer/seller messaging with real-time delivery
- Stripe Checkout endpoint and signed webhook handling
- Admin dashboard for users, listings, bids, messages and sales overview
- Security headers, request rate limiting, upload limits, input checks and same-site session cookies
- Seed data that matches the SaleSpot homepage example

## Run locally

1. Install Node.js 22.5 or newer.
2. In this folder run: `npm install`
3. Copy `.env.example` to `.env` and change `JWT_SECRET` and admin credentials.
4. Run: `npm start`
5. Open `http://localhost:3000`

Demo account: `sarah@example.com` / `Demo123!`

Admin access is created only when `ADMIN_EMAIL` and a strong `ADMIN_PASSWORD` are supplied through environment variables. Never commit production credentials to the repository.

## Stripe

Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Configure Stripe to send `checkout.session.completed` to `/api/payments/webhook`. Without keys the site remains functional, but Buy Securely displays a configuration message instead of opening checkout.

## Deployment notes

The bundled SQLite database is excellent for the working MVP and a single application server. For a large multi-instance national launch, move the same data model to managed PostgreSQL, store images in object storage such as S3/R2, put uploads behind a CDN, run Socket.IO through a shared Redis adapter, add email/SMS verification, identity/KYC services, observability, automated backups, content moderation, shipping/tax integrations, and a dedicated payment marketplace setup such as Stripe Connect for seller payouts.

Before accepting real money, have counsel review marketplace terms, auction rules, prohibited-item policy, tax obligations, seller payout flow, chargebacks, privacy terms and state-specific auctioneer requirements.
