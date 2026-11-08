# WhatsApp Poll & Attendance Automation

## Environment Variables (Render)
- `MASTER_SHEET_ID`: `1jRRJDoNyRNPJStRaSwZm5EKUQPmm1Kpv3dFtYsm5L5E`
- `DRIVE_SESSION_FOLDER_ID`: ID of a private Google Drive folder (shared with Service Account as Editor) for persisting WhatsApp login across restarts.
- `OWNER_PHONE`: Your WhatsApp phone number with country code, digits only (e.g., `919876543210`).
- `GEMINI_API_KEY`: From Google AI Studio (`https://aistudio.google.com/apikey`).
- `GOOGLE_SERVICE_ACCOUNT_JSON`: Full JSON content (or base64) of your Google Cloud Service Account key.

## First-Time Setup
1. Share both the **Private Master Sheet** and **CW Gita Community Attendance** sheet (plus the Drive session folder) as **Editor** with your Service Account's `client_email`.
2. Deploy to Render (`npm install` build command, `npm start` start command).
3. Open `https://<your-render-app>.onrender.com/qr` and scan the QR code with WhatsApp.
4. In your private Control Group on WhatsApp, send `#set_control_group`.
5. Run `#find gita` then `#bind <#> gita_attendance` to link the target group.
6. Add `https://<your-render-app>.onrender.com/health` to UptimeRobot (10-minute interval) to keep Render awake 24/7.
