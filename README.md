# AutoAcquire — Software Change Request (SCR) form

A tiny, zero-dependency app: the SCR form (`index.html`) posts to a Vercel
serverless function (`api/submit.js`) that creates a **HubSpot ticket** in the
**Change Requests → Intake** pipeline, associates the submitter **contact**, and posts a
**Slack** notification. No build step.

## What happens on submit
1. Resolve the **Change Requests → Intake** pipeline/stage (by label, or `HS_PIPELINE_ID`/`HS_STAGE_INTAKE_ID`).
2. Find-or-create the submitter **contact** by email.
3. Create the **ticket** with the `scr_*` properties + a composed description, associated to the contact (assoc typeId **16**).
4. Post a **Slack** message linking to the ticket.
5. Return `{ ok, ticketId }`; the form shows a confirmation with the ticket number.

**Day-one safe:** if the Change Requests pipeline or `scr_*` custom properties aren't built
in HubSpot yet, it falls back to creating the ticket with standard fields (`subject` +
description) in the default pipeline — so it works before the build sheet is fully applied,
and gets richer as it is (see `hubspot-change-request-build-sheet.md`).

## Deploy (Vercel)
1. Push this folder to the repo, import it in Vercel (framework preset: **Other**).
2. Set env vars:
   - `HUBSPOT_TOKEN` — private-app token. Scopes: `crm.objects.tickets.write`,
     `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.tickets.read`.
   - `SLACK_WEBHOOK_URL` — incoming webhook for the target channel.
   - _(optional)_ `HS_PORTAL_ID` (default `43668701`), `HS_PIPELINE_ID`, `HS_STAGE_INTAKE_ID`.
3. `vercel --prod`. The form is live at the root; the API is at `/api/submit`.

## Local
```bash
npm run check     # node --check on the function
npm test          # mocked end-to-end (no real HubSpot/Slack calls)
vercel dev        # run locally (needs env vars)
```

## Not in v1
- **Attachments** — the drag-drop UI exists but upload isn't wired (needs the HubSpot Files
  API + association). Submitters use the **Related link** field meanwhile.
- The form already sends a silent **`_hp` honeypot**; add a rate limit before public exposure.
