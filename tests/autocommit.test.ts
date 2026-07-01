/**
 * Auto-commit orchestrator tests (Workstream C). In-memory query recorder + enqueue spy — no DB/queue.
 */
import { describe, it, expect } from "vitest";
import { autoCommit, type DeepenSummary } from "../lib/engines/autocommit";
import { JOB } from "../lib/queue/types";

function recorder(insertRowCount = 1) {
  const calls: { text: string; params: unknown[] }[] = [];
  const query = async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    const rowCount = text.includes("INSERT INTO thesis_approvals") ? insertRowCount : 1;
    return { rows: [] as unknown[], rowCount };
  };
  const find = (needle: string) => calls.find((c) => c.text.includes(needle));
  return { query, calls, find };
}

function enqueueSpy() {
  const calls: { name: string; data: Record<string, unknown>; opts?: { singletonKey?: string } }[] = [];
  const enqueue = async (name: string, data: Record<string, unknown>, opts?: { singletonKey?: string }) => {
    calls.push({ name, data, opts });
    return "job-1";
  };
  return { enqueue: enqueue as never, calls };
}

const summ = (o: Partial<DeepenSummary> = {}): DeepenSummary => ({
  cleared: true, publishedBelowBar: false, finalConfidence: 0.82, rounds: 1, stoppedReason: "cleared", noteLines: [], ...o,
});

describe("autoCommit", () => {
  it("cleared -> desk approval, published (downgrade-safe), enqueues content", async () => {
    const db = recorder();
    const q = enqueueSpy();
    const r = await autoCommit({ companyId: "co1", snapshotId: "snap1", deepen: summ() }, { query: db.query, enqueue: q.enqueue });

    expect(r).toMatchObject({ committed: true, approvalWritten: true, status: "published", jobId: "job-1" });

    const ins = db.find("INSERT INTO thesis_approvals");
    expect(ins?.text).toContain("'desk'");
    expect(ins?.text).toContain("ON CONFLICT (snapshot_id) DO NOTHING");

    const upd = db.find("SET coverage_status=$2");
    expect(upd?.text).toContain("coverage_status IN ('in_research','in_review','queued','watchlist')");
    expect(upd?.text).not.toContain("monitoring"); // never downgrades a live/monitoring asset
    expect(upd?.params?.[1]).toBe("published");

    expect(q.calls).toHaveLength(1);
    expect(q.calls[0].name).toBe(JOB.GENERATE_CONTENT);
    expect(q.calls[0].data).toEqual({ company_id: "co1", snapshot_id: "snap1" });
    expect(q.calls[0].opts?.singletonKey).toBe("content:snap1");
  });

  it("below-bar with policy=true still commits and publishes", async () => {
    const db = recorder();
    const q = enqueueSpy();
    const r = await autoCommit(
      { companyId: "co1", snapshotId: "snap1", deepen: summ({ cleared: false, publishedBelowBar: true, finalConfidence: 0.6, stoppedReason: "rounds_exhausted" }) },
      { query: db.query, enqueue: q.enqueue },
    );
    expect(r.committed).toBe(true);
    expect(r.reason).toBe("published_below_bar");
    expect(db.find("INSERT INTO thesis_approvals")?.text).toContain("'desk'");
    expect(q.calls).toHaveLength(1);
  });

  it("below-bar with policy=false holds at in_review, no approval, no enqueue", async () => {
    const db = recorder();
    const q = enqueueSpy();
    const r = await autoCommit(
      { companyId: "co1", snapshotId: "snap1", deepen: summ({ cleared: false, publishedBelowBar: false }) },
      { query: db.query, enqueue: q.enqueue },
    );
    expect(r).toMatchObject({ committed: false, approvalWritten: false, status: "in_review", jobId: null });
    expect(db.find("INSERT INTO thesis_approvals")).toBeUndefined();
    const hold = db.find("coverage_status='in_review'");
    expect(hold?.text).toContain("IN ('in_research','in_review','queued','watchlist','published','monitoring')");
    expect(q.calls).toHaveLength(0);
  });

  it("idempotent: DO NOTHING (rowCount 0) -> approvalWritten false, still committed", async () => {
    const db = recorder(0);
    const q = enqueueSpy();
    const r = await autoCommit({ companyId: "co1", snapshotId: "snap1", deepen: summ() }, { query: db.query, enqueue: q.enqueue });
    expect(r.committed).toBe(true);
    expect(r.approvalWritten).toBe(false);
    expect(q.calls).toHaveLength(1); // still (re)enqueues content; the job is itself idempotent
  });
});
