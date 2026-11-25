import { Option, Result, Schema, SchemaIssue, SchemaParser } from "../../schema/node_modules/effect/dist/index.js";

/**
 * The dialog frames the OmO/Senpi host actually writes on the RPC socket, validated against the
 * shapes `packages/coding-agent/src/modes/rpc/rpc-question-types.ts` declares and
 * `docs/rpc.md`'s Extension UI Protocol documents. See `spec/host-frame-vocabulary.md` for the
 * citations behind each one.
 *
 * These are not the OpenCode event manifest: this host has no `permission.asked`, `permission.replied`
 * or `form.*` event, so a permission prompt can only be seen through the `select` dialog decoded here.
 *
 * The schemas decode the encoded wire value, so a valid frame is handed out with the fields declared
 * below and nothing invented; Effect's struct decoding drops fields no schema lists.
 */

const RemoteOriginSchema = Schema.Struct({
  deviceId: Schema.String,
  deviceName: Schema.optional(Schema.String),
});

/** A permission prompt, and every other `ctx.ui.select` dialog, as written by `createDialogPromise`. */
const SelectRequestSchema = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  method: Schema.Literal("select"),
  title: Schema.String,
  options: Schema.Array(Schema.String),
  timeout: Schema.optional(Schema.Number),
  toolCallId: Schema.optional(Schema.String),
  parentToolCallId: Schema.optional(Schema.String),
  remoteOrigin: Schema.optional(RemoteOriginSchema),
  grantSelect: Schema.optional(Schema.Boolean),
  /* the routing tag a multi-session host applies to every record */
  sessionId: Schema.optional(Schema.String),
});

/** A structured question, as written by `ConnectionQuestionBridge.ask`. */
const QuestionRequestSchema = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  method: Schema.Literal("question"),
  requestId: Schema.String,
  toolCallId: Schema.String,
  waitForAnswer: Schema.Boolean,
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      header: Schema.String,
      question: Schema.String,
      options: Schema.Array(
        Schema.Struct({
          label: Schema.String,
          description: Schema.optional(Schema.String),
        }),
      ),
      multiSelect: Schema.Boolean,
    }),
  ),
  raisedBy: Schema.optional(Schema.String),
  remoteOrigin: Schema.optional(RemoteOriginSchema),
  timeout: Schema.Number,
  askedAtMs: Schema.Number,
  deadlineAtMs: Schema.Number,
  remainingMs: Schema.Number,
  sessionId: Schema.optional(Schema.String),
});

/** A plain confirmation prompt, as written by the ui broker's confirm dialog. */
const ConfirmRequestSchema = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  method: Schema.Literal("confirm"),
  title: Schema.String,
  message: Schema.String,
  timeout: Schema.optional(Schema.Number),
  remoteOrigin: Schema.optional(RemoteOriginSchema),
  sessionId: Schema.optional(Schema.String),
});

/** A free text prompt. */
const InputRequestSchema = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  method: Schema.Literal("input"),
  title: Schema.String,
  placeholder: Schema.optional(Schema.String),
  secret: Schema.optional(Schema.Boolean),
  deadlineAtMs: Schema.optional(Schema.Number),
  timeout: Schema.optional(Schema.Number),
  toolCallId: Schema.optional(Schema.String),
  parentToolCallId: Schema.optional(Schema.String),
  remoteOrigin: Schema.optional(RemoteOriginSchema),
  sessionId: Schema.optional(Schema.String),
});

/** A multi-line editor prompt. */
const EditorRequestSchema = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  method: Schema.Literal("editor"),
  title: Schema.String,
  prefill: Schema.optional(Schema.String),
  remoteOrigin: Schema.optional(RemoteOriginSchema),
  sessionId: Schema.optional(Schema.String),
});

const QuestionAnswersSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    selected: Schema.Array(Schema.String),
    text: Schema.optional(Schema.String),
  }),
);

const ResponseFrameFields = {
  type: Schema.Literal("extension_ui_response"),
  id: Schema.String,
  /* names the extension_ui_request answered; without it, `id` does */
  uiRequestId: Schema.optional(Schema.String),
  answerId: Schema.optional(Schema.String),
  secret: Schema.optional(Schema.Boolean),
  sessionId: Schema.optional(Schema.String),
} as const;

/** The answer to a `select`/`input`/`editor` dialog: the chosen option label or typed text. */
const ValueResponseSchema = Schema.Struct({
  ...ResponseFrameFields,
  value: Schema.String,
});

/** The answer to a `question` dialog: selections per question id, plus an optional comment. */
const QuestionAnswerSchema = Schema.Struct({
  ...ResponseFrameFields,
  answers: QuestionAnswersSchema,
  comment: Schema.optional(Schema.String),
});

/** The answer to a `confirm` dialog. */
const ConfirmedResponseSchema = Schema.Struct({
  ...ResponseFrameFields,
  confirmed: Schema.Boolean,
});

/** A dialog dismissed by the client, for any dialog method. */
const CancellationSchema = Schema.Struct({
  ...ResponseFrameFields,
  cancelled: Schema.Literal(true),
});

