/**
 * Parse OpenTable's `/booking/details` SSR page state for the
 * pieces the MCP cares about: the CC-required flag, cancellation
 * policy, and the user's default saved card.
 *
 * The input is the `__INITIAL_STATE__` object (or its `state` key —
 * we accept both) captured from the booking-details page. Field
 * paths verified against live captures on 2026-04-22; see
 * `docs/superpowers/specs/2026-04-21-cc-required-booking-design.md`
 * → "Investigation results" for provenance.
 */

export type CancellationPolicyType = 'none' | 'no_show_fee' | 'late_cancel_fee';
export type CardPolicyType = 'none' | 'hold' | 'deposit';

export interface CancellationPolicy {
  type: CancellationPolicyType;
  amount_usd: number | null;
  per_person: boolean;
  free_cancel_days: number | null;
  description: string;
  raw_text: string;
}

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expiry_month: number | null;
  expiry_year: number | null;
  is_default: boolean;
}

export interface BookingDetailsSummary {
  cc_required: boolean;
  policy_type: CardPolicyType;
  policy: CancellationPolicy;
  default_card: SavedCard | null;
}

interface RawTimeSlot {
  creditCardRequired?: boolean;
  creditCardPolicyType?: string | null;
  creditCardPolicyId?: string | null;
}

interface RawCard {
  cardId?: string;
  last4?: string;
  type?: string;
  default?: boolean;
  expiryMonth?: number;
  expiryYear?: number;
  active?: boolean;
  expired?: boolean;
}

interface RawWallet {
  savedCards?: RawCard[];
  selectedPaymentCardId?: string | null;
}

interface RawMessage {
  message?: string;
}

interface RawCancellationPolicyMessage {
  cancellationMessage?: RawMessage;
  depositMessage?: RawMessage | null;
}

interface RawMessages {
  cancellationPolicyMessage?: RawCancellationPolicyMessage | null;
  creditCardDayMessage?: Array<RawMessage> | null;
}

interface RawFeatures {
  creditCardCancellationDayLimit?: number | null;
}

interface RawRestaurant {
  features?: RawFeatures;
}

interface RawBookingDetailsState {
  // Some captures live at `state.xxx`, some at top level. Accept both.
  state?: RawBookingDetailsState;
  timeSlot?: RawTimeSlot;
  messages?: RawMessages;
  restaurant?: RawRestaurant;
  wallet?: RawWallet;
}

function normalisePolicyType(t: string | null | undefined): CardPolicyType {
  const s = (t ?? '').toLowerCase();
  if (s === 'hold') return 'hold';
  if (s === 'deposit') return 'deposit';
  return 'none';
}

/**
 * Best-effort: pull the dollar figure out of a cancellation-policy message.
 * Returns { amount, perPerson }. The message is free text, so we look for
 * `$NN` (or `$NN.NN`) and check whether "per person" / "per guest" appears
 * in the same message.
 */
function extractFeeFromText(
  msg: string
): { amount: number | null; perPerson: boolean } {
  if (!msg) return { amount: null, perPerson: false };
  const money = msg.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
  const amount = money ? Number(money[1]) : null;
  const perPerson = /per\s+(person|guest|diner)/i.test(msg);
  return { amount, perPerson };
}

export function parseBookingDetailsState(raw: unknown): BookingDetailsSummary {
  const r = (raw as RawBookingDetailsState) ?? {};
  const root = r.state ?? r;
  const ts = root.timeSlot ?? {};
  const messages = root.messages ?? {};
  const wallet = root.wallet ?? {};
  const features = root.restaurant?.features ?? {};

  const ccRequired = ts.creditCardRequired === true;
  const policyType = normalisePolicyType(ts.creditCardPolicyType);

  const rawMessage =
    messages.cancellationPolicyMessage?.cancellationMessage?.message ??
    messages.creditCardDayMessage?.[0]?.message ??
    '';

  const { amount, perPerson } = extractFeeFromText(rawMessage);

  const policy: CancellationPolicy = ccRequired
    ? {
        // v1 always maps a hold to no_show_fee. `late_cancel_fee` reserved for
        // future variants where the verbatim text distinguishes the two.
        type: 'no_show_fee',
        amount_usd: amount,
        per_person: perPerson,
        free_cancel_days: features.creditCardCancellationDayLimit ?? null,
        description: rawMessage,
        raw_text: rawMessage,
      }
    : {
        type: 'none',
        amount_usd: null,
        per_person: false,
        free_cancel_days: null,
        description: 'No cancellation policy — book freely.',
        raw_text: '',
      };

  const cards = wallet.savedCards ?? [];
  let defaultCard: SavedCard | null = null;
  if (cards.length > 0) {
    let chosen: RawCard | undefined;
    const selectedId = wallet.selectedPaymentCardId ?? null;
    if (selectedId) chosen = cards.find((c) => c.cardId === selectedId);
    if (!chosen) chosen = cards.find((c) => c.default === true);
    if (!chosen) chosen = cards[0];
    if (chosen?.cardId && chosen.last4 && chosen.type) {
      defaultCard = {
        id: chosen.cardId,
        brand: chosen.type,
        last4: chosen.last4,
        expiry_month: chosen.expiryMonth ?? null,
        expiry_year: chosen.expiryYear ?? null,
        is_default: chosen.default === true,
      };
    }
  }

  return {
    cc_required: ccRequired,
    policy_type: policyType,
    policy,
    default_card: defaultCard,
  };
}
