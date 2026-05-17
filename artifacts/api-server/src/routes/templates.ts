import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabaseClient";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";

const router: IRouter = Router();

// GET /api/templates
router.get("/templates", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { data, error } = await supabase
    .from("message_templates")
    .select("*")
    .eq("club_id", clubId)
    .order("is_builtin", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data ?? []);
});

// POST /api/templates
router.post("/templates", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { name, body, use_case_tags } = req.body as {
    name?: string;
    body?: string;
    use_case_tags?: string[];
  };

  if (!name?.trim() || !body?.trim()) {
    res.status(400).json({ error: "name and body are required" });
    return;
  }

  const { data, error } = await supabase
    .from("message_templates")
    .insert({
      club_id: clubId,
      name: name.trim(),
      body: body.trim(),
      use_case_tags: use_case_tags ?? [],
      is_builtin: false,
    })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json(data);
});

// PATCH /api/templates/:id
router.patch("/templates/:id", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { id } = req.params;
  const { name, body, use_case_tags } = req.body as {
    name?: string;
    body?: string;
    use_case_tags?: string[];
  };

  if (!name?.trim() || !body?.trim()) {
    res.status(400).json({ error: "name and body are required" });
    return;
  }

  // Cross-tenant guard + built-in check
  const { data: existing } = await supabase
    .from("message_templates")
    .select("is_builtin, club_id")
    .eq("id", id)
    .maybeSingle();

  if (!existing || existing.club_id !== clubId) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  if (existing?.is_builtin) {
    res.status(403).json({ error: "Built-in templates cannot be edited" });
    return;
  }

  const { data, error } = await supabase
    .from("message_templates")
    .update({
      name: name.trim(),
      body: body.trim(),
      use_case_tags: use_case_tags ?? [],
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

export default router;