/** The host's terminal outcome for a `question`, broadcast once it settles. */
const QuestionResolvedSchema = Schema.Struct({
  type: Schema.Literal("question_resolved"),
  id: Schema.String,
  resolvedBy: Schema.optional(
    Schema.Union([
      Schema.Literal("local_ui"),
      Schema.Literal("rpc_connection"),
      Schema.Literal("control_endpoint"),
    ]),
  ),
  requestId: Schema.String,
  toolCallId: Schema.String,
  outcome: Schema.Union([
    Schema.Literal("answered"),
    Schema.Literal("comment-submitted"),
    Schema.Literal("timed_out"),
    Schema.Literal("cancelled"),
    Schema.Literal("orphaned-after-restart"),
    Schema.Literal("unavailable"),
  ]),
  answers: QuestionAnswersSchema,
  comment: Schema.optional(Schema.String),
  unanswered: Schema.Array(Schema.String),
  deadlineAtMs: Schema.optional(Schema.Number),
  sessionId: Schema.optional(Schema.String),
});

export type ConfirmedResponseFrame = Schema.Schema.Type<typeof ConfirmedResponseSchema>;
export type SelectRequestFrame = Schema.Schema.Type<typeof SelectRequestSchema>;
export type ConfirmRequestFrame = Schema.Schema.Type<typeof ConfirmRequestSchema>;
export type InputRequestFrame = Schema.Schema.Type<typeof InputRequestSchema>;
export type EditorRequestFrame = Schema.Schema.Type<typeof EditorRequestSchema>;
export type QuestionRequestFrame = Schema.Schema.Type<typeof QuestionRequestSchema>;
export type ValueResponseFrame = Schema.Schema.Type<typeof ValueResponseSchema>;
export type QuestionAnswerFrame = Schema.Schema.Type<typeof QuestionAnswerSchema>;
export type CancellationFrame = Schema.Schema.Type<typeof CancellationSchema>;
export type QuestionResolvedFrame = Schema.Schema.Type<typeof QuestionResolvedSchema>;

export type HostFrame =
  | SelectRequestFrame
  | ConfirmRequestFrame
  | InputRequestFrame
  | EditorRequestFrame
  | QuestionRequestFrame
  | ValueResponseFrame
  | ConfirmedResponseFrame
  | QuestionAnswerFrame
  | CancellationFrame
  | QuestionResolvedFrame;

export type HostFrameDecoded = { readonly ok: true; readonly frame: HostFrame };
export type HostFrameRejected = { readonly ok: false; readonly reason: string };
export type HostFrameDecodeResult = HostFrameDecoded | HostFrameRejected;

const readEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.String,
    method: Schema.optional(Schema.String),
  }),
);

/** Which payload an `extension_ui_response` carries; the typed decode below decides whether it is valid. */
const readResponsePayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cancelled: Schema.optional(Schema.Unknown),
    confirmed: Schema.optional(Schema.Unknown),
    value: Schema.optional(Schema.Unknown),
    answers: Schema.optional(Schema.Unknown),
  }),
);

const decodeSelectRequest = SchemaParser.decodeUnknownResult(SelectRequestSchema);
const decodeQuestionRequest = SchemaParser.decodeUnknownResult(QuestionRequestSchema);
const decodeConfirmRequest = SchemaParser.decodeUnknownResult(ConfirmRequestSchema);
const decodeInputRequest = SchemaParser.decodeUnknownResult(InputRequestSchema);
const decodeEditorRequest = SchemaParser.decodeUnknownResult(EditorRequestSchema);
const decodeConfirmedResponse = SchemaParser.decodeUnknownResult(ConfirmedResponseSchema);
const decodeValueResponse = SchemaParser.decodeUnknownResult(ValueResponseSchema);
const decodeQuestionAnswer = SchemaParser.decodeUnknownResult(QuestionAnswerSchema);
const decodeCancellation = SchemaParser.decodeUnknownResult(CancellationSchema);
const decodeQuestionResolved = SchemaParser.decodeUnknownResult(QuestionResolvedSchema);

const formatIssue = SchemaIssue.makeFormatterDefault();

/**
 * Validates one host JSONL frame. Only the frames the host is verified to write are decoded:
 *
 * - `extension_ui_request` with `method: "select"` -- a permission prompt or any other select dialog;
 * - `extension_ui_request` with `method: "question"` -- a structured question prompt;
 * - `extension_ui_response` with `value` -- the answer to a select/input/editor dialog;
 * - `extension_ui_response` with `answers` -- the answer to a question;
 * - `extension_ui_response` with `cancelled: true` -- a dismissed dialog;
 * - `question_resolved` -- the host's terminal outcome for a question.
 *
 * A fire-and-forget request method (`notify`, `setStatus`, `setWidget`, ...), an OpenCode-schema event
 * such as `permission.asked`, or any other type is rejected with a reason rather than guessed at, and
 * nothing throws.
 */
