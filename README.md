# Convertide Backend

Express + TypeScript API for ConvertTide. Uses Supabase Auth + Postgres, with Gemini for persona generation.

Frontend integration is **not** wired in this pass — these endpoints are ready for a later client hookup.

## Quick start

1. Copy `.env.example` → `.env` and fill Supabase + Gemini keys.
2. In Supabase **SQL Editor**, run migrations in order:
   - `sql/001_personas.sql`
   - `sql/002_profiles.sql`
   - `sql/003_user_settings.sql`
   - `sql/004_notifications.sql`
   - `sql/005_campaigns.sql`
   - `sql/006_plans.sql`
   - `sql/007_assets.sql`
   - `sql/008_billing.sql`
   - `sql/009_personas_updated_at.sql`
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

Generating a persona marks onboarding complete and creates an inbox notification.

### Settings — `/api/settings`
| Method | Path | Body |
|---|---|---|
| GET | `/` | — |
| PATCH | `/` | `{ notifications?: {...}, ai?: {...} }` |

Notification keys: `personaGenerated`, `campaignGenerated`, `marketingPlanGenerated`, `aiCreditsLow`, `billingUpdates`, `emailNotification`.

AI keys: `contentTone`, `contentLength`, `preferredLanguage`, `autoSaveAiResults`.

### Notifications — `/api/notifications`
| Method | Path |
|---|---|
| GET | `/?category=all\|campaigns\|ai\|billing` |
| POST | `/mark-all-read` |
| PATCH | `/:id/read` |
| DELETE | `/:id` (soft dismiss) |

Shapes match the notifications inbox page (`category`, `actionLabel`, `actionHref`, `actionTone`, `unread`).

### Campaigns — `/api/campaigns`
| Method | Path |
|---|---|
| GET | `/` |
| POST | `/generate` `{ personaId, name? }` |
| GET | `/:id` |
| PATCH | `/:id` |
| DELETE | `/:id` |

### Plans — `/api/plans`
| Method | Path |
|---|---|
| GET | `/` |
| POST | `/generate` `{ personaId, campaignId?, name?, budget?, durationDays? }` |
| GET | `/:id` |
| PATCH | `/:id` |
| DELETE | `/:id` |

### Assets — `/api/assets`
| Method | Path |
|---|---|
| GET | `/` |
| POST | `/` |
| DELETE | `/:id` |

### Billing — `/api/billing`
| Method | Path |
|---|---|
| GET | `/` | → `{ billing: { plan, credits, paymentMethod, invoices } }` |

Starter billing rows are auto-created for new users. Stripe can replace this later.

## Notes

- Campaign/plan “generate” endpoints currently use structured templates (persona-aware). Swap `src/services/generators.ts` for Gemini later if needed.
- Notification creation respects user settings preferences.
- Do not commit `.env`.
