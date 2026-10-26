// How a code is found in a text. It's the same rule as Fwrd's webhook examples
// (github.com/alanwtom/fwrd-sms-webhook-examples): the first run of 4 to 8 digits, or two
// groups of 3 or 4 digits split by a space or a dash ("123 456", "123-4567"), returned as
// digits only. Digits that touch other digits don't count, so phone numbers and long
// account numbers are skipped.
const CODE = /(?<!\d)(\d{3,4})[ -]?(\d{3,4})(?!\d)|(?<!\d)(\d{4,8})(?!\d)/;

export function extractCode(text: string): string | null {
  const match = CODE.exec(text);
  if (!match) return null;
  return match[3] ?? `${match[1]}${match[2]}`;
}
