import { describe, it, expect } from "vitest";
import { confirmDialog, promptDialog, getActiveDialog, settleDialog } from "../src/lib/dialog";

describe("confirmDialog", () => {
  it("splits title/description and flags destructive actions", async () => {
    const p = confirmDialog('Delete world "survival"? This cannot be undone.');
    const d = getActiveDialog()!;
    expect(d.title).toBe('Delete world "survival"?');
    expect(d.description).toBe("This cannot be undone.");
    expect(d.tone).toBe("danger");
    expect(d.confirmLabel).toBe("Delete");
    settleDialog(d.id, true);
    await expect(p).resolves.toBe(true);
  });
  it("treats unban as non-destructive and resolves false on cancel", async () => {
    const p = confirmDialog("Unban 1.2.3.4?");
    const d = getActiveDialog()!;
    expect(d.tone).toBe("default");
    expect(d.confirmLabel).toBe("Unban");
    settleDialog(d.id, false);
    await expect(p).resolves.toBe(false);
  });
  it("queues dialogs and shows them one at a time", async () => {
    const a = confirmDialog("First?");
    const b = confirmDialog("Second?");
    const first = getActiveDialog()!;
    expect(first.title).toBe("First?");
    settleDialog(first.id, true);
    expect(getActiveDialog()!.title).toBe("Second?");
    settleDialog(getActiveDialog()!.id, false);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(false);
  });
});

describe("promptDialog", () => {
  it("extracts a placeholder and returns null on cancel", async () => {
    const p = promptDialog("Enter new file name (e.g. config.yml):");
    const d = getActiveDialog()!;
    expect(d.kind).toBe("prompt");
    expect(d.title).toBe("Enter new file name");
    expect(d.placeholder).toBe("e.g. config.yml");
    settleDialog(d.id, null);
    await expect(p).resolves.toBeNull();
  });
  it("returns the typed value", async () => {
    const p = promptDialog("Enter archive name:", "archive.zip");
    const d = getActiveDialog()!;
    expect(d.defaultValue).toBe("archive.zip");
    settleDialog(d.id, "backup.zip");
    await expect(p).resolves.toBe("backup.zip");
  });
});
