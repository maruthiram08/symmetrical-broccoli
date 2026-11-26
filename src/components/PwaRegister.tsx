"use client";

import { useEffect, useState } from "react";

/**
 * Registers the service worker (production builds, secure pages only: localhost, or HTTPS on the
 * phone) and shows a quiet "Offline" pill while the device has no connection, since what you see
 * then is the copy saved on this device.
 */
export function PwaRegister() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (!offline) return null;
  return (
    <div className="db-offline-pill" role="status">
      <i aria-hidden="true" />
      Offline · saved copy, read-only
    </div>
  );
}
