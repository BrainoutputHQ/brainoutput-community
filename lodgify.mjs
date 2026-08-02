// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — Lodgify connector: live READ-ONLY client (2026-08-02, task-pm-12).
// A hotel workspace asks its Brain "how many rooms are occupied today?" — the answer lives in the
// Lodgify availability calendar, not in a model. This client speaks the Lodgify Public API v2
// (OpenAPI verified 2026-08-02 against docs.lodgify.com): X-ApiKey header auth, GET requests only —
// there is NO write verb anywhere in this module, by design. The API key resolves at execution
// time (e.g. store.secretResolver()) — never exported, never logged. Zero-dep (Node ≥18 fetch).
//
// DECLARED UNVERIFIED against the live API until a real key has answered: field names follow the
// published OpenAPI reference (CalendarDto / RoomDetailsDto / Error), and every enrichment read
// (property names, room names, unit counts) degrades gracefully instead of failing the answer.
//
//   const lg = lodgifyClient({ apiKey });
//   const occ = await occupancyToday({ client: lg });
export const LODGIFY_BASE_URL = "https://api.lodgify.com";

export function lodgifyClient({ apiKey, fetchImpl = fetch, timeoutMs = 20000, baseUrl = LODGIFY_BASE_URL } = {}) {
  if (!apiKey) throw new Error("lodgifyClient needs an API key (Lodgify app → Settings → API)");
  const base = String(baseUrl || LODGIFY_BASE_URL).replace(/\/+$/, "");

  async function get(path, params = {}) {
    const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    const r = await fetchImpl(`${base}${path}${qs ? `?${qs}` : ""}`, {
      headers: { "X-ApiKey": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => null);
    // Errors are JSON { message, code, correlation_id } (400/401/404/500) — surface them LOUD.
    if (!r.ok) throw new Error(`Lodgify ${path} → HTTP ${r.status}${j?.message ? `: ${j.message}` : ""}${j?.code ? ` (${j.code})` : ""}`);
    return j;
  }

  const asList = (j) => (Array.isArray(j) ? j : j?.items || j?.results || j?.data || []);

  return {
    // GET /v2/properties — paged (limit/offset); `maxPages` bounds the walk.
    getProperties: async ({ limit = 100, maxPages = 25 } = {}) => {
      const out = [];
      for (let page = 0; page < maxPages; page++) {
        const items = asList(await get("/v2/properties", { limit, offset: out.length }));
        out.push(...items);
        if (items.length < limit) break;
      }
      return out;
    },
    // GET /v2/properties/{id}/rooms — RoomDetailsDto[]: { id, name, units, … } ("Available rooms").
    getRooms: async (propertyId) => asList(await get(`/v2/properties/${encodeURIComponent(propertyId)}/rooms`)),
    // GET /v2/availability?start&end&includeDetails=true → CalendarDto[].
    getAvailability: ({ start, end }) => {
      if (!start || !end) throw new Error("getAvailability needs start and end (ISO dates)");
      return get("/v2/availability", { start, end, includeDetails: true });
    },
  };
}

// A booking occupies a unit unless its status says otherwise. Tolerant of casing and spelling
// (Booked/booked/Checked-in count; cancelled/declined/tentative and mere enquiries do not).
const NON_OCCUPIED = /cancel|declin|tentative|inquiry|enquiry|quote|expired/i;
export const isOccupiedBooking = (b) => !NON_OCCUPIED.test(String(b?.status ?? "booked"));

const dateOf = (s) => String(s || "").slice(0, 10);
const covers = (period, date) => dateOf(period?.start) <= date && date <= dateOf(period?.end);

/**
 * "How many rooms are occupied today?" — one deterministic aggregate over the availability
 * calendar. Per room type, `occupied` = the bookings with an occupied status in THE period
 * covering `at`; `units` = the room record's explicit unit count when Lodgify provides one,
 * else occupied + available in that period. A room type with NO period covering `at` reads
 * 0 occupied — never an error. Property/room names are enrichment: when those reads fail the
 * number still computes, with names absent (declared, never hidden).
 */
export async function occupancyToday({ at = null, client } = {}) {
  if (!client) throw new Error("occupancyToday needs a lodgifyClient");
  const now = at ? new Date(at) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`occupancyToday: invalid date '${at}'`);
  const date = now.toISOString().slice(0, 10);
  const next = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);

  const cals = await client.getAvailability({ start: date, end: next });
  const availability = Array.isArray(cals) ? cals : [];
  let properties = [];
  try { properties = await client.getProperties(); } catch { properties = []; }
  const roomsByProp = new Map();
  await Promise.all(properties.map(async (p) => {
    try { roomsByProp.set(p.id, await client.getRooms(p.id)); } catch { roomsByProp.set(p.id, []); }
  }));
  const nameOfProp = new Map(properties.map((p) => [p.id, p.name || null]));
  const roomInfo = new Map();   // `${propertyId}:${roomTypeId}` → { name, units }
  for (const [pid, rooms] of roomsByProp)
    for (const r of rooms || [])
      roomInfo.set(`${pid}:${r.id}`, { name: r.name || null, units: Number.isInteger(r.units) && r.units > 0 ? r.units : null });

  const byProp = new Map();
  const propFor = (pid) => {
    if (!byProp.has(pid)) byProp.set(pid, { propertyId: pid, name: nameOfProp.get(pid) ?? null, roomTypes: [], occupied: 0, total: 0 });
    return byProp.get(pid);
  };
  for (const cal of availability) {
    const prop = propFor(cal.property_id);
    const covering = (cal.periods || []).find((p) => covers(p, date)) || null;
    const bookings = covering?.bookings || [];
    const occupied = bookings.filter(isOccupiedBooking).length;
    const available = covering && Number.isFinite(covering.available) ? covering.available : 0;
    const info = roomInfo.get(`${cal.property_id}:${cal.room_type_id}`) || {};
    const rt = {
      roomTypeId: cal.room_type_id, name: info.name ?? null,
      occupied, available,
      units: info.units ?? occupied + available,
      bookings: bookings.length,
      closed: !!(covering && covering.closed_period),
    };
    prop.roomTypes.push(rt);
    prop.occupied += rt.occupied;
    prop.total += rt.units;
  }
  const out = [...byProp.values()];
  return { date, at: now.toISOString(), properties: out,
    occupied: out.reduce((n, p) => n + p.occupied, 0), total: out.reduce((n, p) => n + p.total, 0) };
}
