export type DialogKind = "select" | "confirm" | "input" | "editor" | "question";

export type DialogState = "pending" | "answered" | "cancelled" | "expired";

export type DialogOption = { readonly value: string; readonly label: string; readonly onceOnly: boolean };

export type Dialog = {
  readonly id: string;
  readonly kind: DialogKind;
  readonly options: readonly DialogOption[];
  readonly required: boolean;
  readonly state: DialogState;
  readonly answer: string | null;
};

export type DialogFailureCode =
  | "UNKNOWN_DIALOG"
  | "NOT_PENDING"
  | "UNKNOWN_OPTION"
  | "INVALID_ANSWER"
  | "ALREADY_ANSWERED"
  | "EMPTY_ANSWER";

export type DialogRefused = { readonly kind: "refused"; readonly code: DialogFailureCode };
export type DialogAccepted = {
  readonly kind: "accepted";
  readonly dialogId: string;
  readonly value: string;
  readonly authorization: "client-reported";
  readonly serverVerified: false;
};
export type DialogResult = DialogAccepted | DialogRefused;

export function dialogRefused(code: DialogFailureCode): DialogRefused {
  return { kind: "refused", code: code };
}

const OPTION_KINDS: readonly DialogKind[] = ["select", "confirm", "question"];

export class DialogRegistry {
  private readonly dialogs = new Map<string, Dialog>();

  open(dialog: Omit<Dialog, "state" | "answer">): Dialog {
    const record: Dialog = { ...dialog, state: "pending", answer: null };
    this.dialogs.set(record.id, record);
    return record;
  }

  get(dialogId: string): Dialog | undefined {
    return this.dialogs.get(dialogId);
  }

  pendingDialogs(): readonly Dialog[] {
    return [...this.dialogs.values()].filter((dialog) => dialog.state === "pending");
  }

  answer(dialogId: string, value: string): DialogResult {
    const dialog = this.dialogs.get(dialogId);
    if (!dialog) return dialogRefused("UNKNOWN_DIALOG");
    if (dialog.state === "answered") return dialogRefused("ALREADY_ANSWERED");
    if (dialog.state !== "pending") return dialogRefused("NOT_PENDING");

    if (OPTION_KINDS.includes(dialog.kind)) {
      const match = dialog.options.find((option) => option.value === value);
      if (!match) return dialogRefused("UNKNOWN_OPTION");
    } else if (value.length === 0) {
      return dialogRefused("EMPTY_ANSWER");
    }

    this.dialogs.set(dialogId, { ...dialog, state: "answered", answer: value });
    return {
      kind: "accepted",
      dialogId: dialogId,
      value: value,
      authorization: "client-reported",
      serverVerified: false,
    };
  }

  cancel(dialogId: string): DialogResult {
    const dialog = this.dialogs.get(dialogId);
    if (!dialog) return dialogRefused("UNKNOWN_DIALOG");
    if (dialog.state !== "pending") return dialogRefused("NOT_PENDING");
    this.dialogs.set(dialogId, { ...dialog, state: "cancelled" });
    return dialogRefused("NOT_PENDING");
  }

  expire(dialogId: string): DialogResult {
    const dialog = this.dialogs.get(dialogId);
    if (!dialog) return dialogRefused("UNKNOWN_DIALOG");
    if (dialog.state !== "pending") return dialogRefused("NOT_PENDING");
    this.dialogs.set(dialogId, { ...dialog, state: "expired" });
    return dialogRefused("NOT_PENDING");
  }

  restorePending(dialogs: readonly Dialog[]): void {
    for (const dialog of dialogs) {
      if (dialog.state !== "pending") continue;
      this.dialogs.set(dialog.id, dialog);
    }
  }
}
