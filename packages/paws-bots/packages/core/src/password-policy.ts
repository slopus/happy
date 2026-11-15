/** Length limits for new passwords, with no composition rules (NIST SP 800-63B). */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** iOS AutoFill rules, so a generated password satisfies the server. */
export const PASSWORD_RULES = `minlength: ${MIN_PASSWORD_LENGTH}; maxlength: ${MAX_PASSWORD_LENGTH};`;
