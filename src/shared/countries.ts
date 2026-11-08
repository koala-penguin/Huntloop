/** ISO 3166-1 alpha-2 codes. Display names come from Intl.DisplayNames in the user's language. */
export const COUNTRY_CODES = ["AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ","BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ","CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE","EG","EH","ER","ES","ET","FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY","HK","HM","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT","JE","JM","JO","JP","KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW","SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SY","SZ","TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ","UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU","WF","WS","YE","YT","ZA","ZM","ZW"] as const;

/** Huntloop's focus markets, listed first in pickers. */
export const PRIORITY_COUNTRIES = ["AU", "NZ", "SG", "US"] as const;

export function isCountryCode(value: unknown): value is string {
  return typeof value === "string" && (COUNTRY_CODES as readonly string[]).includes(value);
}

/** Names people actually use where Intl's default differs (e.g. Korean "호주" rather than "오스트레일리아"). */
const NAME_OVERRIDES: Record<string, Record<string, string>> = {
  ko: { AU: "호주" },
};

export function countryName(code: string, locale: string): string {
  const override = NAME_OVERRIDES[locale.split("-")[0]]?.[code];
  if (override) return override;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Countries sorted for a picker: focus markets first, then alphabetical in the user's language. */
export function countryOptions(locale: string): Array<{ code: string; name: string }> {
  const priority = PRIORITY_COUNTRIES.map((code) => ({ code, name: countryName(code, locale) }));
  const rest = COUNTRY_CODES.filter((c) => !(PRIORITY_COUNTRIES as readonly string[]).includes(c))
    .map((code) => ({ code, name: countryName(code, locale) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  return [...priority, ...rest];
}

/** "Sydney NSW · Australia", without repeating a country the location text already names. */
export function placeLabel(locationText: string | null, country: string | null, locale: string): string | null {
  const name = country ? countryName(country, locale) : null;
  const english = country ? countryName(country, "en") : null;
  const mentions = (n: string | null) => !!(n && locationText && locationText.toLowerCase().includes(n.toLowerCase()));
  const parts = [locationText, mentions(name) || mentions(english) || (locationText && country && new RegExp(`\\b${country}\\b`).test(locationText)) ? null : name];
  return parts.filter(Boolean).join(" · ") || null;
}
