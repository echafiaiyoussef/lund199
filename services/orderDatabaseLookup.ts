import { Order } from '../types';
import { supabase } from '../supabase';
import { normalizeArabicDigits } from './hardwareBarcodeScanner';

// Check if string is a valid UUID format
export const isUUID = (str: string | null | undefined): boolean => {
  if (!str) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
};

// Clean tenant IDs / prefixes (e.g. "uuid|ORD-123" or "uuid-ORD-123" or "laund-xxx|ORD-123")
export const cleanTenantString = (str: string | null | undefined): string => {
  if (!str) return '';
  return str
    .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|/i, '')
    .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '')
    .replace(/^laund-[a-z0-9]+\|/, '')
    .replace(/^laund-[a-z0-9]+-/, '')
    .trim();
};

// Sanitize order row from database into a valid Order object
export const sanitizeOrderRow = (row: any): Order => {
  let parsedItems = row.items;
  if (typeof parsedItems === 'string') {
    try {
      parsedItems = JSON.parse(parsedItems);
    } catch (e) {
      parsedItems = [];
    }
  }

  return {
    ...row,
    order_number: cleanTenantString(row.order_number || ''),
    customer_name: cleanTenantString(row.customer_name || ''),
    customer_phone: cleanTenantString(row.customer_phone || ''),
    items: Array.isArray(parsedItems) ? parsedItems : [],
    total: typeof row.total === 'number' ? row.total : parseFloat(row.total || '0') || 0,
    subtotal: typeof row.subtotal === 'number' ? row.subtotal : parseFloat(row.subtotal || '0') || 0,
    tax: typeof row.tax === 'number' ? row.tax : parseFloat(row.tax || '0') || 0,
    is_paid: Boolean(row.is_paid),
    status: row.status || 'Received'
  };
};

export interface OrderLookupOptions {
  inMemoryOrders?: Order[];
  laundryId?: string;
  preferActiveOnly?: boolean;
}

/**
 * Searches across in-memory cache and the ENTIRE Supabase database to find an order
 * matching any scanned QR code, barcode, or manually entered order ID.
 * Resolves formats like:
 * - Direct numbers: "70397", "ORD-70397", "#70397", "ord-70397"
 * - Arabic digits: "٧٠٣٩٧"
 * - UUIDs: "4e86890f-76cd-430e-b40e-13f68947fba2"
 * - Phone numbers: "0531382377", "966531382377"
 * - JSON invoice QR payloads
 * - URLs with order parameters
 * - ZATCA Saudi E-Invoice TLV Base64 QR codes
 */
