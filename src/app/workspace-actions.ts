"use server";

// Workspaces, folder sync, git and templates: the Settings forms.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isTemplateKind } from "@/lib/templates/kinds";
import { getFileStore, me } from "@/server/local/app";
import { syncFolderProblem } from "@/server/local/folder-sync";
import { REMOTE_NAME } from "@/server/local/git-sync";
import { runGitSync, syncNow } from "@/server/local/outputs";
import { resetTemplate, saveTemplate } from "@/server/local/templates";
import {
  addWorkspace, currentWorkspace, getWorkspace, normalizeFolder, removeWorkspace, setActiveWorkspace, updateWorkspace,
} from "@/server/local/workspaces";
import { mirroredFiles } from "@/server/local/folder-sync";
import { localDate } from "@/lib/brief/time";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const back = (path: string): never => { revalidatePath("/", "layout"); redirect(path); };
const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Switch workspace (sidebar, Settings). The choice is remembered. */
export async function switchWorkspaceAction(formData: FormData): Promise<void> {
  const id = str(formData, "workspace");
  if (getWorkspace(id)) setActiveWorkspace(id);
  back(str(formData, "to").startsWith("/workspaces") ? "/workspaces" : "/");
}

/** A new workspace: a folder of its own, with your name and brief time copied over. Switches to it. */
export async function addWorkspaceAction(formData: FormData): Promise<void> {
  let target = "/";
  try {
    const from = await me();
    const ws = addWorkspace(str(formData, "name"), str(formData, "folder"));
    setActiveWorkspace(ws.id);
    // Same you, different meetings: copy the profile, never the Wispr Flow connection.
    if (from) {
      const store = getFileStore();
      if (!(await store.listUsers()).length) store.addUser({ email: from.email, name: from.name, aliases: from.aliases, timeZone: from.timeZone, briefTime: from.briefTime });
    }
  } catch (e) {
    target = `/workspaces?error=${encodeURIComponent(msg(e))}`;
  }
  back(target);
}

export async function renameWorkspaceAction(formData: FormData): Promise<void> {
  let target = "/workspaces";
  try {
    updateWorkspace(str(formData, "id"), { name: str(formData, "name") });
  } catch (e) {
    target = `/workspaces?error=${encodeURIComponent(msg(e))}`;
  }
  back(target);
}

/** Take a workspace off the list. Its folder and files stay. */
export async function removeWorkspaceAction(formData: FormData): Promise<void> {
  let target = "/workspaces?removed=1";
  try {
    removeWorkspace(str(formData, "id"));
  } catch (e) {
    target = `/workspaces?error=${encodeURIComponent(msg(e))}`;
  }
  back(target);
}

/** Folder sync settings for the current workspace; syncs once right away when turned on. */
export async function saveFolderSyncAction(formData: FormData): Promise<void> {
  const ws = currentWorkspace();
  const enabled = formData.get("enabled") === "on";
  const raw = str(formData, "folder");
  if (enabled || raw) {
    const problem = syncFolderProblem(ws, raw);
    if (problem) back(`/setup?sync=${encodeURIComponent(problem)}#sync`);
  }
  const next = updateWorkspace(ws.id, { sync: raw ? { folder: normalizeFolder(raw), enabled } : null });
  const user = await me();
  if (enabled && user) await syncNow(next, getFileStore(), user);
  back("/setup#sync");
}

export async function syncNowAction(): Promise<void> {
  const ws = currentWorkspace();
  const user = await me();
  if (user) {
    await syncNow(ws, getFileStore(), user);
    const today = localDate(new Date(), user.timeZone);
    const files = mirroredFiles(ws.path);
    await runGitSync(ws, files, today);
  }
  back("/setup#sync");
}

export async function saveGitAction(formData: FormData): Promise<void> {
  const ws = currentWorkspace();
  const remote = str(formData, "remote") || "origin";
  if (!REMOTE_NAME.test(remote)) back(`/setup?git=${encodeURIComponent("Use a remote's name, like origin, not a URL.")}#sync`);
  updateWorkspace(ws.id, { git: { commit: formData.get("commit") === "on", push: formData.get("push") === "on", remote } });
  back("/setup#sync");
}

export async function saveLinksAction(formData: FormData): Promise<void> {
  updateWorkspace(currentWorkspace().id, { links: formData.get("links") === "on" });
  back("/setup#sync");
}

/** Save a template from the editor. Returns the problem instead of saving a broken one. */
export async function saveTemplateAction(kind: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isTemplateKind(kind)) return { ok: false, error: "Unknown template." };
  const r = saveTemplate(currentWorkspace(), kind, text);
  if (r.ok) revalidatePath("/setup/templates");
  return r;
}

export async function resetTemplateAction(kind: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isTemplateKind(kind)) return { ok: false, error: "Unknown template." };
  resetTemplate(currentWorkspace(), kind);
  revalidatePath("/setup/templates");
  return { ok: true };
}
