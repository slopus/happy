/** The email provider refused a recipient address; sending again cannot succeed. */
export class EmailRecipientRejectedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmailRecipientRejectedError";
  }
}
