import { validEmail, type CvBuilderForm } from "./schemas/cv-builder";

/**
 * The contact step is asked by Huntloop itself, one thing at a time, and never sent to the AI:
 * name and email first (both needed), then phone, city and a link, each of which can be skipped.
 */

export const CONTACT_ORDER = ["name", "email", "phone", "city", "links"] as const;
export type ContactField = (typeof CONTACT_ORDER)[number];
export const REQUIRED_CONTACT: readonly ContactField[] = ["name", "email"];

type Contact = CvBuilderForm["contact"];

const answered = (contact: Contact, field: ContactField) => (field === "links" ? contact.links.length > 0 : field === "email" ? validEmail(contact.email) : !!contact[field].trim());

/** The next thing to ask for: a missing required field first, then an optional one not yet given or skipped. Null when done. */
export function nextContactQuestion(contact: Contact, skipped: readonly ContactField[] = []): ContactField | null {
  return CONTACT_ORDER.find((field) => !answered(contact, field) && (REQUIRED_CONTACT.includes(field) || !skipped.includes(field))) ?? null;
}

export { validEmail };
