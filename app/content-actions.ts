"use server";
/**
 * Content-layer Server Actions (Phase 8). Generate the spider (deck → newsletter → short-form) and the
 * podcast episode from host notes. Generation runs the live builders; the §8 gate is enforced in
 * assembleSubstance (a NotApprovedError surfaces back to the company page).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { generateSpider, generateEpisode } from "../lib/content/generate";
import { addEpisodeNote } from "../lib/content/notes";

export async function generateContentAction(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  if (!companyId) return;
  let error = "";
  try {
    await generateSpider(companyId);
  } catch (e) {
    error = (e as Error).message;
  }
  if (error) redirect(`/company/${companyId}?content_error=${encodeURIComponent(error)}`);
  revalidatePath("/content");
  redirect("/content");
}

export async function addNoteAction(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const author = String(formData.get("author") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!companyId || !author || !note) return;
  await addEpisodeNote(companyId, author, note);
  revalidatePath(`/content/studio/${companyId}`);
}

export async function buildEpisodeAction(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  if (!companyId) return;
  let episodeId = "";
  let error = "";
  try {
    episodeId = (await generateEpisode(companyId)).id;
  } catch (e) {
    error = (e as Error).message;
  }
  if (error) redirect(`/content/studio/${companyId}?err=${encodeURIComponent(error)}`);
  revalidatePath("/content");
  redirect(`/content/${episodeId}`);
}
