"use client";
/**
 * Delete-company button (operator/admin). Wraps the deleteCompany server action in a form and guards
 * it with a native confirm() — deleting is irreversible (stops processing + removes all research).
 * `variant="row"` is the compact table-row control; the default is a labeled admin button.
 */
import type { FormEvent } from "react";
import { deleteCompany } from "./actions";

export default function DeleteCompany({ id, name, variant = "button" }: { id: string; name: string; variant?: "row" | "button" }) {
  const confirmDelete = (e: FormEvent) => {
    if (!confirm(`Delete ${name}?\n\nThis stops any in-flight processing and permanently removes the company and all of its research, content, and history. This cannot be undone.`)) {
      e.preventDefault();
    }
  };
  return (
    <form action={deleteCompany} onSubmit={confirmDelete} className="inline">
      <input type="hidden" name="company_id" value={id} />
      {variant === "row" ? (
        <button className="ghost" type="submit" title="Delete & stop processing" style={{ padding: ".2rem .5rem", fontSize: ".8rem" }}>✕ delete</button>
      ) : (
        <button className="ghost" type="submit" title="Delete & stop processing" style={{ color: "var(--bad, #c0392b)" }}>🗑 Delete company</button>
      )}
    </form>
  );
}
