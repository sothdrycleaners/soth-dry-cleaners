import { formatUGX } from '@/lib/currency';

/** Normalize Uganda (and similar) phone numbers for wa.me */
export function formatPhoneForWhatsApp(phone: string): string {
  let cleaned = phone.replace(/\D/g, '');

  if (cleaned.startsWith('0')) {
    cleaned = '256' + cleaned.substring(1);
  }

  if (!cleaned.startsWith('256') && cleaned.length <= 10) {
    cleaned = '256' + cleaned;
  }

  return cleaned;
}

export function openWhatsAppMessenger(phone: string, message: string): boolean {
  if (!phone?.trim()) return false;
  const formattedPhone = formatPhoneForWhatsApp(phone);
  if (!formattedPhone || formattedPhone.length < 10) return false;

  const whatsappUrl = `https://wa.me/${formattedPhone}?text=${encodeURIComponent(message)}`;
  window.open(whatsappUrl, '_blank');
  return true;
}

export type OrderWhatsAppPayload = {
  order_number: string;
  invoice_number?: string;
  customer_name: string;
  created_at?: string;
  subtotal: number;
  discount_percentage?: number;
  discount_amount?: number;
  bargain_amount?: number;
  surcharge_amount?: number;
  tax_rate?: number;
  tax_amount?: number;
  total_amount: number;
  amount_paid: number;
  balance: number;
  payment_status?: string;
  payment_method?: string;
  order_status?: string;
  pickup_date?: string;
  branch_name?: string;
  catalogue_kg?: number;
  catalogue_kg_rate?: number;
};

export type OrderWhatsAppItem = {
  item_name: string;
  service_type: string;
  quantity: number;
  total_price: number;
  discount_amount?: number;
  surcharge_amount?: number;
};

/** Business pay-in details shown on unpaid / partial / on-account receipts */
export type PaymentModeDetails = {
  centenary_account?: string;
  mtn_code?: string;
  airtel_merchant?: string;
};

export const DEFAULT_PAYMENT_MODES: Required<PaymentModeDetails> = {
  centenary_account: '',
  mtn_code: '',
  airtel_merchant: '',
};

/** Prefer explicitly saved branch details, then explicitly saved business details. */
export function resolvePaymentModes(
  branchModes?: PaymentModeDetails | null,
  businessModes?: PaymentModeDetails | null,
  useBusinessModes = false
): PaymentModeDetails {
  const branch = {
    centenary_account: String(branchModes?.centenary_account || '').trim(),
    mtn_code: String(branchModes?.mtn_code || '').trim(),
    airtel_merchant: String(branchModes?.airtel_merchant || '').trim(),
  };
  if (Object.values(branch).some(Boolean)) return branch;
  if (!useBusinessModes) return { ...DEFAULT_PAYMENT_MODES };
  return {
    centenary_account: String(businessModes?.centenary_account || '').trim(),
    mtn_code: String(businessModes?.mtn_code || '').trim(),
    airtel_merchant: String(businessModes?.airtel_merchant || '').trim(),
  };
}

/** Business identity from Settings → Business Information */
export type BusinessInfo = {
  name?: string;
  phone?: string;
  email?: string;
  location?: string;
  address?: string;
  branch_name?: string;
};

export const DEFAULT_BUSINESS_INFO: BusinessInfo = {
  name: 'SOTH DRY CLEANERS',
};

/** Free days to collect once an item is ready, before storage charges start */
export const COLLECTION_GRACE_DAYS = 3;

/** Months after which uncollected items are donated */
export const UNCOLLECTED_DONATION_MONTHS = 3;

export type OrderMessageKind = 'confirmation' | 'receipt' | 'invoice' | 'ready' | 'delivered';

