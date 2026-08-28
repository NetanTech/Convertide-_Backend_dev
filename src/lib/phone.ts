import {
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";

export function validatePhoneE164(phone: string): { ok: true; e164: string } | { ok: false; message: string } {
  const trimmed = phone.trim();
  if (!trimmed) {
    return { ok: true, e164: "" };
  }

  const parsed = parsePhoneNumberFromString(trimmed.startsWith("+") ? trimmed : `+${trimmed}`);
  if (!parsed?.isValid()) {
    return { ok: false, message: "Enter a valid phone number with country code" };
  }

  return { ok: true, e164: parsed.format("E.164") };
}

export function validatePhoneForCountry(
  countryIso: string,
  nationalNumber: string
): { ok: true; e164: string } | { ok: false; message: string } {
  const digits = nationalNumber.replace(/\D/g, "");
  if (!digits) {
    return { ok: true, e164: "" };
  }

  const iso = countryIso as CountryCode;
  const parsed = parsePhoneNumberFromString(digits, iso);
  if (!parsed || !isValidPhoneNumber(parsed.number, iso)) {
    return { ok: false, message: "Enter a valid phone number for the selected country" };
  }

  return { ok: true, e164: parsed.format("E.164") };
}
