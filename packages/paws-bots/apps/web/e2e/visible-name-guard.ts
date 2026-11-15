import type { Locator } from "@playwright/test";
import { expect } from "@playwright/test";

/** Scan controlled fixture screens, not arbitrary user-authored messages/code or inputs. */
export async function expectReadableNames(region: Locator) {
  const text = await region.innerText();
  expect(text).not.toMatch(/__[A-Za-z0-9]+__/);
  expect(text).not.toMatch(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i);
  expect(text).not.toMatch(/\bc[a-z0-9]{24}\b/);
  expect(text).not.toMatch(/\b(?=[a-z0-9]{24}\b)(?=[a-z0-9]*\d)[a-z][a-z0-9]{23}\b/);
  // Known UI namespaces only: filenames, email addresses and prose are valid content.
  expect(text).not.toMatch(
    /\b(?:settings|sidebar|auth|common|account|chat|activity)\.(?!(?:csv|json|txt|md|png|jpg|pdf)\b)[a-z][\w-]*(?:\.[a-z][\w-]*)*\b/,
  );
  expect(text).not.toMatch(/\{\{\s*[A-Za-z][\w.]*\s*\}\}/);
}
