/**
 * PDF attachments currently pass through whole-buffer encryption/decryption,
 * Keep this lower than the transport's 50MB ceiling until the blob protocol
 * supports streaming and no longer holds plaintext and ciphertext together.
 */
export const MAX_PDF_FILE_SIZE_MB = 10;
export const MAX_PDF_FILE_SIZE = MAX_PDF_FILE_SIZE_MB * 1024 * 1024;
