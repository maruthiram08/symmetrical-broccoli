"use client";

import { useEffect, useRef } from "react";

/** Time zone select that switches to the browser's zone on first load, unless the user already chose one. */
export function TimeZoneSelect({ id, name, zones, value, guess }: { id: string; name: string; zones: string[]; value: string; guess: boolean }) {
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (!guess || !ref.current) return;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && zones.includes(tz)) ref.current.value = tz;
    } catch {
      // keep the server default
    }
  }, [guess, zones]);
  return (
    <select ref={ref} className="db-input" id={id} name={name} defaultValue={value}>
      {zones.map((z) => (
        <option key={z} value={z}>
          {z.replace(/_/g, " ")}
        </option>
      ))}
    </select>
  );
}