export function decodeHostFrame(frame: unknown): HostFrameDecodeResult {
  const envelope = readEnvelope(frame);
  if (Option.isNone(envelope)) return { ok: false, reason: "host frame has no string type" };

  if (envelope.value.type === "extension_ui_request") {
    if (envelope.value.method === "select") {
      const decoded = decodeSelectRequest(frame);
      if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
      return { ok: true, frame: decoded.success };
    }
    if (envelope.value.method === "question") {
      const decoded = decodeQuestionRequest(frame);
      if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
      return { ok: true, frame: decoded.success };
    }
    if (envelope.value.method === "confirm") {
      const decoded = decodeConfirmRequest(frame);
      if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
      return { ok: true, frame: decoded.success };
    }
    if (envelope.value.method === "input") {
      const decoded = decodeInputRequest(frame);
      if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
      return { ok: true, frame: decoded.success };
    }
    if (envelope.value.method === "editor") {
      const decoded = decodeEditorRequest(frame);
      if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
      return { ok: true, frame: decoded.success };
    }
    return {
      ok: false,
      reason: "extension_ui_request method not decoded: " + (envelope.value.method ?? "(missing)"),
    };
  }

  if (envelope.value.type === "extension_ui_response") {
    const payload = readResponsePayload(frame);
    if (Option.isNone(payload)) return { ok: false, reason: "extension_ui_response is not an object" };
    if (payload.value.cancelled !== undefined) {
      const decoded = decodeCancellation(frame);
      if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
      return { ok: true, frame: decoded.success };
    }
    if (payload.value.answers !== undefined) {
      const decoded = decodeQuestionAnswer(frame);
      if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
      return { ok: true, frame: decoded.success };
    }
    if (payload.value.confirmed !== undefined) {
      const decoded = decodeConfirmedResponse(frame);
      if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
      return { ok: true, frame: decoded.success };
    }
    if (payload.value.value !== undefined) {
      const decoded = decodeValueResponse(frame);
      if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
      return { ok: true, frame: decoded.success };
    }
    return { ok: false, reason: "extension_ui_response has none of value, answers or cancelled" };
  }

  if (envelope.value.type === "question_resolved") {
    const decoded = decodeQuestionResolved(frame);
    if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
    return { ok: true, frame: decoded.success };
  }

  return { ok: false, reason: "unknown host frame type: " + envelope.value.type };
}

export type HostQuestionAnswers = Schema.Schema.Type<typeof QuestionAnswersSchema>;

/** What a client writes back: the chosen option label, an answer set, or a dismissal. */
export type HostResponseAnswer =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "confirmed"; readonly confirmed: boolean }
  | { readonly kind: "answers"; readonly answers: HostQuestionAnswers; readonly comment?: string }
  | { readonly kind: "cancelled" };

export type HostResponseInput = {
  /** the response's own correlation id; it is not the id of the request being answered */
  readonly id: string;
  /** the `extension_ui_request` frame id this response answers */
  readonly uiRequestId: string;
  /**
   * The routing tag the answered dialog carried. A multi-session host scopes
   * `extension_ui_response` by session and refuses one without it (`missing_session_id`), so the
   * answer is dead on a routed host unless this is passed through from the request.
   */
  readonly sessionId?: string;
  readonly answer: HostResponseAnswer;
};

export type HostResponseEncoded = { readonly ok: true; readonly frame: HostResponseFrame };
export type HostResponseRejected = { readonly ok: false; readonly reason: string };

export type HostResponseFrame = ValueResponseFrame | ConfirmedResponseFrame | QuestionAnswerFrame | CancellationFrame;

/**
 * Builds the one `extension_ui_response` frame a client is verified to write, and hands it back only
 * after the decoder's own schema accepted it, so nothing the host does not declare can reach the
 * socket. `answerId` and `secret` stay absent: this bridge asks for no receipt. `sessionId` is the
 * routing tag the host scopes the answer by, and it travels only when the caller passes the one the
 * dialog carried.
 */
export function encodeHostResponseFrame(input: HostResponseInput): HostResponseEncoded | HostResponseRejected {
  const base = {
    type: "extension_ui_response",
    id: input.id,
    uiRequestId: input.uiRequestId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
  const answer = input.answer;
  if (answer.kind === "value") {
    const decoded = decodeValueResponse({ ...base, value: answer.value });
    if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
    return { ok: true, frame: decoded.success };
  }
  if (answer.kind === "confirmed") {
    const decoded = decodeConfirmedResponse({ ...base, confirmed: answer.confirmed });
    if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
    return { ok: true, frame: decoded.success };
  }
  if (answer.kind === "answers") {
    const decoded =
      answer.comment === undefined
        ? decodeQuestionAnswer({ ...base, answers: answer.answers })
        : decodeQuestionAnswer({ ...base, answers: answer.answers, comment: answer.comment });
    if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
    return { ok: true, frame: decoded.success };
  }
  const decoded = decodeCancellation({ ...base, cancelled: true });
  if (Result.isFailure(decoded)) return { ok: false, reason: formatIssue(decoded.failure) };
  return { ok: true, frame: decoded.success };
}
