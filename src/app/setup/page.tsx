import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Page } from "@/components/Page";
import { TimeZoneSelect } from "@/components/TimeZoneSelect";
import { getStore, me } from "@/server/local/app";
import { saveSetup } from "../actions";
import { BRIEF_TIMES, formatBriefTime, timeZones } from "../_lib/time";

export const dynamic = "force-dynamic";

export default async function Setup({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await me();
  const conn = user ? await getStore().getConnection(user.id) : null;
  const connected = conn?.status === "active";
  const { error } = await searchParams;
  // Guess from the browser only until the user has saved a name (i.e. first visit).
  const firstVisit = !user?.name;
  return (
    <Page title="Set up your brief">
      <p className="db-lead">{connected ? "Change your details. Your meetings stay connected." : "A few things, then connect your meetings. Everything stays on this Mac."}</p>
      <form action={saveSetup} className="db-stack">
        <Field id="name" name="name" label="Your name" hint="So we know which promises are yours." defaultValue={user?.name ?? ""} autoComplete="name" required />
        <Field id="aliases" name="aliases" label="Other names people call you" hint="Comma separated, like Maru, MR. Optional." defaultValue={user?.aliases.join(", ") ?? ""} />
        <Field id="timeZone" label="Time zone">
          <TimeZoneSelect id="timeZone" name="timeZone" zones={timeZones()} value={user?.timeZone ?? "Asia/Kolkata"} guess={firstVisit} />
        </Field>
        <Field id="briefTime" label="Brief me at">
          <select className="db-input" id="briefTime" name="briefTime" defaultValue={user?.briefTime ?? "18:00"}>
            {BRIEF_TIMES.map((t) => (
              <option key={t} value={t}>
                {formatBriefTime(t)}
              </option>
            ))}
          </select>
        </Field>
        <div className="db-row">
          {connected ? (
            <>
              <Button type="submit">Save</Button>
              <Button type="submit" variant="ghost" name="reconnect" value="1">
                Reconnect Wispr Flow
              </Button>
            </>
          ) : (
            <Button type="submit" variant="highlight">
              Connect Wispr Flow
            </Button>
          )}
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
