import { redirect } from "next/navigation";

// Graph is retired: People (who you keep meeting with something open) and the threads on Projects
// answer what it was for. Old links land on People.
export default function Graph(): never {
  redirect("/people");
}
