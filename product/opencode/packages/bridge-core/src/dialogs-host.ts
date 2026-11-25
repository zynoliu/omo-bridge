import type {
  ConfirmRequestFrame,
  EditorRequestFrame,
  HostResponseFrame,
  InputRequestFrame,
  QuestionRequestFrame,
  SelectRequestFrame,
} from "./host-frames.ts";

/**
 * Live host dialogs: the `extension_ui_request` frames the OmO/Senpi host writes while it waits for
 * an answer, kept in the shape the host wrote them.
 *
 * They are deliberately not projected into the OpenCode `PermissionRequest` / `FormInfo` types. A
 * `select` dialog carries a title and an option list and nothing else; turning it into a permission
 * request would have to invent an `action` and `resources`, and turning it into a form would have to
 * invent fields. See `spec/host-frame-vocabulary.md` for what the host actually writes.
 */

export type HostDialogRequestFrame =
  | SelectRequestFrame
  | QuestionRequestFrame
  | ConfirmRequestFrame
  | InputRequestFrame
  | EditorRequestFrame;

/** A validated `extension_ui_response`, as `encodeHostResponseFrame` produced it. */
export type HostDialogSender = (frame: HostResponseFrame) => void;

export type HostDialogChange =
  | { readonly kind: "open"; readonly dialog: HostDialogRequestFrame }
  | { readonly kind: "closed"; readonly dialogId: string };

export class HostDialogStore {
  private readonly dialogs = new Map<string, HostDialogRequestFrame>();
  private readonly listeners = new Set<(change: HostDialogChange) => void>();
  private send: HostDialogSender | undefined;

  /**
   * The launcher owns the socket, so it injects the writer; without one an answer fails loudly
   * instead of being reported as sent.
   */
  useSender(sender: HostDialogSender | undefined): void {
    this.send = sender;
  }

  sender(): HostDialogSender | undefined {
    return this.send;
  }

  upsert(dialog: HostDialogRequestFrame): HostDialogRequestFrame {
    this.dialogs.set(dialog.id, dialog);
    this.emit({ kind: "open", dialog: dialog });
    return dialog;
  }

  /** Answering an id the store no longer holds is a no-op, so a second resolve is harmless. */
  resolve(dialogId: string): boolean {
    const removed = this.dialogs.delete(dialogId);
    if (!removed) return false;
    this.emit({ kind: "closed", dialogId: dialogId });
    return true;
  }

  /** `question_resolved` carries the question's own `requestId`, not the dialog frame id. */
  resolveRequest(requestId: string): boolean {
    const match = [...this.dialogs.values()].find(
      (dialog) => dialog.method === "question" && dialog.requestId === requestId,
    );
    if (match === undefined) return false;
    return this.resolve(match.id);
  }

  get(dialogId: string): HostDialogRequestFrame | undefined {
    return this.dialogs.get(dialogId);
  }

  list(): HostDialogRequestFrame[] {
    return [...this.dialogs.values()];
  }

  subscribe(listener: (change: HostDialogChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: HostDialogChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}
