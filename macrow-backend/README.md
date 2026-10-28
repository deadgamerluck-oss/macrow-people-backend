# Macrow People HRMS - Backend (Render)

This folder contains the complete Node.js API backend service for Macrow People HRMS, configured for deployment on **Render**.

---

## 1. Local Development
```bash
npm install
npm start
```

---

## 2. Environment Variables (.env)
Copy `.env.example` to `.env` or set these in your Render Dashboard:

| Key | Description | Example |
|---|---|---|
| `NODE_ENV` | Environment mode | `production` |
| `PORT` | Listening port (Render provides this automatically) | `3000` |
| `CLIENT_ORIGIN` | Hostinger frontend domain(s) for CORS | `https://people.macrowdigital.com` |
| `APP_BASE_URL` | Frontend base URL for invite links | `https://people.macrowdigital.com` |
| `HRMS_DATA_DIR` | Directory path for SQLite persistence (Render Persistent Disk mount path, e.g. `/var/data`) | `/var/data` |
| `SUPER_ADMIN_EMAIL` | Bootstrap Super Admin email | `raj.macrow@gmail.com` |
| `SUPER_ADMIN_PASSWORD` | Bootstrap Super Admin password | `YourStrongPassword` |
| `SMTP_HOST` | SMTP server host | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username | `your-email@gmail.com` |
| `SMTP_PASS` | SMTP app password | `your-app-password` |

---

## 3. Deploying to Render
1. Create a new **Web Service** on Render.
2. Select your repository and specify Root Directory as `macrow-backend` (or deploy from a separate `macrow-backend` repo).
3. Set:
   - **Environment**: `Node`
   - **Node Version**: `>=24`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. Add a **Persistent Disk** on Render mounted to `/var/data` and set `HRMS_DATA_DIR=/var/data` so the SQLite database persists across redeploys.
5. In Render Environment settings, define `CLIENT_ORIGIN` matching your Hostinger domain.
