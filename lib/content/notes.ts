/**
 * Podcast studio notes (Phase 8). Each host attaches their own notes to a company's research; the
 * episode builder weaves both note-sets into the script, attributed by author.
 */
import { query } from "../db/pool";

export interface EpisodeNoteRow { id: string; author: string; note: string; used_in: string | null; created_at: string }

export async function addEpisodeNote(companyId: string, author: string, note: string): Promise<void> {
  if (!note.trim() || !author.trim()) return;
  await query("INSERT INTO episode_notes (company_id, author, note) VALUES ($1,$2,$3)", [companyId, author.trim(), note.trim()]);
}

export async function listEpisodeNotes(companyId: string, opts: { unusedOnly?: boolean } = {}): Promise<EpisodeNoteRow[]> {
  const { rows } = await query<EpisodeNoteRow>(
    `SELECT id, author, note, used_in, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
       FROM episode_notes WHERE company_id = $1 ${opts.unusedOnly ? "AND used_in IS NULL" : ""} ORDER BY created_at`,
    [companyId],
  );
  return rows;
}

export async function markNotesUsed(noteIds: string[], episodeId: string): Promise<void> {
  if (!noteIds.length) return;
  await query("UPDATE episode_notes SET used_in = $2 WHERE id = ANY($1)", [noteIds, episodeId]);
}
