import { redirect } from "next/navigation";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Page } from "@/components/Page";
import { TimeZoneSelect } from "@/components/TimeZoneSelect";
import { getUserSettings } from "@/lib/auth";
import { readSession } from "@/lib/session-cookie";
import { saveSetup } from "../actions";
import { BRIEF_TIMES, formatBriefTime, timeZones } from "../_lib/time";

export const dynamic = "force-dynamic";

export default async function Setup({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const uid = await readSession();
  if (!uid) redirect("/");
  const user = await getUserSettings(uid);
  const { error } = await searchParams;
  // Guess from the browser only until the user has saved a name (i.e. first visit).
  const firstVisit = !user?.name;
  return (
    <Page title="Set up your brief">
      <p className="db-lead">Three things, then connect your meetings.</p>
      <form action={saveSetup} className="db-stack">
        <Field id="name" name="name" label="Your name" hint="So we know which promises are yours." defaultValue={user?.name ?? ""} autoComplete="name" required />
        <Field id="timeZone" label="Time zone">
          <TimeZoneSelect id="timeZone" name="timeZone" zones={timeZones()} value={user?.timeZone ?? "Asia/Kolkata"} guess={firstVisit} />
        </Field>
        <Field id="briefTime" label="Send my brief at">
          <select className="db-input" id="briefTime" name="briefTime" defaultValue={user?.briefTime ?? "18:00"}>
            {BRIEF_TIMES.map((t) => (
              <option key={t} value={t}>
                {formatBriefTime(t)}
              </option>
            ))}
          </select>
        </Field>
        <div className="db-row">
          <Button type="submit" variant="highlight">
            Connect Wispr Flow
          </Button>
        </div>
        {error ? (
          <p className="db-note db-note--error" role="alert">
            {error === "wispr"
              ? "Couldn't connect Wispr Flow. Try again."
              : "Something in the form didn't look right. Check it and try again."}
          </p>
        ) : null}
      </form>
    </Page>
  );
}
