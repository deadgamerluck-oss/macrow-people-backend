// Reads from build-time Vite env variable (VITE_API_BASE_URL),
// or runtime window variable window.__MACROW_API_BASE_URL__,
// or falls back to production Render URL when hosted on external platforms like Hostinger.
const envApiUrl =
  (typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_API_BASE_URL) ||
  "";
const runtimeApiUrl =
  (typeof window !== "undefined" && window.__MACROW_API_BASE_URL__) || "";

export const API_BASE_URL = (() => {
  if (envApiUrl) return envApiUrl.replace(/\/+$/, "");
  if (runtimeApiUrl) return runtimeApiUrl.replace(/\/+$/, "");
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "";
    }
    // If frontend is hosted directly on Render along with backend
    if (host.includes("onrender.com")) {
      return "";
    }
  }
  // Default Render backend for separate frontend hosting (e.g. Hostinger, Vercel, Netlify)
  return "https://macrow-people-hrm-1.onrender.com";
})();
