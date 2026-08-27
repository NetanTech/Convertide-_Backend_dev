# Convertide Backend

Express + TypeScript API for ConvertTide. Uses Supabase Auth + Postgres, with Gemini for persona generation.

Frontend is wired to these endpoints via `NEXT_PUBLIC_API_URL`.

## Quick start

1. Copy `.env.example` → `.env` and fill Supabase + Gemini keys.
2. In Supabase **SQL Editor**, run migrations in order under `sql/` then `migrations/` (including `007_dashboard_credits_assets.sql` and `008_assets_storage_bucket.sql`).
3. Install + run:

```bash
npm install
npm run dev
```

Default port: **4210** (matches frontend `NEXT_PUBLIC_API_URL`).

Health check: `GET http://localhost:4210/health`

## API surface

All protected routes need `Authorization: Bearer <access_token>`.

Envelope: `{ success, message?, data }`

### Auth — `/api/auth`
| Method | Path | Notes |
|---|---|---|
| POST | `/register` | `{ email, password }` |
| POST | `/verify-email` | `{ email, token }` |
| POST | `/resend-verification` | `{ email }` |
| POST | `/login` | `{ email, password }` |
| POST | `/refresh` | `{ refresh_token }` |
| POST | `/logout` | auth |
| GET | `/me` | auth → `{ user, onboardingCompleted }` |
| PATCH | `/profile` | `{ firstName, lastName, phone? }` |
| POST | `/change-password` | `{ currentPassword, newPassword }` |
| POST | `/forgot-password` | `{ email }` |
| POST | `/reset-password` | `{ email, token, newPassword }` |

### Personas — `/api/personas`
| Method | Path |
|---|---|
| POST | `/generate` |
| GET | `/` |
| GET | `/:id` |
| PATCH | `/:id` |
| POST | `/:id/regenerate` |
| POST | `/:id/duplicate` |
| DELETE | `/:id` |

Generating/regenerating a persona consumes credits and creates an inbox notification.

### Settings — `/api/settings`
| Method | Path | Body |
|---|---|---|
| GET | `/` | — |
| PATCH | `/` | `{ notifications?: {...}, ai?: {...} }` |

### Notifications — `/api/notifications`
| Method | Path |
|---|---|
| GET | `/?category=all\|campaigns\|ai\|billing` |
| POST | `/mark-all-read` |
| PATCH | `/:id/read` |
| DELETE | `/:id` (soft dismiss) |

### Campaigns — `/api/campaigns`
| Method | Path |
|---|---|
| GET | `/` |
| POST | `/generate` `{ personaId, name?, durationDays? }` |
| GET | `/:id` |
| PATCH | `/:id` |
| POST | `/:id/duplicate` |
| DELETE | `/:id` |

### Plans — `/api/plans`
| Method | Path |
|---|---|
| GET | `/` |
| POST | `/generate` `{ personaId, campaignId?, name?, budget?, durationDays? }` |
| GET | `/:id` |
| PATCH | `/:id` |
| POST | `/:id/duplicate` |
| DELETE | `/:id` |

### Assets — `/api/assets`
| Method | Path |
|---|---|
| GET | `/` |
| POST | `/` |
| POST | `/upload` | multipart `file` (+ optional title/campaignName/personaName/platform) |
| PATCH | `/:id` |
| DELETE | `/:id` |

### Billing — `/api/billing`
| Method | Path |
|---|---|
| GET | `/` | → `{ billing }` |
| GET | `/plans` | subscription overview |
| GET | `/credits-usage?year=` | monthly credit spend |
| POST | `/change-plan` | |
| GET/POST | `/payment-methods` | |
| DELETE/PATCH | `/payment-methods/:id` | |
| PATCH | `/address` | |

### Dashboard — `/api/dashboard`
| Method | Path |
|---|---|
| GET | `/summary?year=` | stats, credits, monthly usage, recent personas/activities |

## Notes

- Persona/campaign/plan generate endpoints deduct credits (250 / 150 / 200).
- Campaign/plan “generate” endpoints currently use structured templates (persona-aware).
- Notification creation respects user settings preferences.
- Do not commit `.env`.