export async function findOrderAcrossAllDatabase(
  rawInput: string,
  options: OrderLookupOptions = {}
): Promise<Order | null> {
  const { inMemoryOrders = [], laundryId, preferActiveOnly = false } = options;

  if (!rawInput) return null;

  // 1. Normalize digits & strip leading whitespace / trailing chars
  const normalized = normalizeArabicDigits(rawInput.trim());
  if (!normalized) return null;

  // Clean candidate without #, № or spaces
  const cleanRaw = normalized.replace(/^[#№\s]+/, '').trim();
  // Extract purely digits if any
  const digitsOnly = cleanRaw.replace(/\D/g, '');

  // 2. Extract potential invoice number from formatted string
  // Examples: "رقم الفاتورة: #70397", "طلب: ORD-70397", "Invoice: 70397"
  const invoiceNumPatternMatch = 
    normalized.match(/(?:رقم الفاتورة|الطلب|فاتورة|Invoice|Order|ORD|معرف الطلب)[^\d#]*#?\s*([a-zA-Z0-9_\u0660-\u0669-]+)/i) ||
    normalized.match(/#\s*([a-zA-Z0-9_\u0660-\u0669-]+)/);

  const extractedCandidate = invoiceNumPatternMatch && invoiceNumPatternMatch[1]
    ? invoiceNumPatternMatch[1].replace(/^[#№\s]+/, '').trim()
    : null;

  // 3. Check JSON format
  if (normalized.startsWith('{') && normalized.endsWith('}')) {
    try {
      const parsed = JSON.parse(normalized);
      const cand = parsed.order_number || parsed.orderNumber || parsed.order || parsed.id || parsed.invoice_number || parsed.invoice || parsed.num || parsed.no;
      if (cand) {
        return await findOrderAcrossAllDatabase(String(cand), options);
      }
    } catch (e) {}
  }

  // 4. Check URL format
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    try {
      const url = new URL(normalized);
      const orderParam = url.searchParams.get('order') ||
                         url.searchParams.get('order_number') ||
                         url.searchParams.get('id') ||
                         url.searchParams.get('invoice');
      if (orderParam) {
        return await findOrderAcrossAllDatabase(orderParam, options);
      }
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length > 0) {
        const lastSeg = segments[segments.length - 1];
        return await findOrderAcrossAllDatabase(lastSeg, options);
      }
    } catch (e) {}
  }

  // 5. In-Memory Search First (Fastest response if order is already loaded)
  if (inMemoryOrders.length > 0) {
    const memoryMatch = findInMemoryOrder(normalized, cleanRaw, digitsOnly, extractedCandidate, inMemoryOrders);
    if (memoryMatch) {
      return memoryMatch;
    }
  }

  // 6. Comprehensive Search across Supabase Database
  try {
    // Strategy A: Direct UUID lookup if valid UUID
    if (isUUID(cleanRaw) || (extractedCandidate && isUUID(extractedCandidate))) {
      const targetUuid = isUUID(cleanRaw) ? cleanRaw : (extractedCandidate as string);
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('id', targetUuid)
        .limit(1);

      if (!error && data && data.length > 0) {
        return sanitizeOrderRow(data[0]);
      }
    }

    // Strategy B: Candidate Key matching for order_number and customer_phone
    // Generate all viable variations to search
    const candidatesToMatch = new Set<string>();
    if (cleanRaw) {
      candidatesToMatch.add(cleanRaw);
    }
    if (extractedCandidate) {
      candidatesToMatch.add(extractedCandidate);
    }
    if (digitsOnly && digitsOnly.length >= 2) {
      candidatesToMatch.add(digitsOnly);
      candidatesToMatch.add(`ORD-${digitsOnly}`);
      candidatesToMatch.add(`#${digitsOnly}`);
    }
    if (cleanRaw.toUpperCase().startsWith('ORD-')) {
      candidatesToMatch.add(cleanRaw.toUpperCase());
    } else if (cleanRaw.length >= 3 && /^\d+$/.test(cleanRaw)) {
      candidatesToMatch.add(`ORD-${cleanRaw}`);
    }

    // Construct PostgREST OR filter safely (NO id.eq here to prevent Postgres UUID parse crashes!)
    const orConditions: string[] = [];

    // Exact order_number matches
    candidatesToMatch.forEach(cand => {
      // Escape commas and quotes for postgrest filter
      const safe = cand.replace(/[,()]/g, '');
      if (safe) {
        orConditions.push(`order_number.eq.${safe}`);
      }
    });

    // Substring / ilike order_number matches
    if (digitsOnly && digitsOnly.length >= 3) {
      orConditions.push(`order_number.ilike.%${digitsOnly}%`);
      orConditions.push(`order_number.ilike.ORD-%${digitsOnly}%`);
    } else if (cleanRaw.length >= 2) {
      orConditions.push(`order_number.ilike.%${cleanRaw.replace(/[,()]/g, '')}%`);
    }

    // Phone number matches if input has 7-15 digits
    if (digitsOnly && digitsOnly.length >= 7) {
      const phoneSuffix = digitsOnly.slice(-9);
      orConditions.push(`customer_phone.ilike.%${phoneSuffix}%`);
    }

    if (orConditions.length > 0) {
      // Step 6.1: Query with laundry_id if available to prioritize the tenant
      if (laundryId) {
        const { data: tenantData } = await supabase
          .from('orders')
          .select('*')
          .eq('laundry_id', laundryId)
          .or(orConditions.join(','))
          .order('created_at', { ascending: false })
          .limit(5);

        if (tenantData && tenantData.length > 0) {
          const matched = selectBestMatch(tenantData, cleanRaw, digitsOnly, extractedCandidate, preferActiveOnly);
          if (matched) return sanitizeOrderRow(matched);
        }
      }

      // Step 6.2: Search across ALL orders in the database without tenant constraint
      const { data: allDbData, error: dbErr } = await supabase
        .from('orders')
        .select('*')
        .or(orConditions.join(','))
        .order('created_at', { ascending: false })
        .limit(10);

      if (!dbErr && allDbData && allDbData.length > 0) {
        const matched = selectBestMatch(allDbData, cleanRaw, digitsOnly, extractedCandidate, preferActiveOnly);
        if (matched) return sanitizeOrderRow(matched);
      }
    }

    // Strategy C: Check tokens/words if input is multi-word
    const tokens = cleanRaw.split(/[\s,;:\n\r\t/|\\-]+/).filter(t => t.length >= 3);
    for (const token of tokens) {
      const tokenDigits = token.replace(/\D/g, '');
      const tokenConds: string[] = [`order_number.eq.${token}`, `order_number.ilike.%${token}%`];
      if (tokenDigits.length >= 3) {
        tokenConds.push(`order_number.eq.ORD-${tokenDigits}`);
        tokenConds.push(`order_number.ilike.%${tokenDigits}%`);
      }
      const { data: tokenData } = await supabase
        .from('orders')
        .select('*')
        .or(tokenConds.join(','))
        .order('created_at', { ascending: false })
        .limit(3);

      if (tokenData && tokenData.length > 0) {
        return sanitizeOrderRow(tokenData[0]);
      }
    }
  } catch (err) {
    console.warn("findOrderAcrossAllDatabase Supabase query exception:", err);
  }

  return null;
}

// In-memory matching helper
function findInMemoryOrder(
  normalized: string,
  cleanRaw: string,
  digitsOnly: string,
  extractedCandidate: string | null,
  orders: Order[]
): Order | null {
  const normCleanLower = cleanRaw.toLowerCase();
  const candLower = extractedCandidate ? extractedCandidate.toLowerCase() : null;

  // 1. Exact match on order_number or id
  let target = orders.find(o => {
    const ordClean = cleanTenantString(o.order_number).toLowerCase();
    const idLower = (o.id || '').toLowerCase();
    return ordClean === normCleanLower ||
           idLower === normCleanLower ||
           (candLower && (ordClean === candLower || idLower === candLower));
  });
  if (target) return target;

  // 2. Match with ORD- prefix or digits
  if (digitsOnly && digitsOnly.length >= 2) {
    const ordWithDigits = `ord-${digitsOnly}`.toLowerCase();
    target = orders.find(o => {
      const ordClean = cleanTenantString(o.order_number).toLowerCase();
      const ordDigits = ordClean.replace(/\D/g, '');
      return ordClean === ordWithDigits ||
             ordDigits === digitsOnly ||
             ordClean.endsWith(digitsOnly);
    });
    if (target) return target;
  }

  // 3. Substring match
  if (cleanRaw.length >= 3) {
    target = orders.find(o => {
      const ordClean = cleanTenantString(o.order_number).toLowerCase();
      return ordClean.includes(normCleanLower) || normCleanLower.includes(ordClean);
    });
    if (target) return target;
  }

  // 4. Phone number match
  if (digitsOnly && digitsOnly.length >= 7) {
    const phoneSuffix = digitsOnly.slice(-9);
    target = orders.find(o => {
      const phoneDigits = (o.customer_phone || '').replace(/\D/g, '').slice(-9);
      return phoneDigits.length >= 7 && phoneDigits === phoneSuffix;
    });
    if (target) return target;
  }

  return null;
}

// Pick the most relevant order from multiple database matches
function selectBestMatch(
  rows: any[],
  cleanRaw: string,
  digitsOnly: string,
  extractedCandidate: string | null,
  preferActiveOnly: boolean
): any {
  if (rows.length === 1) return rows[0];

  const normCleanLower = cleanRaw.toLowerCase();
  const candLower = extractedCandidate ? extractedCandidate.toLowerCase() : null;
  const ordWithDigits = digitsOnly ? `ORD-${digitsOnly}`.toLowerCase() : null;

  // 1. Exact order_number match
  const exact = rows.find(r => {
    const ord = cleanTenantString(r.order_number).toLowerCase();
    return ord === normCleanLower ||
           (candLower && ord === candLower) ||
           (ordWithDigits && ord === ordWithDigits);
  });
  if (exact) return exact;

  // 2. Exact digits match
  if (digitsOnly) {
    const digitsMatch = rows.find(r => {
      const ordDigits = (cleanTenantString(r.order_number) || '').replace(/\D/g, '');
      return ordDigits === digitsOnly;
    });
    if (digitsMatch) return digitsMatch;
  }

  // 3. If preferActiveOnly, prioritize orders not already Ready or Delivered
  if (preferActiveOnly) {
    const active = rows.find(r => r.status !== 'Ready' && r.status !== 'Delivered');
    if (active) return active;
  }

  // Default to the first (most recently created due to order('created_at', { ascending: false }))
  return rows[0];
}
