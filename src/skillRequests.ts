import { all, get, insert, nextId, parseJson, update } from "./db.ts";
import { nowIso } from "./util.ts";

export interface SkillRequestRow {
  id: string;
  reason: string;
  category: string;
  customer_id: string;
  inspection_id: string | null;
  example: string;
  status: "open" | "in_progress" | "done";
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Records that a product had no suitable skill, so the skill builder can pick it up. */
export function createSkillRequest(input: {
  reason: string;
  category: string;
  customerId: string;
  inspectionId: string;
  example: unknown;
}): string {
  const existing = get<SkillRequestRow>(
    "SELECT * FROM skill_requests WHERE category = ? AND status != 'done' ORDER BY created_at LIMIT 1",
    input.category,
  );
  if (existing) return existing.id;
  const id = nextId("REQ", 4);
  const now = nowIso();
  insert("skill_requests", {
    id,
    reason: input.reason,
    category: input.category,
    customer_id: input.customerId,
    inspection_id: input.inspectionId,
    example: input.example,
    status: "open",
    created_at: now,
    updated_at: now,
  });
  return id;
}

export function listSkillRequests() {
  return all<SkillRequestRow>("SELECT * FROM skill_requests ORDER BY status = 'done', created_at DESC").map((r) => ({
    ...r,
    example: parseJson(r.example, {}),
  }));
}

export function getSkillRequest(id: string) {
  return get<SkillRequestRow>("SELECT * FROM skill_requests WHERE id = ?", id);
}

export function setSkillRequestStatus(id: string, status: SkillRequestRow["status"], sessionId?: string) {
  update("skill_requests", "id", id, { status, ...(sessionId ? { session_id: sessionId } : {}), updated_at: nowIso() });
}
