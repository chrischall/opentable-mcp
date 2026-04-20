/**
 * Parse OpenTable's `RestaurantsAvailability` GraphQL response shape.
 *
 * The response is an Apollo persisted query — we don't have (or need)
 * the full GraphQL text; we send the operation name + `extensions.persistedQuery
 * .sha256Hash` and the server executes the pre-registered query.
 *
 * Response shape (abridged, matching what was captured during Phase C
 * discovery on 2026-04-20):
 *
 *   {
 *     "data": {
 *       "availability": [
 *         {
 *           "restaurantId": 54232,
 *           "restaurantAvailabilityToken": "eyJ2...",
 *           "availabilityDays": [
 *             {
 *               "dayOffset": 0,
 *               "slots": [
 *                 { "isAvailable": false, "__typename": "UnavailableSlot" },
 *                 {
 *                   "isAvailable": true,
 *                   "timeOffsetMinutes": 0,
 *                   "slotHash": "1742889988",
 *                   "slotAvailabilityToken": "eyJ2...",
 *                   "pointsType": "Standard",
 *                   "pointsValue": 100,
 *                   "type": "Standard",           // Standard | Experience | POP
 *                   "attributes": ["default"],    // default | bar | highTop | outdoor
 *                   "__typename": "AvailableSlot"
 *                 }, …
 *               ]
 *             }
 *           ]
 *         }, …
 *       ]
 *     }
 *   }
 *
 * Key quirk: slots carry `timeOffsetMinutes` (relative to the `time`
 * sent in the request), NOT absolute times. We reconstruct absolute
 * HH:MM by adding the offset back to the base time.
 */

export interface FormattedSlot {
  restaurant_id: number;
  reservation_token: string;
  date: string;
  time: string;
  party_size: number;
  type: string;           // Standard | Experience | POP
  attributes: string[];   // default | bar | highTop | outdoor
  points: number;
  slot_hash: string;
}

interface RawAvailableSlot {
  __typename?: 'AvailableSlot';
  isAvailable: true;
  timeOffsetMinutes: number;
  slotHash?: string;
  slotAvailabilityToken?: string;
  type?: string;
  attributes?: string[];
  pointsValue?: number;
}

interface RawUnavailableSlot {
  __typename?: 'UnavailableSlot';
  isAvailable: false;
}

type RawSlot = RawAvailableSlot | RawUnavailableSlot;

interface RawAvailabilityDay {
  dayOffset?: number;
  slots?: RawSlot[];
}

interface RawRestaurantAvailability {
  restaurantId?: number;
  availabilityDays?: RawAvailabilityDay[];
}

interface RawAvailabilityResponse {
  data?: { availability?: RawRestaurantAvailability[] };
  errors?: unknown;
}

/**
 * Add a minute offset to an `HH:MM` string. Wraps past midnight by
 * splitting into the next day (caller handles that).
 */
function addOffsetMinutes(
  baseTime: string,
  offsetMinutes: number,
  baseDate: string
): { date: string; time: string } {
  const [h, m] = baseTime.split(':').map((n) => Number(n));
  const totalMinutes = (h || 0) * 60 + (m || 0) + offsetMinutes;
  const hoursOverflow = Math.floor(totalMinutes / (24 * 60));
  const wrapped = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

  // Shift date by the day-overflow.
  if (hoursOverflow === 0) return { date: baseDate, time };
  const [y, mo, d] = baseDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, mo - 1, d + hoursOverflow));
  const date = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  return { date, time };
}

export function parseAvailabilityResponse(
  raw: unknown,
  baseDate: string,
  baseTime: string,
  partySize: number
): FormattedSlot[] {
  const r = raw as RawAvailabilityResponse;
  if (r?.errors) {
    throw new Error(
      `OpenTable availability response contained errors: ${JSON.stringify(r.errors)}`
    );
  }
  const restaurants = r?.data?.availability;
  if (!Array.isArray(restaurants)) {
    throw new Error(
      'Unrecognised availability response shape — data.availability missing'
    );
  }

  const out: FormattedSlot[] = [];
  for (const rest of restaurants) {
    const restaurantId = rest.restaurantId;
    if (typeof restaurantId !== 'number') continue;
    for (const day of rest.availabilityDays ?? []) {
      for (const slot of day.slots ?? []) {
        if (!slot.isAvailable) continue;
        const available = slot as RawAvailableSlot;
        const { date, time } = addOffsetMinutes(
          baseTime,
          available.timeOffsetMinutes ?? 0,
          baseDate
        );
        out.push({
          restaurant_id: restaurantId,
          reservation_token: available.slotAvailabilityToken ?? '',
          date,
          time,
          party_size: partySize,
          type: available.type ?? 'Standard',
          attributes: available.attributes ?? [],
          points: available.pointsValue ?? 0,
          slot_hash: available.slotHash ?? '',
        });
      }
    }
  }

  // Sort by date then time.
  out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return out;
}
