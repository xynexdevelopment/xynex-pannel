import express from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getEggs, getEgg, createEgg, deleteEgg, renameCategory, getEggLibrary, importLibraryEggs } from "../controllers/eggs.js";

const router = express.Router();

router.get("/", requireAuth, getEggs);
// Library routes must come before "/:id" so "library" is not treated as an egg id.
router.get("/library", requireAdmin, getEggLibrary);
router.post("/library/import", requireAdmin, importLibraryEggs);
router.get("/:id", requireAuth, getEgg);
router.post("/", requireAdmin, createEgg);
router.put("/category", requireAdmin, renameCategory);
router.delete("/:id", requireAdmin, deleteEgg);

export default router;
