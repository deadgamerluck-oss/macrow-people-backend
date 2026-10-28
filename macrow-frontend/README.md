# Macrow People HRMS - Frontend (Hostinger)

This folder contains the standalone React frontend for Macrow People HRMS, configured for deployment on **Hostinger** (or any static/shared hosting provider).

---

## 1. Local Development
```bash
npm install
npm run dev
```

---

## 2. Setting Backend URL
The backend API URL is configured in `.env`:
```env
VITE_API_BASE_URL=https://macrow-people-hrm-1.onrender.com
```
When building, Vite injects this URL automatically. If you deploy on Hostinger under a custom domain (e.g. `https://people.macrowdigital.com`), ensure this points to your Render backend service.

---

## 3. Build for Production (Hostinger)
Run:
```bash
npm run build
```
This generates the ready-to-upload files inside the `dist/` directory:
- `dist/index.html` (Main dashboard SPA)
- `dist/accept-invite.html` (Employee onboarding / invite acceptance)
- `dist/assets/` (Compiled JS and CSS bundles)
- `dist/.htaccess` (Apache rewrite configuration for Hostinger URL routing)

---

## 4. Uploading to Hostinger
1. Log in to your Hostinger **hPanel**.
2. Open **File Manager** for your domain / subdomain (e.g., `public_html` or `public_html/subdomain`).
3. Upload all contents from the **`dist/`** folder directly into `public_html`.
4. Ensure `.htaccess` is uploaded (enable "Show Hidden Files" in Hostinger file manager if needed).
