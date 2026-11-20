import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { setupAxiosInterceptors } from "./lib/axios-interceptor";

// Recover when a deployment removes a lazy-loaded chunk still referenced by a cached page.
window.addEventListener("vite:preloadError", (event) => {
  try {
    const key = "vite-preload-reload-at";
    const now = Date.now();
    const lastReload = Number(sessionStorage.getItem(key) || "0");
    if (!lastReload || now - lastReload > 15_000) {
      event.preventDefault();
      sessionStorage.setItem(key, String(now));
      window.location.reload();
    }
  } catch {
    // Leave Vite's normal error handling in place if session storage is unavailable.
  }
});

// Setup global axios error handling
setupAxiosInterceptors();

createRoot(document.getElementById("root")!).render(<App />);
