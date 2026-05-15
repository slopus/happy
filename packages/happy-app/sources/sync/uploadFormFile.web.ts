/**
 * Web impl: real Blob constructor works, no temp file needed.
 */
export async function appendFormFile(
    formData: FormData,
    bytes: Uint8Array,
    field: string,
    filename: string,
    contentType: string,
): Promise<() => Promise<void>> {
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: contentType });
    formData.append(field, blob, filename);
    return async () => { /* no-op */ };
}
