# BioCraft – Firebase backend + Tally automation (START HERE)

What you have now:

```
Tally (client server)
   └─ tally-agent  (Windows scheduled task, 8:00 AM and 3:00 PM IST)
        └─ Supabase  (source of truth for invoices + call history)
             └─ Firebase Cloud Functions  (/api/**, Bolna webhook, follow-up scheduler)
                  └─ Dashboard on Firebase Hosting (public/index.html, polls every 30 s)
```

Read in this order:

| # | File | What it is for |
|---|------|----------------|
| 1 | `docs/DEPLOY_FIREBASE_BACKEND.md` | Step-by-step deployment (Supabase → Firebase). **Do this first.** |
| 2 | `docs/CLIENT_SERVER_INSTALL.md` | Install the Tally sync on the client's Windows Server |
| 3 | `docs/TESTING.md` | What was tested, what was NOT, and how you test the rest |
| 4 | `docs/ROLLBACK.md` | How to go back safely |
| 5 | `docs/CHANGE_REPORT.md` | Every file added/changed and why, preserved features, findings |

Your original files are all still here, untouched, except 4 small edits
(`index.html`, `public/index.html`, `firebase.json`, `.gitignore`) – see the change report.
Never upload any real `.env`, `invoices.db` or key to a ZIP/chat.