function formatShortDate(value?: string): string {
  if (!value) return new Date().toLocaleDateString('en-UG');
  try {
    return new Date(value).toLocaleDateString('en-UG', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return value;
  }
}

function normalizedOrderStatus(order: OrderWhatsAppPayload): string {
  return String(order.order_status || '').trim().toLowerCase();
}

function isFullyPaid(order: OrderWhatsAppPayload): boolean {
  const status = String(order.payment_status || '').toUpperCase();
  return status === 'PAID' || Number(order.balance || 0) <= 0;
}

function shouldIncludePaymentModes(order: OrderWhatsAppPayload): boolean {
  if (isFullyPaid(order)) return false;
  const status = String(order.payment_status || '').toUpperCase();
  const method = String(order.payment_method || '').toUpperCase();
  return (
    status === 'UNPAID' ||
    status === 'PARTIAL' ||
    method === 'ON_ACCOUNT' ||
    Number(order.balance || 0) > 0
  );
}

/**
 * Resolves which message to produce. A caller may ask for a 'receipt' on an
 * order that is already ready or delivered — the order status wins so we never
 * tell a customer their order is ready when it is still being processed.
 */
function resolveKind(order: OrderWhatsAppPayload, requested: OrderMessageKind): OrderMessageKind {
  const status = normalizedOrderStatus(order);

  if (requested === 'ready' || requested === 'delivered') {
    // Explicit notifications must match reality
    if (status === 'delivered') return 'delivered';
    if (status === 'ready') return 'ready';
    return 'receipt';
  }

  if (requested === 'receipt') {
    if (status === 'delivered') return 'delivered';
    if (status === 'ready') return 'ready';
  }

  return requested;
}

function headerFor(kind: OrderMessageKind): string {
  switch (kind) {
    case 'confirmation':
      return '*ORDER CONFIRMATION*';
    case 'invoice':
      return '*INVOICE*';
    case 'ready':
      return '*YOUR ORDER IS READY FOR PICKUP*';
    case 'delivered':
      return '*DELIVERY CONFIRMATION*';
    default:
      return '*ORDER RECEIPT*';
  }
}

function buildItemLines(items: OrderWhatsAppItem[]): string[] {
  if (!items.length) return [];
  return [
    '*ITEMS:*',
    ...items.map((item) => `- ${item.item_name} x${item.quantity} - ${formatUGX(item.total_price)}`),
    '',
  ];
}

function buildPaymentSummaryLines(order: OrderWhatsAppPayload): string[] {
  const lines = [
    '*PAYMENT SUMMARY*',
    `Total: *${formatUGX(order.total_amount)}*`,
    `Paid: ${formatUGX(order.amount_paid)}`,
  ];
  if (Number(order.balance || 0) > 0) lines.push(`Balance due: *${formatUGX(order.balance)}*`);
  else lines.push('Payment complete.');
  if (String(order.payment_method || '').toUpperCase() === 'ON_ACCOUNT') {
    lines.push('Payment method: On Account');
  }
  return lines;
}

function buildPaymentRequestLines(
  order: OrderWhatsAppPayload,
  paymentModes?: PaymentModeDetails | null
): string[] {
  if (!shouldIncludePaymentModes(order)) return [];

  const modes = {
    centenary_account: String(paymentModes?.centenary_account || '').trim(),
    mtn_code: String(paymentModes?.mtn_code || '').trim(),
    airtel_merchant: String(paymentModes?.airtel_merchant || '').trim(),
  };
  if (!Object.values(modes).some(Boolean)) return [];
  const lines = ['', '*HOW TO PAY*'];

  if (modes.centenary_account) lines.push(`Bank account number: ${modes.centenary_account}`);
  if (modes.mtn_code) lines.push(`MTN MoMo Pay: ${modes.mtn_code}`);
  if (modes.airtel_merchant) lines.push(`Airtel Pay: ${modes.airtel_merchant}`);

  lines.push(`Kindly clear the balance of ${formatUGX(order.balance)}.`);
  return lines;
}

export function buildCollectionPolicyLines(): string[] {
  return [
    '',
    '*COLLECTION POLICY*',
    `Kindly collect your items within ${COLLECTION_GRACE_DAYS} days of this notice.`,
    'We do not have storage facilities for garments, so items held beyond',
    `${COLLECTION_GRACE_DAYS} days attract a storage charge and are kept at the owner's risk.`,
    `Items left uncollected for over ${UNCOLLECTED_DONATION_MONTHS} months are donated to charity.`,
    'Thank you for your understanding.',
  ];
}

function buildBusinessFooterLines(business?: BusinessInfo | null): string[] {
  const info = { ...DEFAULT_BUSINESS_INFO, ...(business || {}) };
  const lines: string[] = ['', '—'];

  if (info.name) lines.push(`*${info.name}*`);
  if (info.branch_name) lines.push(`Branch: ${info.branch_name}`);

  const place = [info.address, info.location].filter(Boolean).join(', ');
  if (place) lines.push(place);
  if (info.phone) lines.push(`Tel: ${info.phone}`);
  if (info.email) lines.push(`Email: ${info.email}`);

  // Nothing beyond the separator means there is no footer worth sending
  return lines.length > 2 ? lines : [];
}

/**
 * Compact payment summary for ready/delivered messages.
 * Shows only the key money figures — no per-item breakdown.
 */
function buildCompactPaymentLines(
  order: OrderWhatsAppPayload,
  paymentModes?: PaymentModeDetails | null
): string[] {
  const paid = isFullyPaid(order);
  const lines: string[] = ['*PAYMENT*'];

  lines.push(`Total charged: *${formatUGX(order.total_amount)}*`);
  if (Number(order.amount_paid || 0) > 0) {
    lines.push(`Amount paid: ${formatUGX(order.amount_paid)}`);
  }

  if (!paid && Number(order.balance || 0) > 0) {
    lines.push(`*Balance due: ${formatUGX(order.balance)}*`);

    // Show how-to-pay details so the customer can act on it immediately
    const modes = {
      centenary_account: String(paymentModes?.centenary_account || '').trim(),
      mtn_code: String(paymentModes?.mtn_code || '').trim(),
      airtel_merchant: String(paymentModes?.airtel_merchant || '').trim(),
    };
    if (Object.values(modes).some(Boolean)) {
      lines.push('');
      lines.push('*HOW TO PAY*');
      if (modes.centenary_account) lines.push(`Bank account number: ${modes.centenary_account}`);
      if (modes.mtn_code) lines.push(`MTN MoMo Pay: ${modes.mtn_code}`);
      if (modes.airtel_merchant) lines.push(`Airtel Pay: ${modes.airtel_merchant}`);
    }
    lines.push('Kindly clear the balance before collection.');
  } else {
    lines.push('Payment confirmed: *Full payment received* ✓');
  }

  return lines;
}

/**
 * Single source of truth for every customer-facing order message on WhatsApp.
 *
 * Message style by kind:
 *  confirmation / receipt — full item list + detailed payment breakdown
 *  ready / delivered      — concise (NO item list), just totals + payment modes if owing
 */
export function buildOrderWhatsAppMessage(
  order: OrderWhatsAppPayload,
  items: OrderWhatsAppItem[],
  options: {
    kind?: OrderMessageKind;
    business?: BusinessInfo | null;
    paymentModes?: PaymentModeDetails | null;
  } = {}
): string {
  const kind = resolveKind(order, options.kind || 'receipt');
  const business = { ...DEFAULT_BUSINESS_INFO, ...(options.business || {}) };
  const branchName = order.branch_name || business.branch_name;
  const paid = isFullyPaid(order);

  // Whether to include the per-item breakdown (only for confirmation / receipt)
  const showItemDetail = kind === 'confirmation' || kind === 'receipt';

  const lines: string[] = [
    `Hello *${order.customer_name}*!`,
    '',
    `*${(business.name || DEFAULT_BUSINESS_INFO.name || '').toUpperCase()}*`,
    headerFor(kind),
    '',
    `Order #: *${order.order_number}*`,
    ...(kind === 'invoice' && order.invoice_number ? [`Invoice #: *${order.invoice_number}*`] : []),
    `Date: ${formatShortDate(order.created_at)}`,
  ];

  if (branchName) lines.push(`Branch: ${branchName}`);
  if (Number(order.catalogue_kg) > 0) {
    lines.push(`Bulk laundry: ${Number(order.catalogue_kg).toFixed(2)} kg at ${formatUGX(Number(order.catalogue_kg_rate) || 0)}/kg`);
  }
  lines.push('');

  if (showItemDetail) {
    // Full receipt — item list then detailed payment breakdown
    lines.push(...buildItemLines(items));
    lines.push(...buildPaymentSummaryLines(order));
    lines.push(...buildPaymentRequestLines(order, options.paymentModes));
  } else {
    // Compact notification — no item list, just money figures + payment modes
    lines.push(...buildCompactPaymentLines(order, options.paymentModes));
  }

  lines.push('');

  switch (kind) {
    case 'confirmation':
      break;

    case 'invoice':
      if (paid) {
        lines.push('This invoice has been fully paid. Thank you for settling your order.');
      } else if (Number(order.amount_paid || 0) > 0) {
        lines.push('This invoice records your payment and the remaining balance due.');
      } else {
        lines.push('This invoice records the amount due for your order.');
      }
      break;

    case 'ready':
      lines.push('Great news — your order is ready for collection!');
      lines.push('Please check all items carefully when collecting.');
      lines.push(...buildCollectionPolicyLines());
      break;

    case 'delivered':
      lines.push('This order has been marked as delivered.');
      lines.push('We hope everything met your expectations.');
      break;

    case 'receipt':
      lines.push("We'll notify you as soon as your order is ready for pickup.");
      break;
  }

  if (kind === 'confirmation') {
    lines.push('', 'We have received your items. We will notify you when they are ready.');
  }
  lines.push('', 'Thank you for choosing Soth Dry Cleaners!');
  if (kind !== 'confirmation' && kind !== 'receipt') {
    lines.push(...buildBusinessFooterLines({ ...business, branch_name: undefined }));
  }

  return lines.join('\n');
}

/** Order confirmation for WhatsApp Messenger (sent right after creating an order) */
export function buildOrderConfirmationWhatsAppMessage(
  order: OrderWhatsAppPayload,
  items: OrderWhatsAppItem[],
  business?: BusinessInfo | string | null,
  paymentModes?: PaymentModeDetails | null
): string {
  return buildOrderWhatsAppMessage(order, items, {
    kind: 'confirmation',
    business: typeof business === 'string' ? { phone: business } : business,
    paymentModes,
  });
}

/** Receipt / follow-up message. Content follows the order's real status. */
export function buildOrderReceiptWhatsAppMessage(
  order: OrderWhatsAppPayload,
  items: OrderWhatsAppItem[],
  business?: BusinessInfo | string | null,
  paymentModes?: PaymentModeDetails | null
): string {
  return buildOrderWhatsAppMessage(order, items, {
    kind: 'receipt',
    business: typeof business === 'string' ? { phone: business } : business,
    paymentModes,
  });
}

/** Invoice message with the order's current status and payment position. */
export function buildOrderInvoiceWhatsAppMessage(
  order: OrderWhatsAppPayload,
  items: OrderWhatsAppItem[],
  business?: BusinessInfo | string | null,
  paymentModes?: PaymentModeDetails | null
): string {
  return buildOrderWhatsAppMessage(order, items, {
    kind: 'invoice',
    business: typeof business === 'string' ? { phone: business } : business,
    paymentModes,
  });
}

/** "Your order is ready" notification. Falls back to a receipt if not ready yet. */
export function buildOrderReadyWhatsAppMessage(
  order: OrderWhatsAppPayload,
  items: OrderWhatsAppItem[],
  business?: BusinessInfo | null,
  paymentModes?: PaymentModeDetails | null
): string {
  return buildOrderWhatsAppMessage(order, items, { kind: 'ready', business, paymentModes });
}
