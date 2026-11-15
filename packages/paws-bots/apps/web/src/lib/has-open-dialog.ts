export function hasOpenDialog(
  doc: Pick<Document, "querySelector"> = document,
  includeMenus = false,
): boolean {
  const selector = '[role="dialog"], [role="alertdialog"], dialog[open]';
  return doc.querySelector(includeMenus ? `${selector}, [role="menu"]` : selector) !== null;
}
